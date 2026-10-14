'use strict';
const fs = require('fs');
const path = require('path');
const { resolveScope, describeScope } = require('./scope');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_ROWS_PER_CHUNK = 10000;
const MAX_STATEMENT_BYTES = 900 * 1024; // keep every INSERT under max_allowed_packet defaults

function cancelled(signal) {
  if (signal && signal.aborted) {
    const e = new Error('cancelled');
    e.cancelled = true;
    throw e;
  }
}

function openDump(cfg, kind, name) {
  const dir = path.join(cfg.dumpDir, cfg.master.database);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${kind === 'tables' ? '' : kind + '.'}${name}.sql`);
  const stream = fs.createWriteStream(file, { encoding: 'utf8' });
  const write = (s) => new Promise((res, rej) => stream.write(s, (e) => (e ? rej(e) : res())));
  const close = () => new Promise((res) => stream.end(res));
  return { file, write, close };
}

function buildInserts(driver, table, fields, rows) {
  const head = `INSERT INTO ${driver.quote(table)} (${fields.map(driver.quote).join(', ')}) VALUES\n`;
  const stmts = [];
  let cur = [];
  let size = head.length;
  for (const row of rows) {
    const tuple = '(' + fields.map((f) => driver.escape(row[f])).join(', ') + ')';
    if (cur.length && size + tuple.length > MAX_STATEMENT_BYTES) {
      stmts.push(head + cur.join(',\n') + ';');
      cur = [];
      size = head.length;
    }
    cur.push(tuple);
    size += tuple.length + 2;
  }
  if (cur.length) stmts.push(head + cur.join(',\n') + ';');
  return stmts;
}

/**
 * Copy a keyed table with up to cfg.concurrency chunks in flight. Chunk boundaries are found one at a time
 * (cheap index-only query, serialised), then each worker downloads its key range from the master and
 * inserts it on its own slave connection. Mutates `prog`.
 */
async function copyKeyedParallel({ driver, master, slave, cfg, name, pk, select, where, perChunk, chunks, conn, dump, prog, onProgress, signal, retarget }) {
  const esc = driver.quote;
  const keyCols = pk.map(esc).join(', ');
  const tuple = `(${keyCols})`;
  const ph = `(${pk.map(() => '?').join(', ')})`;
  let last = null;
  let exhausted = false;
  let failed = false;
  let lock = Promise.resolve();

  const nextRange = () => {
    const run = lock.then(async () => {
      if (exhausted || failed) return null;
      const conds = [];
      const params = [];
      if (where) { conds.push(where.sql); params.push(...where.params); }
      if (last) { conds.push(`${tuple} > ${ph}`); params.push(...pk.map((c) => last[c])); }
      const [r] = await master.query(
        `SELECT ${keyCols} FROM ${esc(name)}${conds.length ? ' WHERE ' + conds.join(' AND ') : ''} ORDER BY ${keyCols} LIMIT 1 OFFSET ${perChunk - 1}`, params);
      const range = { from: last, to: r.length ? r[0] : null };
      if (r.length) last = r[0]; else exhausted = true;
      return range;
    });
    lock = run.catch(() => {});
    return run;
  };

  const work = async (wconn) => {
    try {
      for (;;) {
        cancelled(signal);
        const range = await nextRange();
        if (!range) return;
        const conds = [];
        const params = [];
        if (where) { conds.push(where.sql); params.push(...where.params); }
        if (range.from) { conds.push(`${tuple} > ${ph}`); params.push(...pk.map((c) => range.from[c])); }
        if (range.to) { conds.push(`${tuple} <= ${ph}`); params.push(...pk.map((c) => range.to[c])); }
        const sql = `SELECT ${select} FROM ${esc(name)}${conds.length ? ' WHERE ' + conds.join(' AND ') : ''} ORDER BY ${keyCols}`;
        const [rows, fieldsMeta] = await master.query(sql, params);
        prog.chunk++;
        if (rows.length) {
          const fields = fieldsMeta.map((f) => f.name);
          for (const stmt of buildInserts(driver, name, fields, rows)) {
            cancelled(signal);
            await dump.write(stmt + '\n');
            await wconn.query(stmt);
            prog.bytesDone += Buffer.byteLength(stmt);
          }
          prog.rowsDone += rows.length;
        }
        onProgress({ ...prog });
        if (cfg.chunkDelayMs) await sleep(cfg.chunkDelayMs); // let the master breathe
      }
    } catch (e) {
      failed = true;
      throw e;
    }
  };

  const extra = [];
  try {
    const workers = Math.min(cfg.concurrency, chunks);
    const tasks = [work(conn)];
    for (let i = 1; i < workers; i++) {
      tasks.push((async () => {
        const c = await slave.getConnection();
        extra.push(c);
        await driver.sessionSetup(c);
        return work(c);
      })());
    }
    const results = await Promise.allSettled(tasks);
    const bad = results.find((r) => r.status === 'rejected');
    if (bad) throw bad.reason;
  } finally {
    for (const c of extra) {
      try { await driver.sessionTeardown(c); } catch (_) { /* ignore */ }
      c.release();
    }
  }
}

async function copyTable(ctx, item, onProgress, signal) {
  const { master, slave, cfg, driver } = ctx;
  const esc = driver.quote;
  const name = item.name;
  const info = item.master;
  // Resolve the config rules first: if one cannot be applied safely we must fail before the dump file
  // is truncated or anything on the slave is dropped.
  const scope = await resolveScope(ctx, name);
  const dump = openDump(cfg, 'tables', name);
  const conn = await slave.getConnection();
  const started = Date.now();
  // Swap mode: load into a temp table and RENAME it over the old one, so the slave never lacks the table.
  // Not possible with foreign keys (constraint names are per-database), and pointless for schema-only tables.
  let swap = false; // decided inside the try below so a failed lookup still releases the connection
  const fresh = `${name}__sqlcpy_new`;
  const old = `${name}__sqlcpy_old`;
  // the dump keeps the real table name; only the statement sent to the slave is pointed at the temp table
  const retarget = (stmt) => (swap ? stmt.replace(`INSERT INTO ${esc(name)} `, () => `INSERT INTO ${esc(fresh)} `) : stmt);
  try {
    swap = Boolean(ctx.swap && item.slave && scope.mode !== 'schema' && !(await driver.hasForeignKeys(slave, cfg.slave.database, name)));
    onProgress({ phase: 'schema', rowsDone: 0, rowsTotal: 0, bytesDone: 0, chunk: 0, chunks: 0, started });
    const ddl = driver.normalizeSql(await driver.getCreateSql(master, 'tables', name), cfg.master.database);
    const drop = driver.dropSql('tables', name);
    const note = describeScope(scope);
    await dump.write(`-- sqlcpy dump of ${cfg.master.database}.${name} @ ${new Date().toISOString()}\n` +
      (scope.mode === 'full' ? '' : `-- scope: ${note}\n`) +
      `${driver.dumpPreamble}${drop};\n${ddl};\n\n`);

    await driver.sessionSetup(conn);
    if (swap) {
      await conn.query(driver.dropSql('tables', fresh));
      await conn.query(ddl.replace(esc(name), () => esc(fresh)));
    } else {
      await conn.query(drop);
      await conn.query(ddl);
    }

    if (scope.mode === 'schema') { // sensitive table: structure only, no row is ever read from the master
      onProgress({ phase: 'done', rowsDone: 0, rowsTotal: 0, bytesDone: 0, chunk: 0, chunks: 0, started });
      return { file: dump.file, rows: 0, bytes: 0, note };
    }

    const where = scope.where || null;
    const select = scope.select || '*';
    const total = await driver.count(master, name, where);
    const avg = Math.max(info.avgRowLength || 0, 1);
    const smallTable = (scope.range ? total * avg : info.dataBytes) <= cfg.chunkBytes;
    const perChunk = smallTable ? Math.max(total, 1) : Math.min(MAX_ROWS_PER_CHUNK, Math.max(1, Math.floor(cfg.chunkBytes / avg)));
    const chunks = Math.max(1, Math.ceil(total / perChunk));
    const pk = await driver.primaryKey(master, cfg.master.database, name);
    const order = pk.length ? [...(scope.orderLead || []), ...pk] : []; // range column first, so its index drives paging

    const prog = { phase: 'data', rowsDone: 0, rowsTotal: total, bytesDone: 0, chunk: 0, chunks, started, perChunk, keyed: pk.length > 0 };
    onProgress({ ...prog });

    const parallel = pk.length > 0 && cfg.concurrency > 1 && chunks > 1;
    if (parallel) {
      await copyKeyedParallel({ driver, master, slave, cfg, name, pk: order, select, where, perChunk, chunks, conn, dump, prog, onProgress, signal, retarget });
    }

    let last = null;
    let offset = 0;
    while (!parallel && (prog.rowsDone < total || (total === 0 && prog.chunk === 0))) {
      cancelled(signal);
      let sql = `SELECT ${select} FROM ${esc(name)}`;
      const params = [];
      const conds = [];
      if (where) { conds.push(where.sql); params.push(...where.params); }
      if (order.length && last) {
        conds.push(`(${order.map(esc).join(', ')}) > (${order.map(() => '?').join(', ')})`);
        params.push(...order.map((c) => last[c]));
      }
      if (conds.length) sql += ` WHERE ${conds.join(' AND ')}`;
      if (order.length) sql += ` ORDER BY ${order.map(esc).join(', ')} LIMIT ${perChunk}`;
      else sql += ` LIMIT ${perChunk} OFFSET ${offset}`;
      const [rows, fieldsMeta] = await master.query(sql, params);
      prog.chunk++;
      if (!rows.length) break;
      const fields = fieldsMeta.map((f) => f.name);
      for (const stmt of buildInserts(driver, name, fields, rows)) {
        cancelled(signal);
        await dump.write(stmt + '\n');
        await conn.query(stmt);
        prog.bytesDone += Buffer.byteLength(stmt);
      }
      prog.rowsDone += rows.length;
      last = rows[rows.length - 1];
      offset += rows.length;
      onProgress({ ...prog });
      if (rows.length < perChunk) break;
      if (cfg.chunkDelayMs) await sleep(cfg.chunkDelayMs); // let the master breathe
    }
    if (swap) {
      await conn.query(driver.dropSql('tables', old));
      await conn.query(driver.swapSql(name, fresh, old));
      await conn.query(driver.dropSql('tables', old));
    }
    onProgress({ ...prog, phase: 'done', chunks: prog.chunk });
    return { file: dump.file, rows: prog.rowsDone, bytes: prog.bytesDone, note: scope.mode === 'full' ? undefined : note };
  } catch (e) {
    if (swap) { try { await conn.query(driver.dropSql('tables', fresh)); } catch (_) { /* best effort */ } }
    throw e;
  } finally {
    try { await driver.sessionTeardown(conn); } catch (_) { /* ignore */ }
    conn.release();
    await dump.close();
  }
}

async function copyDefinition(ctx, kind, item, onProgress) {
  const { master, slave, cfg, driver } = ctx;
  const started = Date.now();
  onProgress({ phase: 'schema', rowsDone: 0, rowsTotal: 1, bytesDone: 0, chunk: 0, chunks: 1, started });
  const sql = driver.normalizeSql(await driver.getCreateSql(master, kind, item.name), cfg.master.database);
  const dump = openDump(cfg, kind, item.name);
  try {
    const drop = driver.dropSql(kind, item.name);
    await dump.write(`-- sqlcpy ${kind} ${item.name}\n${drop};\n${sql};\n`);
    await slave.query(drop);
    await slave.query(sql);
  } finally {
    await dump.close();
  }
  onProgress({ phase: 'done', rowsDone: 1, rowsTotal: 1, bytesDone: Buffer.byteLength(sql), chunk: 1, chunks: 1, started });
  return { file: dump.file, rows: 1, bytes: Buffer.byteLength(sql) };
}

function copyObject(ctx, kind, item, onProgress = () => {}, signal) {
  return kind === 'tables' ? copyTable(ctx, item, onProgress, signal) : copyDefinition(ctx, kind, item, onProgress);
}

module.exports = { copyObject };
