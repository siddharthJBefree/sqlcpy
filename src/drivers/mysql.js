'use strict';
const mysql = require('mysql2/promise');
const SqlString = require('sqlstring');

/**
 * Database driver: everything engine-specific lives here, so the copy / compare logic stays generic.
 * A driver exports:
 *   name, defaultPort
 *   kinds                              object kinds this engine supports (subset of tables|views|procedures|functions|triggers)
 *   createPool(cfg, concurrency)       -> { query(sql, params) -> [rows, fields], getConnection(), end() }
 *   quote(identifier), escape(value)   identifier quoting / literal escaping
 *   listObjects(pool, db)              -> { tables: [], views: [], ... }
 *   getCreateSql(pool, kind, name)     raw CREATE statement
 *   normalizeSql(sql, db)              make definitions from two databases comparable
 *   primaryKey(pool, db, table)        -> [column, ...]
 *   count(pool, table, where?), checksum(pool, table)       where = { sql, params }
 *   digest(pool, table, columns, where?)                    order-independent hash of chosen columns / rows
 *   columns(pool, db, table)           -> [{ name, type, nullable, maxLen }]
 *   indexedColumns(pool, db, table)    -> Set of lower-cased columns that lead an index
 *   isTemporal(col)                    can this column define a latest-rows range?
 *   maskProblem(col, mode), maskExpr(col, mode, salt)       sensitive-column replacement, done inside the SELECT
 *   cutoff(pool, range)                range start, evaluated on the master
 *   sessionSetup(conn), sessionTeardown(conn)   relax / restore constraint checks on a slave connection
 *   dumpPreamble                       statements written at the top of a table dump
 *   dropSql(kind, name)
 *   hasForeignKeys(pool, db, table)    does the table have, or is it referenced by, a foreign key? (blocks a rename swap)
 *   swapSql(table, fresh, old)         one atomic statement: table -> old, fresh -> table
 */

const KINDS = ['tables', 'views', 'procedures', 'functions', 'triggers'];
const quote = (id) => SqlString.escapeId(id);

function createPool(c, concurrency = 1) {
  return mysql.createPool({
    host: c.host,
    port: c.port,
    user: c.user,
    password: c.password,
    database: c.database,
    connectionLimit: Math.max(3, concurrency + 1), // one per chunk worker, plus a spare for lookups
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    charset: 'utf8mb4',
    typeCast(field, next) {
      if (field.type === 'JSON') return field.string();
      return next();
    },
  });
}

async function listObjects(pool, db) {
  const out = { tables: [], views: [], procedures: [], functions: [], triggers: [] };

  const [t] = await pool.query(
    `SELECT TABLE_NAME AS name, TABLE_TYPE AS type, TABLE_ROWS AS approxRows, DATA_LENGTH AS dataLength,
            INDEX_LENGTH AS indexLength, AVG_ROW_LENGTH AS avgRowLength
       FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`, [db]);
  for (const r of t) {
    const o = {
      name: r.name,
      approxRows: Number(r.approxRows || 0),
      bytes: Number(r.dataLength || 0) + Number(r.indexLength || 0),
      dataBytes: Number(r.dataLength || 0),
      avgRowLength: Number(r.avgRowLength || 0),
    };
    (r.type === 'VIEW' ? out.views : out.tables).push(o);
  }

  const [r] = await pool.query(
    `SELECT ROUTINE_NAME AS name, ROUTINE_TYPE AS type FROM information_schema.ROUTINES
      WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_NAME`, [db]);
  for (const x of r) (x.type === 'PROCEDURE' ? out.procedures : out.functions).push({ name: x.name });

  const [g] = await pool.query(
    `SELECT TRIGGER_NAME AS name, EVENT_OBJECT_TABLE AS tbl FROM information_schema.TRIGGERS
      WHERE TRIGGER_SCHEMA = ? ORDER BY TRIGGER_NAME`, [db]);
  for (const x of g) out.triggers.push({ name: x.name, table: x.tbl });

  return out;
}

async function getCreateSql(pool, kind, name) {
  const spec = {
    tables: ['TABLE', 'Create Table'],
    views: ['TABLE', 'Create View'],
    procedures: ['PROCEDURE', 'Create Procedure'],
    functions: ['FUNCTION', 'Create Function'],
    triggers: ['TRIGGER', 'SQL Original Statement'],
  }[kind];
  const [rows] = await pool.query(`SHOW CREATE ${spec[0]} ${quote(name)}`);
  const sql = rows[0] && rows[0][spec[1]];
  if (!sql) throw new Error(`No definition returned for ${kind} ${name} (insufficient privileges?)`);
  return sql;
}

