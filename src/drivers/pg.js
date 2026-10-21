'use strict';
const { Pool } = require('pg');
const { createMaskProblem } = require('./maskcheck');

/**
 * PostgreSQL driver (12+). Implements the contract documented at the top of mysql.js, plus the optional hooks
 *   supportsSwap, insertModifier, selectList(pool, db, table), afterLoad(conn, table).
 *
 * How it differs from MySQL, and what that means here:
 *  - There is no SHOW CREATE: tables, views, routines and triggers are rebuilt from pg_catalog (no pg_dump needed).
 *  - A "database" holds schemas; objects live in `<side>_SCHEMA` (default public). Each connection gets
 *    search_path = that schema, so every statement uses bare names and master / slave schemas may differ.
 *  - Triggers are per table and routines can be overloaded, so their item names are
 *    `table.trigger` and `name(identity arguments)`.
 *  - Values travel as text (no JS type conversion) so every type round-trips exactly through INSERT literals.
 *  - Session settings that change how values print (time zone, float digits ...) are pinned on every connection,
 *    so master and slave checksums compare like with like.
 *  - Foreign keys cannot be switched off per session; `session_replication_role = replica` (needs superuser or a
 *    GRANT SET) is used during loads, and dropping a table temporarily detaches the foreign keys that point at it.
 */

const KINDS = ['types', 'sequences', 'tables', 'views', 'procedures', 'functions', 'triggers'];
const MIN_VERSION = 120000;

const quote = (id) => '"' + String(id).replace(/"/g, '""') + '"';
const lit = (s) => "'" + String(s).replace(/'/g, "''") + "'"; // standard_conforming_strings is pinned on

/** Literal for an INSERT statement. Rows arrive as text (or null), so the string branch does nearly all the work. */
function escape(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : lit(String(v));
  if (typeof v === 'bigint') return v.toString();
  if (Buffer.isBuffer(v)) return lit('\\x' + v.toString('hex'));
  if (v instanceof Date) return lit(v.toISOString());
  return lit(v);
}

/**
 * The generic code writes `?` placeholders (MySQL style); pg wants $1, $2 ... Quoted strings / identifiers are
 * skipped. SQL that already uses $n (this file's own queries) has no `?` and passes through untouched.
 */
function toPg(sql, params) {
  if (!params || !params.length) return sql;
  let out = '';
  let n = 0;
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) { j += 2; continue; }
          break;
        }
        j++;
      }
      out += sql.slice(i, j + 1);
      i = j + 1;
    } else if (ch === '?') {
      out += '$' + (++n);
      i++;
    } else {
      out += ch;
      i++;
    }
  }
  if (n === 0) return sql;
  if (n !== params.length) throw new Error(`internal: ${n} placeholder(s) but ${params.length} parameter(s) in: ${sql}`);
  return out;
}

// Every value stays as the server printed it, so any type round-trips exactly through an INSERT literal.
// Booleans are the exception: 'f' would be truthy in JS, and escape() writes a real boolean back as TRUE / FALSE.
const BOOL_OID = 16;
const RAW_TYPES = { getTypeParser: (oid) => (oid === BOOL_OID ? (v) => v === 't' : (v) => v) };

/** Settings pinned per connection: they decide how values print, and master and slave must agree. */
const sessionSql = (schema) => [
  `SET search_path TO ${quote(schema)}`,
  "SET TimeZone TO 'UTC'",
  "SET DateStyle TO 'ISO, MDY'",
  "SET IntervalStyle TO 'postgres'",
  'SET extra_float_digits TO 3',
  "SET bytea_output TO 'hex'",
  'SET standard_conforming_strings TO on',
  "SET application_name TO 'sqlcpy'",
].join('; ');

function sslOption(v) {
  const s = String(v || '').trim().toLowerCase();
  if (!s || ['false', '0', 'no', 'off', 'disable'].includes(s)) return false;
  if (['no-verify', 'allow-self-signed'].includes(s)) return { rejectUnauthorized: false };
  return {}; // true / require / 1: encrypted and verified
}

async function run(client, sql, params) {
  const res = await client.query(toPg(sql, params), params && params.length ? params : undefined);
  const last = Array.isArray(res) ? res[res.length - 1] : res; // a multi-statement string yields one result each
  return [last.rows, last.fields];
}

/** A pool shaped like mysql2's: query() -> [rows, fields], getConnection() -> { query, release }, end(). */
function createPool(c, concurrency = 1) {
  const schema = c.schema || 'public';
  const pool = new Pool({
    host: c.host,
    port: c.port,
    user: c.user,
    password: c.password,
    database: c.database,
    ssl: sslOption(c.ssl),
    max: Math.max(3, concurrency + 1), // one per chunk worker, plus a spare for lookups
    connectionTimeoutMillis: 10000,
    types: RAW_TYPES,
  });
  pool.on('error', () => { /* an idle client was dropped; the next checkout opens a fresh one */ });

  const checkout = async () => {
    const client = await pool.connect();
    try {
      if (!client.sqlcpyReady) {
        await client.query(sessionSql(schema));
        client.sqlcpyReady = true;
      }
    } catch (e) {
      client.release(true);
      throw e;
    }
    return client;
  };

  return {
    schema,
    async query(sql, params) {
      const client = await checkout();
      try { return await run(client, sql, params); } finally { client.release(); }
    },
    async getConnection() {
      const client = await checkout();
      return { schema, query: (sql, params) => run(client, sql, params), release: () => client.release() };
    },
    end: () => pool.end(),
  };
}

