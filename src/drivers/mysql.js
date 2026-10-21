'use strict';
const mysql = require('mysql2/promise');
const SqlString = require('sqlstring');
const { createMaskProblem } = require('./maskcheck');

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
const STRICT_MODES = new Set(['STRICT_TRANS_TABLES', 'STRICT_ALL_TABLES']);

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
  if (!sql) {
    const hint = kind === 'procedures' || kind === 'functions'
      ? ' - MySQL hides routine bodies unless the user is the definer or holds global SHOW_ROUTINE (8.0.20+) / SELECT: GRANT SHOW_ROUTINE ON *.* TO user'
      : ' (insufficient privileges?)';
    throw new Error(`No definition returned for ${kind} ${name}${hint}`);
  }
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

const isTemporal = (col) => TIME_TYPES.has(col.type);
const maskProblem = createMaskProblem({ stringTypes: STRING_TYPES, textTypes: TEXT_TYPES, numberTypes: NUMBER_TYPES, timeTypes: TIME_TYPES });

/** SQL expression that stands in for a sensitive column in the SELECT, so the real value never leaves the master. */
function maskExpr(col, mode, salt) {
  if (mode && typeof mode === 'object' && mode.when) {
    const { when, ...rest } = mode;
    const list = when.values.map((v) => SqlString.escape(v)).join(', ');
    return `CASE WHEN ${quote(when.column)} IN (${list}) THEN ${maskExpr(col, rest, salt)} ELSE ${quote(col.name)} END`;
  }
  if (mode && typeof mode === 'object' && Array.isArray(mode.replace)) {
    return mode.replace.reduce((expr, [a, b]) => `REPLACE(${expr}, ${SqlString.escape(a)}, ${SqlString.escape(b)})`, quote(col.name));
  }
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
  'USAGE', 'SELECT', 'SHOW VIEW', 'SHOW DATABASES', 'PROCESS', 'EXECUTE', 'TRIGGER', 'REPLICATION CLIENT', 'SHOW_ROUTINE',
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
  versionLabel: (v) => `MySQL ${v}`,
  readOnlyGrants: (c) => [
    `CREATE USER 'backup_user'@'%' IDENTIFIED BY 'change_me';`,
    `GRANT SELECT, SHOW VIEW, TRIGGER, EXECUTE ON \`${c.database}\`.* TO 'backup_user'@'%';`,
    `GRANT SHOW_ROUTINE ON *.* TO 'backup_user'@'%';`,
    'FLUSH PRIVILEGES;',
  ],
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
  // Strict mode is switched off so rows are copied exactly as the master holds them: a master that was loaded
  // non-strictly can contain values strict mode rejects (e.g. the invalid-enum '' stored as index 0, which fails
  // with WARN_DATA_TRUNCATED), as well as zero dates and over-long values.
  async sessionSetup(conn) {
    const [r] = await conn.query('SELECT @@sql_mode AS m');
    conn.sqlcpyPrevMode = String(r[0].m || '');
    const modes = conn.sqlcpyPrevMode.split(',').filter((m) => m && !STRICT_MODES.has(m.toUpperCase()));
    modes.push('NO_AUTO_VALUE_ON_ZERO');
    await conn.query('SET FOREIGN_KEY_CHECKS=0, UNIQUE_CHECKS=0, SQL_MODE=?', [modes.join(',')]);
  },
  async sessionTeardown(conn) {
    await conn.query('SET FOREIGN_KEY_CHECKS=1, UNIQUE_CHECKS=1, SQL_MODE=?', [conn.sqlcpyPrevMode || '']);
  },
  dumpPreamble: "SET FOREIGN_KEY_CHECKS=0;\nSET UNIQUE_CHECKS=0;\nSET SQL_MODE='NO_AUTO_VALUE_ON_ZERO';\n",
  dropSql: (kind, name) => `DROP ${DROP[kind]} IF EXISTS ${quote(name)}`,
};