const DEFINER_RE = /\s*DEFINER\s*=\s*(`[^`]*`|'[^']*'|[^@\s]+)@(`[^`]*`|'[^']*'|[^\s]+)/i;

/** Strip DEFINER, db qualifiers and AUTO_INCREMENT so definitions from two DBs are comparable / portable. */
function normalizeSql(sql, db) {
  let s = sql.replace(DEFINER_RE, '');
  s = s.split('`' + db + '`.').join('');
  s = s.replace(/\sAUTO_INCREMENT=\d+/i, '');
  return s.replace(/\r\n/g, '\n').trim();
}

async function primaryKey(pool, db, table) {
  const [r] = await pool.query(
    `SELECT COLUMN_NAME AS c FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY' ORDER BY ORDINAL_POSITION`,
    [db, table]);
  return r.map((x) => x.c);
}

async function hasForeignKeys(pool, db, table) {
  const [r] = await pool.query(
    `SELECT COUNT(*) AS c FROM information_schema.REFERENTIAL_CONSTRAINTS
      WHERE CONSTRAINT_SCHEMA = ? AND (TABLE_NAME = ? OR REFERENCED_TABLE_NAME = ?)`,
    [db, table, table]);
  return Number(r[0].c) > 0;
}

const whereOf = (where) => (where ? ` WHERE ${where.sql}` : '');

/** where = optional { sql, params } restricting the rows counted. */
async function count(pool, table, where) {
  const [r] = await pool.query(`SELECT COUNT(*) AS c FROM ${quote(table)}${whereOf(where)}`, where ? where.params : []);
  return Number(r[0].c);
}

async function checksum(pool, table) {
  const [r] = await pool.query(`CHECKSUM TABLE ${quote(table)}`);
  return String(r[0].Checksum);
}

/**
 * Order-independent digest of some columns of some rows (CHECKSUM TABLE cannot do either).
 * Every value is length-prefixed so ('a,b','c') and ('a','b,c') differ; SUM is used rather than XOR so
 * duplicate rows still count.
 */
async function digest(pool, table, columns, where) {
  if (!columns.length) return '0';
  const parts = columns.map((c) => `IFNULL(CONCAT(LENGTH(${quote(c)}), ':', CAST(${quote(c)} AS BINARY)), '~')`);
  const [r] = await pool.query(
    `SELECT SUM(CAST(CONV(LEFT(MD5(CONCAT_WS('|', ${parts.join(', ')})), 15), 16, 10) AS UNSIGNED)) AS h
       FROM ${quote(table)}${whereOf(where)}`, where ? where.params : []);
  return String(r[0].h == null ? 0 : r[0].h);
}

async function columns(pool, db, table) {
  const [r] = await pool.query(
    `SELECT COLUMN_NAME AS name, DATA_TYPE AS type, IS_NULLABLE AS nullable, CHARACTER_MAXIMUM_LENGTH AS maxLen
       FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`, [db, table]);
  return r.map((x) => ({
    name: x.name,
    type: String(x.type).toLowerCase(),
    nullable: x.nullable === 'YES',
    maxLen: x.maxLen == null ? null : Number(x.maxLen),
  }));
}

/** Lower-cased names of columns that lead at least one index (so a range / order on them is cheap). */
async function indexedColumns(pool, db, table) {
  const [r] = await pool.query(
    `SELECT DISTINCT COLUMN_NAME AS c FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND SEQ_IN_INDEX = 1`, [db, table]);
  return new Set(r.map((x) => x.c.toLowerCase()));
}

const STRING_TYPES = new Set(['char', 'varchar', 'tinytext', 'text', 'mediumtext', 'longtext', 'binary', 'varbinary', 'tinyblob', 'blob', 'mediumblob', 'longblob']);
const TEXT_TYPES = new Set(['char', 'varchar', 'tinytext', 'text', 'mediumtext', 'longtext']);
const NUMBER_TYPES = new Set(['tinyint', 'smallint', 'mediumint', 'int', 'integer', 'bigint', 'decimal', 'numeric', 'float', 'double']);
const TIME_TYPES = new Set(['date', 'datetime', 'timestamp']);
const HASH_MIN_LENGTH = 16; // shorter hex strings collide too easily to keep unique indexes valid