// ---------------------------------------------------------------- listing

const NOT_EXTENSION = (cls, alias) => `NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = '${cls}'::regclass AND d.objid = ${alias}.oid AND d.deptype = 'e')`;

async function verify(pool) {
  if (pool.verified) return;
  const [v] = await pool.query("SELECT current_setting('server_version_num')::int AS num, current_setting('server_version') AS text");
  if (Number(v[0].num) < MIN_VERSION) throw new Error(`PostgreSQL ${v[0].text} is not supported – version 12 or newer is required`);
  const [s] = await pool.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [pool.schema]);
  if (!s.length) throw new Error(`Schema "${pool.schema}" does not exist in this database. Check *_SCHEMA in .env (default: public).`);
  pool.verified = true;
}

async function listObjects(pool) {
  await verify(pool);
  const out = { types: [], sequences: [], tables: [], views: [], procedures: [], functions: [], triggers: [] };

  // Enums, domains, ranges and standalone composites. Array / multirange types and the row type of a table are implicit.
  const [ty] = await pool.query(
    `SELECT t.typname AS name FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = $1 AND ${NOT_EXTENSION('pg_type', 't')}
        AND (t.typtype IN ('e', 'd', 'r') OR (t.typtype = 'c' AND EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = t.typrelid AND c.relkind = 'c')))
      ORDER BY 1`, [pool.schema]);
  for (const x of ty) out.types.push({ name: x.name });

  // Sequences that belong to a serial / identity column are re-created with their table; only free-standing ones are items.
  const [sq] = await pool.query(
    `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind = 'S' AND ${NOT_EXTENSION('pg_class', 'c')}
        AND NOT EXISTS (SELECT 1 FROM pg_depend o WHERE o.classid = 'pg_class'::regclass AND o.objid = c.oid AND o.deptype IN ('a', 'i'))
      ORDER BY 1`, [pool.schema]);
  for (const x of sq) out.sequences.push({ name: x.name });

  // Partitions are listed through their parent (whose definition includes them); extension-owned objects are not ours.
  const [t] = await pool.query(
    `SELECT c.relname AS name, c.relkind AS kind,
            CASE WHEN c.relkind = 'p' THEN (SELECT COALESCE(SUM(GREATEST(l.reltuples, st.n_live_tup, 0)), 0) FROM pg_partition_tree(c.oid) p
                                              JOIN pg_class l ON l.oid = p.relid LEFT JOIN pg_stat_all_tables st ON st.relid = l.oid WHERE p.isleaf)
                 ELSE GREATEST(c.reltuples, s.n_live_tup, 0) END AS rows,
            CASE WHEN c.relkind = 'p' THEN (SELECT COALESCE(SUM(pg_table_size(p.relid)), 0) FROM pg_partition_tree(c.oid) p WHERE p.isleaf)
                 WHEN c.relkind = 'r' THEN pg_table_size(c.oid) ELSE 0 END AS data,
            CASE WHEN c.relkind IN ('r', 'p') THEN pg_indexes_size(c.oid) ELSE 0 END AS idx
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace LEFT JOIN pg_stat_all_tables s ON s.relid = c.oid
      WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v') AND NOT c.relispartition AND ${NOT_EXTENSION('pg_class', 'c')}
      ORDER BY c.relname`, [pool.schema]);
  for (const r of t) {
    let rows = Math.round(Number(r.rows || 0));
    const data = Number(r.data || 0);
    let avg = rows > 0 ? Math.floor(data / rows) : 0;
    // Neither ANALYZE nor the stats collector knows this table yet (just loaded, or stats reset): measure a sample,
    // otherwise the chunk size would ignore how wide the rows are.
    if (r.kind !== 'v' && rows === 0 && data > 0) {
      try {
        const [w] = await pool.query(`SELECT COALESCE(avg(pg_column_size(x.*)), 0) AS w FROM (SELECT * FROM ${quote(r.name)} LIMIT 100) x`);
        const width = Math.ceil(Number(w[0].w));
        if (width > 0) { avg = width; rows = Math.floor(data / width); }
      } catch (e) { /* best effort: the estimate only sizes chunks */ }
    }
    const o = { name: r.name, approxRows: rows, bytes: data + Number(r.idx || 0), dataBytes: data, avgRowLength: avg };
    (r.kind === 'v' ? out.views : out.tables).push(o);
  }

  const [f] = await pool.query(
    `SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS name, p.prokind AS kind
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = $1 AND p.prokind IN ('f', 'p') AND ${NOT_EXTENSION('pg_proc', 'p')}
        AND NOT EXISTS (SELECT 1 FROM pg_depend o WHERE o.classid = 'pg_proc'::regclass AND o.objid = p.oid AND o.deptype = 'i') -- a range type's constructors come with the type
      ORDER BY 1`, [pool.schema]);
  for (const x of f) (x.kind === 'p' ? out.procedures : out.functions).push({ name: x.name });

  const [g] = await pool.query(
    `SELECT c.relname || '.' || t.tgname AS name, c.relname AS tbl
       FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND NOT t.tgisinternal AND NOT c.relispartition
      ORDER BY 1`, [pool.schema]);
  for (const x of g) out.triggers.push({ name: x.name, table: x.tbl });

  return out;
}

// ---------------------------------------------------------------- definitions

const missing = (kind, name, why = '') => new Error(`No definition returned for ${kind} ${name}${why || ' (does it exist, and may this user read it?)'}`);