const isTemporal = (col) => TIME_TYPES.has(col.type);
const maskCategory = (col) => (
  STRING_TYPES.has(col.type) ? 'string'
    : NUMBER_TYPES.has(col.type) ? 'number'
      : TIME_TYPES.has(col.type) ? 'temporal' : null
);

/** Why `mode` cannot be applied to `col` on this engine, or null if it can. */
function maskProblem(col, mode, columns) {
  if (mode && typeof mode === 'object' && Object.prototype.hasOwnProperty.call(mode, 'value')) {
    const value = mode.value;
    if (value === null) return col.nullable ? null : 'is NOT NULL, so a null custom value would fail the insert';
    const category = maskCategory(col);
    if (typeof value === 'string' && (category === 'string' || category === 'temporal')) {
      if (col.maxLen != null && value.length > col.maxLen) return `has length ${col.maxLen}, shorter than the custom value`;
      return null;
    }
    if (typeof value === 'number' && Number.isFinite(value) && category === 'number') return null;
    if (typeof value === 'boolean' && category === 'number') return null;
    return `type ${col.type} is incompatible with the custom value`;
  }
  if (mode && typeof mode === 'object' && typeof mode.from === 'string') {
    const source = columns.get(mode.from.toLowerCase());
    if (!source) return `source column "${mode.from}" does not exist`;
    const targetCategory = maskCategory(col);
    if (!targetCategory || targetCategory !== maskCategory(source)) {
      return `cannot derive from "${source.name}" (${source.type}) because it is not compatible with ${col.type}`;
    }
    if (!col.nullable && source.nullable) return `cannot derive from nullable column "${source.name}" because this column is NOT NULL`;
    if (col.maxLen != null && source.maxLen != null && source.maxLen > col.maxLen) {
      return `cannot derive from "${source.name}" because its maximum length (${source.maxLen}) exceeds ${col.maxLen}`;
    }
    return null;
  }
  if (mode && typeof mode === 'object' && Array.isArray(mode.concat)) {
    if (!TEXT_TYPES.has(col.type)) return `"concat" needs a text column (is ${col.type})`;
    let length = 0;
    for (const part of mode.concat) {
      if (typeof part === 'string') {
        length += part.length;
        continue;
      }
      const source = columns.get(part.column.toLowerCase());
      if (!source) return `source column "${part.column}" does not exist`;
      if (!TEXT_TYPES.has(source.type)) return `cannot concatenate "${source.name}" because it is not a text column`;
      if (!col.nullable && source.nullable) return `cannot concatenate nullable column "${source.name}" into this NOT NULL column`;
      if (source.maxLen == null) length = null;
      else if (length != null) length += source.maxLen;
    }
    if (mode.maxLength != null) length = length == null ? mode.maxLength : Math.min(length, mode.maxLength);
    if (length != null && col.maxLen != null && length > col.maxLen) {
      return `may produce ${length} characters, exceeding its length limit of ${col.maxLen}`;
    }
    return null;
  }
  if (mode === 'random') {
    if (TEXT_TYPES.has(col.type) || NUMBER_TYPES.has(col.type)) return null;
    return `"random" needs a text or numeric column (is ${col.type})`;
  }
  if (mode === 'null') return col.nullable ? null : 'is NOT NULL, so "null" would fail the insert – use "empty" or "hash"';
  if (mode === 'empty') return STRING_TYPES.has(col.type) || NUMBER_TYPES.has(col.type) ? null : `type ${col.type} cannot be blanked – use "null"`;
  if (mode === 'hash') {
    if (!STRING_TYPES.has(col.type)) return `"hash" needs a text/binary column (is ${col.type})`;
    if (col.maxLen != null && col.maxLen < HASH_MIN_LENGTH) return `is only ${col.maxLen} characters – too short to hash without collisions, use "empty" or "null"`;
    return null;
  }
  return `unknown mode ${mode}`;
}