/**
 * ALTER TABLE ... ADD FOREIGN KEY as a statement that never fails: it is skipped (with a warning) when the child or
 * the referenced table is not on the slave yet, or when the constraint is already there. Added NOT VALID because a
 * partial copy (range, schema-only or masked table) can legitimately leave child rows without a parent.
 */
function guardedForeignKey(child, name, def) {
  const rel = lit(quote(child));
  return `DO $sqlcpy$
BEGIN
  IF to_regclass(${rel}) IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass(${rel}) AND conname = ${lit(name)}) THEN
    EXECUTE ${lit(`ALTER TABLE ${quote(child)} ADD CONSTRAINT ${quote(name)} ${def.replace(/ NOT VALID$/, '')} NOT VALID`)};
  END IF;
EXCEPTION WHEN others THEN
  RAISE WARNING 'sqlcpy: foreign key % on % skipped: %', ${lit(name)}, ${lit(child)}, SQLERRM;
END
$sqlcpy$`;
}

/**
 * CREATE statements for one table plus its partitions, indexes and comments, joined by ";\n" (the caller adds the last ";").
 * forCopy: foreign keys are not part of CREATE TABLE but follow it as guarded ALTERs, so two tables that reference each
 * other (or a parent that is copied later) can be copied in any order. The keys of other tables that point at this one
 * are re-added too, since they cannot exist on the slave while this table is missing. The definition used for comparing
 * keeps the keys inline.
 */
async function tableSql(pool, name, forCopy = false) {
  const [rel] = await pool.query(
    `SELECT c.oid, c.relpersistence AS persistence, array_to_string(c.reloptions, ', ') AS options,
            CASE WHEN c.relkind = 'p' THEN pg_get_partkeydef(c.oid) END AS partkey,
            obj_description(c.oid, 'pg_class') AS comment
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r', 'p')`, [pool.schema, name]);
  if (!rel.length) throw missing('tables', name);
  const t = rel[0];

  const [cols] = await pool.query(
    `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS notnull,
            a.attgenerated AS generated, a.attidentity AS identity,
            CASE WHEN a.atthasdef THEN pg_get_expr(d.adbin, d.adrelid) END AS def,
            (a.attidentity = '' AND a.atthasdef AND pg_get_expr(d.adbin, d.adrelid) LIKE 'nextval(%'
              AND pg_get_serial_sequence(quote_ident($2) || '.' || quote_ident($3), a.attname) IS NOT NULL) AS serial,
            CASE WHEN a.attcollation <> 0 AND a.attcollation <> ty.typcollation THEN
              (SELECT quote_ident(cn.nspname) || '.' || quote_ident(co.collname) FROM pg_collation co JOIN pg_namespace cn ON cn.oid = co.collnamespace WHERE co.oid = a.attcollation) END AS collation,
            col_description(a.attrelid, a.attnum) AS comment
       FROM pg_attribute a JOIN pg_type ty ON ty.oid = a.atttypid
            LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`, [t.oid, pool.schema, name]);

  const SERIAL = { smallint: 'smallserial', integer: 'serial', bigint: 'bigserial' };
  const lines = cols.map((c) => {
    let s = `${quote(c.name)} `;
    if (c.serial && SERIAL[c.type]) s += SERIAL[c.type]; // owned sequence: re-created with the column
    else s += c.type;
    if (c.collation) s += ` COLLATE ${c.collation}`;
    if (c.identity) s += ` GENERATED ${c.identity === 'a' ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY`;
    else if (c.generated) s += ` GENERATED ALWAYS AS (${c.def})${c.generated === 's' ? ' STORED' : ' VIRTUAL'}`;
    else if (c.def != null && !(c.serial && SERIAL[c.type])) s += ` DEFAULT ${c.def}`;
    if (c.notnull) s += ' NOT NULL';
    return s;
  });

  // Local constraints only: constraints a partition inherits arrive with PARTITION OF.
  const [cons] = await pool.query(
    `SELECT conname AS name, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = $1 AND contype IN ('p', 'u', 'c', 'x', 'f') AND conislocal
      ORDER BY CASE contype WHEN 'p' THEN 0 WHEN 'u' THEN 1 WHEN 'c' THEN 2 WHEN 'x' THEN 3 ELSE 4 END, conname`, [t.oid]);
  const deferred = [];
  for (const k of cons) {
    if (forCopy && /^FOREIGN KEY/.test(k.def)) deferred.push(guardedForeignKey(name, k.name, k.def));
    else lines.push(`CONSTRAINT ${quote(k.name)} ${k.def.replace(/ NOT VALID$/, '')}`); // validity is not part of the definition
  }

  const stmts = [
    `CREATE ${t.persistence === 'u' ? 'UNLOGGED ' : ''}TABLE ${quote(name)} (${lines.length ? '\n  ' + lines.join(',\n  ') + '\n' : ''})` +
      `${t.partkey ? ` PARTITION BY ${t.partkey}` : ''}${t.options ? ` WITH (${t.options})` : ''}`,
  ];
  if (t.partkey) await partitionsSql(pool, t.oid, name, stmts);
  stmts.push(...deferred);
  if (forCopy) {
    const [inbound] = await pool.query(
      `SELECT k.conname AS name, cl.relname AS child, pg_get_constraintdef(k.oid) AS def
         FROM pg_constraint k JOIN pg_class cl ON cl.oid = k.conrelid JOIN pg_namespace cn ON cn.oid = cl.relnamespace
        WHERE k.contype = 'f' AND k.confrelid = $1 AND k.conrelid <> k.confrelid AND k.conparentid = 0 AND cn.nspname = $2
        ORDER BY cl.relname, k.conname`, [t.oid, pool.schema]);
    for (const k of inbound) stmts.push(guardedForeignKey(k.child, k.name, k.def));
  }

  // Indexes that do not back a constraint (those are part of the constraint), minus the schema qualifier pg prints.
  const [idx] = await pool.query(
    `SELECT replace(replace(pg_get_indexdef(i.indexrelid), ' ON ONLY ' || quote_ident($2) || '.', ' ON ONLY '), ' ON ' || quote_ident($2) || '.', ' ON ') AS def
       FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid
      WHERE i.indrelid = $1
        AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = i.indexrelid AND k.conrelid = i.indrelid AND k.contype IN ('p', 'u', 'x'))
      ORDER BY ic.relname`, [t.oid, pool.schema]);
  for (const i of idx) stmts.push(i.def);

  if (t.comment != null) stmts.push(`COMMENT ON TABLE ${quote(name)} IS ${lit(t.comment)}`);
  for (const c of cols) if (c.comment != null) stmts.push(`COMMENT ON COLUMN ${quote(name)}.${quote(c.name)} IS ${lit(c.comment)}`);
  return stmts.join(';\n');
}