/** SQL expression that stands in for a sensitive column in the SELECT, so the real value never leaves the master. */
function maskExpr(col, mode, salt) {
  if (mode && typeof mode === 'object' && Object.prototype.hasOwnProperty.call(mode, 'value')) return SqlString.escape(mode.value);
  if (mode && typeof mode === 'object' && typeof mode.from === 'string') return quote(mode.from);
  if (mode && typeof mode === 'object' && Array.isArray(mode.concat)) {
    const parts = mode.concat.map((part) => (
      typeof part === 'string' ? SqlString.escape(part) : quote(part.column)
    ));
    const joined = `CONCAT(${parts.join(', ')})`;
    return mode.maxLength != null ? `LEFT(${joined}, ${Number(mode.maxLength)})` : joined;
  }
  if (mode === 'random') {
    if (NUMBER_TYPES.has(col.type)) return 'FLOOR(RAND() * 10)';
    const len = Math.min(col.maxLen || 32, 32);
    return `LEFT(MD5(RAND()), ${len})`;
  }
  if (mode === 'null') return 'NULL';
  if (mode === 'empty') return NUMBER_TYPES.has(col.type) ? '0' : "''";
  const len = Math.min(col.maxLen || 64, 64);
  return `LEFT(SHA2(CONCAT(${SqlString.escape(salt)}, CAST(${quote(col.name)} AS BINARY)), 256), ${len})`;
}

/**
 * Cut-off for a range, evaluated once on the master so both sides compare against the identical instant.
 * Returns a 'YYYY-MM-DD HH:MM:SS' string (dateStrings is on).
 */
async function cutoff(pool, range) {
  if (range.since) return range.since;
  const [r] = await pool.query(`SELECT DATE_SUB(NOW(), INTERVAL ${Number(range.amount)} ${range.unit}) AS c`);
  return String(r[0].c);
}

const READ_ONLY_PRIVS = new Set([
  'USAGE', 'SELECT', 'SHOW VIEW', 'SHOW DATABASES', 'PROCESS', 'EXECUTE', 'TRIGGER', 'REPLICATION CLIENT',
]);

/** Throws if the connected user holds any privilege beyond read access (the master must never be written to). */
async function assertReadOnly(pool) {
  const [rows] = await pool.query('SHOW GRANTS FOR CURRENT_USER()');
  const bad = new Set();
  for (const row of rows) {
    const m = /^GRANT\s+(.+?)\s+ON\s/i.exec(String(Object.values(row)[0]));
    if (!m) continue; // role grants etc.
    for (const priv of m[1].split(/\s*,\s*(?![^(]*\))/)) {
      const name = priv.replace(/\s*\(.*\)$/, '').trim().toUpperCase();
      if (!READ_ONLY_PRIVS.has(name)) bad.add(name);
    }
  }
  if (bad.size) {
    const err = new Error(`master user must be read-only, but it holds: ${[...bad].join(', ')}`);
    err.code = 'NOT_READ_ONLY';
    err.privileges = [...bad];
    throw err;
  }
}

const DROP = { tables: 'TABLE', views: 'VIEW', procedures: 'PROCEDURE', functions: 'FUNCTION', triggers: 'TRIGGER' };

module.exports = {
  name: 'mysql',
  defaultPort: 3306,
  kinds: KINDS,
  createPool,
  quote,
  escape: (v) => SqlString.escape(v),
  listObjects,
  getCreateSql,
  normalizeSql,
  primaryKey,
  count,
  checksum,
  digest,
  columns,
  indexedColumns,
  isTemporal,
  maskProblem,
  maskExpr,
  cutoff,
  hasForeignKeys,
  assertReadOnly,
  swapSql: (table, fresh, old) => `RENAME TABLE ${quote(table)} TO ${quote(old)}, ${quote(fresh)} TO ${quote(table)}`,
  async sessionSetup(conn) {
    await conn.query('SET FOREIGN_KEY_CHECKS=0, UNIQUE_CHECKS=0, SQL_MODE=CONCAT(@@sql_mode, \',NO_AUTO_VALUE_ON_ZERO\')');
  },
  async sessionTeardown(conn) {
    await conn.query('SET FOREIGN_KEY_CHECKS=1, UNIQUE_CHECKS=1');
  },
  dumpPreamble: 'SET FOREIGN_KEY_CHECKS=0;\nSET UNIQUE_CHECKS=0;\n',
  dropSql: (kind, name) => `DROP ${DROP[kind]} IF EXISTS ${quote(name)}`,
};