async function partitionsSql(pool, parentOid, parentName, stmts) {
  const [parts] = await pool.query(
    `SELECT c.oid, c.relname AS name, pg_get_expr(c.relpartbound, c.oid) AS bound,
            CASE WHEN c.relkind = 'p' THEN pg_get_partkeydef(c.oid) END AS partkey
       FROM pg_inherits h JOIN pg_class c ON c.oid = h.inhrelid
      WHERE h.inhparent = $1 ORDER BY c.relname`, [parentOid]);
  for (const p of parts) {
    stmts.push(`CREATE TABLE ${quote(p.name)} PARTITION OF ${quote(parentName)} ${p.bound}${p.partkey ? ` PARTITION BY ${p.partkey}` : ''}`);
    if (p.partkey) await partitionsSql(pool, p.oid, p.name, stmts);
  }
}

async function viewSql(pool, name) {
  const [r] = await pool.query(
    `SELECT pg_get_viewdef(c.oid, true) AS def, array_to_string(c.reloptions, ', ') AS options
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = 'v'`, [pool.schema, name]);
  if (!r.length) throw missing('views', name);
  return `CREATE VIEW ${quote(name)}${r[0].options ? ` WITH (${r[0].options})` : ''} AS\n${r[0].def.trim().replace(/;$/, '')}`;
}

async function routineSql(pool, kind, name) {
  const [r] = await pool.query(
    `SELECT pg_get_functiondef(p.oid) AS def, quote_ident(n.nspname) AS schema
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = $1 AND p.prokind = $3
        AND p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' = $2`,
    [pool.schema, name, kind === 'procedures' ? 'p' : 'f']);
  if (!r.length) throw missing(kind, name);
  // pg always prints the schema in the header; drop it so the definition applies to whichever schema the slave uses
  const header = new RegExp(`^(CREATE OR REPLACE (?:FUNCTION|PROCEDURE) )${r[0].schema.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.`);
  return r[0].def.trim().replace(header, '$1');
}

async function triggerSql(pool, name) {
  const [r] = await pool.query(
    `SELECT pg_get_triggerdef(t.oid, true) AS def
       FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname || '.' || t.tgname = $2 AND NOT t.tgisinternal`, [pool.schema, name]);
  if (!r.length) throw missing('triggers', name);
  return r[0].def;
}

const COLLATION_OF = (col, base) => `CASE WHEN ${col} <> 0 AND ${col} <> ${base} THEN
  (SELECT quote_ident(cn.nspname) || '.' || quote_ident(co.collname) FROM pg_collation co JOIN pg_namespace cn ON cn.oid = co.collnamespace WHERE co.oid = ${col}) END`;

/**
 * CREATE statement for an enum, domain, composite or range type.
 * forCopy (enums only): a block that creates the type, or adds the labels the slave lacks to an existing one. An enum
 * in use cannot be dropped, so this is how a new label reaches a slave whose tables already use the type.
 */
async function typeSql(pool, name, forCopy = false) {
  const [r] = await pool.query(
    `SELECT t.oid, t.typtype AS kind, t.typrelid AS relid, format_type(t.typbasetype, t.typtypmod) AS base, t.typnotnull AS notnull,
            pg_get_expr(t.typdefaultbin, 0) AS def, ${COLLATION_OF('t.typcollation', 'COALESCE(bt.typcollation, 0)')} AS collation
       FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace LEFT JOIN pg_type bt ON bt.oid = t.typbasetype
      WHERE n.nspname = $1 AND t.typname = $2 AND t.typtype IN ('e', 'd', 'c', 'r')`, [pool.schema, name]);
  if (!r.length) throw missing('types', name);
  const t = r[0];

  if (t.kind === 'e') {
    const [labels] = await pool.query('SELECT enumlabel AS l FROM pg_enum WHERE enumtypid = $1 ORDER BY enumsortorder', [t.oid]);
    const list = labels.map((x) => x.l);
    const create = `CREATE TYPE ${quote(name)} AS ENUM (${list.map(lit).join(', ')})`;
    if (!forCopy) return create;
    const present = (l) => `EXISTS (SELECT 1 FROM pg_enum WHERE enumtypid = to_regtype(${lit(quote(name))}) AND enumlabel = ${lit(l)})`;
    const adds = list.map((l, i) => {
      const where = i > 0 ? `AFTER ${lit(list[i - 1])}` : list.length > 1 ? `BEFORE ${lit(list[1])}` : '';
      return `    IF NOT ${present(l)} THEN EXECUTE ${lit(`ALTER TYPE ${quote(name)} ADD VALUE ${lit(l)} ${where}`.trim())}; END IF;`;
    });
    return `DO $sqlcpy$
BEGIN
  IF to_regtype(${lit(quote(name))}) IS NULL THEN
    EXECUTE ${lit(create)};
  ELSE
${adds.join('\n')}
  END IF;
END
$sqlcpy$`;
  }

  if (t.kind === 'd') {
    const [cons] = await pool.query(
      "SELECT conname AS name, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE contypid = $1 AND contype = 'c' ORDER BY conname", [t.oid]);
    return `CREATE DOMAIN ${quote(name)} AS ${t.base}` +
      (t.collation ? ` COLLATE ${t.collation}` : '') +
      (t.def != null ? ` DEFAULT ${t.def}` : '') +
      (t.notnull ? ' NOT NULL' : '') +
      cons.map((k) => ` CONSTRAINT ${quote(k.name)} ${k.def.replace(/ NOT VALID$/, '')}`).join('');
  }

  if (t.kind === 'c') {
    const [attrs] = await pool.query(
      `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, ${COLLATION_OF('a.attcollation', 'ty.typcollation')} AS collation
         FROM pg_attribute a JOIN pg_type ty ON ty.oid = a.atttypid
        WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`, [t.relid]);
    return `CREATE TYPE ${quote(name)} AS (${attrs.map((a) => `${quote(a.name)} ${a.type}${a.collation ? ` COLLATE ${a.collation}` : ''}`).join(', ')})`;
  }

  const [rng] = await pool.query(
    `SELECT format_type(g.rngsubtype, NULL) AS sub, ${COLLATION_OF('g.rngcollation', 'st.typcollation')} AS collation,
            CASE WHEN g.rngsubdiff <> 0 THEN g.rngsubdiff::regproc::text END AS diff
       FROM pg_range g JOIN pg_type st ON st.oid = g.rngsubtype WHERE g.rngtypid = $1`, [t.oid]);
  const g = rng[0];
  const opts = [`SUBTYPE = ${g.sub}`];
  if (g.collation) opts.push(`COLLATION = ${g.collation}`);
  if (g.diff) opts.push(`SUBTYPE_DIFF = ${g.diff}`);
  return `CREATE TYPE ${quote(name)} AS RANGE (${opts.join(', ')})`;
}

/**
 * CREATE statement for a free-standing sequence. forCopy: a block that creates it or aligns an existing one (a sequence
 * a column default uses cannot be dropped), followed by setval so the slave carries on from the master's position.
 * The position is not part of the compared definition, so a sequence that merely advanced still counts as in sync.
 */
async function sequenceSql(pool, name, forCopy = false) {
  const [r] = await pool.query(
    `SELECT data_type::text AS type, start_value, min_value, max_value, increment_by, cycle, cache_size, last_value
       FROM pg_sequences WHERE schemaname = $1 AND sequencename = $2`, [pool.schema, name]);
  if (!r.length) throw missing('sequences', name);
  const s = r[0];
  const opts = `AS ${s.type} INCREMENT BY ${s.increment_by} MINVALUE ${s.min_value} MAXVALUE ${s.max_value} START WITH ${s.start_value} CACHE ${s.cache_size} ${s.cycle ? 'CYCLE' : 'NO CYCLE'}`;
  const create = `CREATE SEQUENCE ${quote(name)} ${opts}`;
  if (!forCopy) return create;
  const stmts = [`DO $sqlcpy$
BEGIN
  IF to_regclass(${lit(quote(name))}) IS NULL THEN
    EXECUTE ${lit(create)};
  ELSE
    EXECUTE ${lit(`ALTER SEQUENCE ${quote(name)} ${opts}`)};
  END IF;
END
$sqlcpy$`];
  if (s.last_value != null) stmts.push(`SELECT setval(${lit(quote(name))}, ${s.last_value}, true)`); // last_value is null until first use
  return stmts.join(';\n');
}

async function getCreateSql(pool, kind, name, forCopy = false) {
  if (kind === 'types') return typeSql(pool, name, forCopy);
  if (kind === 'sequences') return sequenceSql(pool, name, forCopy);
  if (kind === 'tables') return tableSql(pool, name, forCopy);
  if (kind === 'views') return viewSql(pool, name);
  if (kind === 'triggers') return triggerSql(pool, name);
  return routineSql(pool, kind, name);
}

/** Qualifiers are already stripped in getCreateSql (it knows the schema); only line endings / padding remain. */
function normalizeSql(sql) {
  return sql.replace(/\r\n/g, '\n').trim();
}

// ---------------------------------------------------------------- keys, columns, counts

const regclass = '(SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2)';

async function primaryKey(pool, db, table) {
  const [r] = await pool.query(
    `SELECT a.attname AS c FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
      WHERE i.indrelid = ${regclass} AND i.indisprimary
      ORDER BY array_position(i.indkey::int2[], a.attnum)`, [pool.schema, table]);
  return r.map((x) => x.c);
}

async function hasForeignKeys(pool, db, table) {
  const [r] = await pool.query(
    `SELECT COUNT(*) AS c FROM pg_constraint WHERE contype = 'f' AND (conrelid = ${regclass} OR confrelid = ${regclass})`, [pool.schema, table]);
  return Number(r[0].c) > 0;
}

const whereOf = (where) => (where ? ` WHERE ${where.sql}` : '');

async function count(pool, table, where) {
  const [r] = await pool.query(`SELECT COUNT(*) AS c FROM ${quote(table)}${whereOf(where)}`, where ? where.params : []);
  return Number(r[0].c);
}

/**
 * Order-independent digest of some columns of some rows. Each value is length-prefixed so ('a,b','c') and
 * ('a','b,c') differ; the 60-bit md5 slices are added (not XORed) so duplicate rows still count.
 */
async function digest(pool, table, columns, where) {
  if (!columns.length) return '0';
  const parts = columns.map((c) => `COALESCE(length(${quote(c)}::text) || ':' || ${quote(c)}::text, '~')`);
  const [r] = await pool.query(
    `SELECT COALESCE(SUM(('x' || substr(md5(concat_ws('|', ${parts.join(', ')})), 1, 15))::bit(60)::bigint), 0) AS h
       FROM ${quote(table)}${whereOf(where)}`, where ? where.params : []);
  return String(r[0].h);
}

/** Postgres has no CHECKSUM TABLE: digest every column. Only runs once the definitions are known to match. */
async function checksum(pool, table) {
  const [cols] = await pool.query(
    `SELECT a.attname AS c FROM pg_attribute a WHERE a.attrelid = ${regclass} AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`, [pool.schema, table]);
  return digest(pool, table, cols.map((x) => x.c));
}

/** Columns a row copy can write: generated columns are computed by the server and cannot be inserted. */
async function columns(pool, db, table) {
  const [r] = await pool.query(
    `SELECT a.attname AS name, format_type(a.atttypid, NULL) AS type, NOT a.attnotnull AS nullable,
            CASE WHEN t.typname IN ('varchar', 'bpchar') AND a.atttypmod > 4 THEN a.atttypmod - 4 END AS "maxLen"
       FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
      WHERE a.attrelid = ${regclass} AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = ''
      ORDER BY a.attnum`, [pool.schema, table]);
  return r.map((x) => ({
    name: x.name,
    type: String(x.type).toLowerCase(),
    nullable: Boolean(x.nullable),
    maxLen: x.maxLen == null ? null : Number(x.maxLen),
  }));
}

/** SELECT list for an unscoped copy (the writable columns, in order). */
async function selectList(pool, db, table) {
  const cols = await columns(pool, db, table);
  return cols.length ? cols.map((c) => quote(c.name)).join(', ') : null;
}

/** Lower-cased names of columns that lead at least one full index (so a range / order on them is cheap). */
async function indexedColumns(pool, db, table) {
  const [r] = await pool.query(
    `SELECT DISTINCT a.attname AS c FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
      WHERE i.indrelid = ${regclass} AND i.indisvalid AND i.indpred IS NULL`, [pool.schema, table]);
  return new Set(r.map((x) => x.c.toLowerCase()));
}

// ---------------------------------------------------------------- masking & ranges

const TEXT_TYPES = new Set(['character', 'character varying', 'text', 'citext']);
const STRING_TYPES = new Set([...TEXT_TYPES, 'bytea']);
const NUMBER_TYPES = new Set(['smallint', 'integer', 'bigint', 'numeric', 'real', 'double precision']);
const TIME_TYPES = new Set(['date', 'timestamp without time zone', 'timestamp with time zone']);

const isTemporal = (col) => TIME_TYPES.has(col.type);
const maskProblem = createMaskProblem({ stringTypes: STRING_TYPES, textTypes: TEXT_TYPES, numberTypes: NUMBER_TYPES, timeTypes: TIME_TYPES });

/** SQL expression that stands in for a sensitive column in the SELECT, so the real value never leaves the master. */
function maskExpr(col, mode, salt) {
  if (mode && typeof mode === 'object' && mode.when) {
    const { when, ...rest } = mode;
    const list = when.values.map((v) => escape(v)).join(', ');
    return `CASE WHEN ${quote(when.column)} IN (${list}) THEN ${maskExpr(col, rest, salt)} ELSE ${quote(col.name)} END`;
  }
  if (mode && typeof mode === 'object' && Array.isArray(mode.replace)) {
    return mode.replace.reduce((expr, [a, b]) => `REPLACE(${expr}, ${lit(a)}, ${lit(b)})`, `${quote(col.name)}::text`);
  }
  if (mode && typeof mode === 'object' && Object.prototype.hasOwnProperty.call(mode, 'value')) return escape(mode.value);
  if (mode && typeof mode === 'object' && typeof mode.from === 'string') return quote(mode.from);
  if (mode && typeof mode === 'object' && Array.isArray(mode.concat)) {
    // || (not concat()) so a NULL part gives NULL, as MySQL's CONCAT does
    const parts = mode.concat.map((part) => (typeof part === 'string' ? lit(part) : quote(part.column)));
    const joined = `(${parts.join(' || ')})::text`;
    return mode.maxLength != null ? `LEFT(${joined}, ${Number(mode.maxLength)})` : joined;
  }
  if (mode === 'random') {
    if (NUMBER_TYPES.has(col.type)) return 'FLOOR(RANDOM() * 10)';
    return `LEFT(MD5(RANDOM()::text), ${Math.min(col.maxLen || 32, 32)})`;
  }
  if (mode === 'null') return 'NULL';
  if (mode === 'empty') return NUMBER_TYPES.has(col.type) ? '0' : "''";
  const len = Math.min(col.maxLen || 64, 64);
  return `LEFT(ENCODE(SHA256(CONVERT_TO(${lit(salt)} || ${quote(col.name)}::text, 'UTF8')), 'hex'), ${len})`;
}

/**
 * Cut-off for a range, evaluated once on the master so both sides compare against the identical instant.
 * Returns 'YYYY-MM-DD HH:MM:SS' in UTC (the session time zone is pinned to UTC on every connection).
 */
async function cutoff(pool, range) {
  if (range.since) return range.since;
  const interval = `${Number(range.amount)} ${String(range.unit).toLowerCase()}`;
  const [r] = await pool.query(`SELECT to_char(now() - ${lit(interval)}::interval, 'YYYY-MM-DD HH24:MI:SS') AS c`);
  return String(r[0].c);
}

// ---------------------------------------------------------------- safety & writes

/** Throws if the connected user could change data in the schema (the master must never be written to). */
async function assertReadOnly(pool) {
  const [r] = await pool.query(
    `SELECT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS super,
            (SELECT string_agg(DISTINCT p, ',') FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                    CROSS JOIN unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p
                   WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') AND has_table_privilege(c.oid, p)) AS privs`, [pool.schema]);
  const bad = new Set(r[0].privs ? r[0].privs.split(',') : []);
  if (r[0].super) bad.add('SUPERUSER');
  if (bad.size) {
    const err = new Error(`master user must be read-only, but it holds: ${[...bad].join(', ')}`);
    err.code = 'NOT_READ_ONLY';
    err.privileges = [...bad];
    throw err;
  }
}

/**
 * DROP statement. Dropping a table first detaches what would block it (foreign keys from other tables, views built
 * on it, even through other views) and parks their definitions in a session temp table; afterLoad puts them back.
 * Without that no referenced table could be refreshed. There is no CASCADE: anything else that depends on the
 * object (a materialized view, a column of its row type ...) still blocks the drop and is reported, not lost.
 */
function dropSql(kind, name) {
  if (kind === 'views') return `DROP VIEW IF EXISTS ${quote(name)}`;
  if (kind === 'types') { // enums are brought up to date in place (see typeSql); the others are dropped and re-created
    return `DO $sqlcpy$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE oid = to_regtype(${lit(quote(name))}) AND typtype = 'e') THEN RETURN; END IF;
  DROP TYPE IF EXISTS ${quote(name)};
END
$sqlcpy$`;
  }
  if (kind === 'sequences') { // one a column default still uses stays and is aligned in place (see sequenceSql)
    return `DO $sqlcpy$
BEGIN
  DROP SEQUENCE IF EXISTS ${quote(name)};
EXCEPTION WHEN dependent_objects_still_exist THEN NULL;
END
$sqlcpy$`;
  }
  if (kind === 'triggers') {
    const dot = name.lastIndexOf('.');
    return `DROP TRIGGER IF EXISTS ${quote(name.slice(dot + 1))} ON ${quote(name.slice(0, dot))}`;
  }
  if (kind === 'functions' || kind === 'procedures') {
    const paren = name.indexOf('(');
    return `DROP ${kind === 'procedures' ? 'PROCEDURE' : 'FUNCTION'} IF EXISTS ${quote(name.slice(0, paren))}${name.slice(paren)}`;
  }
  const rel = lit(quote(name));
  const key = lit(name);
  return `DO $sqlcpy$
DECLARE r record;
BEGIN
  IF to_regclass(${rel}) IS NOT NULL THEN
    CREATE TEMP TABLE IF NOT EXISTS sqlcpy_fk (parent text, child_schema text, child text, name text, def text);
    CREATE TEMP TABLE IF NOT EXISTS sqlcpy_view (parent text, depth int, schema text, name text, def text, opts text);
    DELETE FROM pg_temp.sqlcpy_fk WHERE parent = ${key};
    DELETE FROM pg_temp.sqlcpy_view WHERE parent = ${key};
    FOR r IN SELECT k.conname, cl.relname, cn.nspname, pg_get_constraintdef(k.oid) AS def
               FROM pg_constraint k JOIN pg_class cl ON cl.oid = k.conrelid JOIN pg_namespace cn ON cn.oid = cl.relnamespace
              WHERE k.contype = 'f' AND k.confrelid = to_regclass(${rel}) AND k.conrelid <> k.confrelid AND k.conparentid = 0
    LOOP
      INSERT INTO pg_temp.sqlcpy_fk VALUES (${key}, r.nspname, r.relname, r.conname, regexp_replace(r.def, ' NOT VALID$', ''));
      EXECUTE format('ALTER TABLE %I.%I DROP CONSTRAINT %I', r.nspname, r.relname, r.conname);
    END LOOP;
    -- plain views built on this table, directly or through other views; deepest first so each drop is clean
    FOR r IN WITH RECURSIVE dep(oid, depth) AS (
               SELECT DISTINCT w.ev_class, 1 FROM pg_depend d JOIN pg_rewrite w ON w.oid = d.objid
                WHERE d.classid = 'pg_rewrite'::regclass AND d.refobjid = to_regclass(${rel}) AND w.ev_class <> d.refobjid
               UNION
               SELECT w.ev_class, dep.depth + 1 FROM dep JOIN pg_depend d ON d.refobjid = dep.oid AND d.classid = 'pg_rewrite'::regclass
                 JOIN pg_rewrite w ON w.oid = d.objid WHERE w.ev_class <> dep.oid)
             SELECT c.relname, n.nspname, MAX(dep.depth) AS depth, pg_get_viewdef(c.oid, true) AS def, array_to_string(c.reloptions, ', ') AS opts
               FROM dep JOIN pg_class c ON c.oid = dep.oid JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE c.relkind = 'v' GROUP BY c.oid, c.relname, n.nspname, c.reloptions ORDER BY MAX(dep.depth) DESC
    LOOP
      INSERT INTO pg_temp.sqlcpy_view VALUES (${key}, r.depth, r.nspname, r.relname, regexp_replace(r.def, ';\s*$', ''), COALESCE(r.opts, ''));
      EXECUTE format('DROP VIEW %I.%I', r.nspname, r.relname);
    END LOOP;
  END IF;
  DROP TABLE IF EXISTS ${quote(name)};
END
$sqlcpy$`;
}

/**
 * Run on the slave connection after a table has been (re)created and loaded:
 *  - move serial / identity sequences past the loaded rows (MySQL does this itself for AUTO_INCREMENT);
 *  - put back the views and foreign keys that dropSql detached. Foreign keys come back NOT VALID: a partial copy
 *    (range, schema-only or masked parent) can legitimately leave child rows without a parent. A view or key that
 *    cannot be restored (the new table no longer fits it) is skipped with a warning rather than failing the copy;
 *    the next compare then reports it as missing / different.
 */
async function afterLoad(conn, table) {
  const [seqs] = await conn.query(
    `SELECT a.attname AS col, pg_get_serial_sequence(quote_ident($1) || '.' || quote_ident($2), a.attname) AS seq
       FROM pg_attribute a
      WHERE a.attrelid = (SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2)
        AND a.attnum > 0 AND NOT a.attisdropped`, [conn.schema, table]);
  for (const s of seqs) {
    if (!s.seq) continue;
    await conn.query(`SELECT setval(${lit(s.seq)}, COALESCE((SELECT MAX(${quote(s.col)}) FROM ${quote(table)}), 0) + 1, false)`);
  }
  await conn.query(`DO $sqlcpy$
DECLARE r record;
BEGIN
  IF to_regclass('pg_temp.sqlcpy_view') IS NOT NULL THEN
    FOR r IN SELECT * FROM pg_temp.sqlcpy_view WHERE parent = ${lit(table)} ORDER BY depth LOOP
      BEGIN
        EXECUTE format('CREATE VIEW %I.%I %s AS %s', r.schema, r.name, CASE WHEN r.opts <> '' THEN 'WITH (' || r.opts || ')' ELSE '' END, r.def);
      EXCEPTION WHEN others THEN
        RAISE WARNING 'sqlcpy: could not restore view % : %', r.name, SQLERRM;
      END;
    END LOOP;
    DELETE FROM pg_temp.sqlcpy_view WHERE parent = ${lit(table)};
  END IF;
  IF to_regclass('pg_temp.sqlcpy_fk') IS NOT NULL THEN
    FOR r IN SELECT * FROM pg_temp.sqlcpy_fk WHERE parent = ${lit(table)} LOOP
      BEGIN
        -- the copy's own DDL may have re-added it already
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass(format('%I.%I', r.child_schema, r.child)) AND conname = r.name) THEN
          EXECUTE format('ALTER TABLE %I.%I ADD CONSTRAINT %I %s NOT VALID', r.child_schema, r.child, r.name, r.def);
        END IF;
      EXCEPTION WHEN others THEN
        RAISE WARNING 'sqlcpy: could not restore foreign key % on % : %', r.name, r.child, SQLERRM;
      END;
    END LOOP;
    DELETE FROM pg_temp.sqlcpy_fk WHERE parent = ${lit(table)};
  END IF;
END
$sqlcpy$`);
}

module.exports = {
  name: 'postgres',
  versionLabel: (v) => String(v).split(' ').slice(0, 2).join(' '), // "PostgreSQL 17.11 on x86_64 ..." -> "PostgreSQL 17.11"
  readOnlyGrants: (c) => [
    "CREATE ROLE backup_user LOGIN PASSWORD 'change_me';",
    `GRANT CONNECT ON DATABASE ${quote(c.database)} TO backup_user;`,
    `GRANT USAGE ON SCHEMA ${quote(c.schema || 'public')} TO backup_user;`,
    `GRANT SELECT ON ALL TABLES IN SCHEMA ${quote(c.schema || 'public')} TO backup_user;`,
  ],
  defaultPort: 5432,
  kinds: KINDS,
  supportsSwap: false, // index / constraint names are schema-wide, so a temp copy cannot be built beside the original
  insertModifier: ' OVERRIDING SYSTEM VALUE', // lets GENERATED ALWAYS identity columns take the master's values
  createPool,
  quote,
  escape,
  toPg,
  listObjects,
  getCreateSql,
  normalizeSql,
  primaryKey,
  count,
  checksum,
  digest,
  columns,
  selectList,
  indexedColumns,
  isTemporal,
  maskProblem,
  maskExpr,
  cutoff,
  hasForeignKeys,
  assertReadOnly,
  afterLoad,
  swapSql: () => { throw new Error('atomic swap is not supported on PostgreSQL'); },
  // Foreign keys cannot be disabled per session; replica mode skips their triggers. Needs superuser / GRANT SET:
  // without it the load still runs and a missing parent row surfaces as an ordinary FK error.
  async sessionSetup(conn) {
    try { await conn.query("SET session_replication_role = 'replica'"); } catch (e) { /* not permitted */ }
  },
  async sessionTeardown(conn) {
    try { await conn.query('RESET session_replication_role'); } catch (e) { /* never set */ }
  },
  dumpPreamble: "SET standard_conforming_strings = on;\nSET session_replication_role = 'replica';\n",
  dropSql,
};
