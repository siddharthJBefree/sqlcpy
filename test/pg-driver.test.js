'use strict';

// Pure helpers of the PostgreSQL driver: no server needed.
const test = require('node:test');
const assert = require('node:assert/strict');
const pg = require('../src/drivers/pg');
const { getDriver } = require('../src/drivers');

test('the driver is selectable under its usual names', () => {
  for (const name of ['postgres', 'postgresql', 'pg']) assert.equal(getDriver(name), pg);
  assert.equal(pg.defaultPort, 5432);
  assert.throws(() => getDriver('oracle'), /Unsupported DB_TYPE/);
});

test('? placeholders become $n, but never inside quotes', () => {
  assert.equal(pg.toPg('SELECT a FROM t WHERE x = ? AND y > ?', [1, 2]), 'SELECT a FROM t WHERE x = $1 AND y > $2');
  assert.equal(pg.toPg(`SELECT '?', "co?l" FROM t WHERE x = ? AND z = 'it''s ?'`, [1]), `SELECT '?', "co?l" FROM t WHERE x = $1 AND z = 'it''s ?'`);
  assert.equal(pg.toPg('SELECT 1 WHERE a = $1', [5]), 'SELECT 1 WHERE a = $1', 'native $n passes through');
  assert.equal(pg.toPg('SELECT ?', []), 'SELECT ?', 'no params: untouched, so row data containing ? is safe');
  assert.throws(() => pg.toPg('SELECT ? , ?', [1]), /2 placeholder\(s\) but 1 parameter/);
});

test('identifiers and literals are escaped', () => {
  assert.equal(pg.quote('plain'), '"plain"');
  assert.equal(pg.quote('we"ird'), '"we""ird"');
  assert.equal(pg.escape("it's \\ ok"), "'it''s \\ ok'"); // backslash stays literal: standard_conforming_strings is pinned on
  assert.equal(pg.escape(null), 'NULL');
  assert.equal(pg.escape(undefined), 'NULL');
  assert.equal(pg.escape(true), 'TRUE');
  assert.equal(pg.escape(42), '42');
  assert.equal(pg.escape(NaN), "'NaN'");
  assert.equal(pg.escape(Buffer.from([0xde, 0xad])), "'\\xdead'");
  assert.equal(pg.escape('{1,2}'), "'{1,2}'");
});

test('drop statements address overloads, triggers and tables', () => {
  assert.equal(pg.dropSql('views', 'v'), 'DROP VIEW IF EXISTS "v"');
  assert.equal(pg.dropSql('functions', 'add_one(i integer)'), 'DROP FUNCTION IF EXISTS "add_one"(i integer)');
  assert.equal(pg.dropSql('procedures', 'bump(IN uid integer)'), 'DROP PROCEDURE IF EXISTS "bump"(IN uid integer)');
  assert.equal(pg.dropSql('triggers', 'users.users_trim'), 'DROP TRIGGER IF EXISTS "users_trim" ON "users"');
  const table = pg.dropSql('tables', "o'brien");
  assert.match(table, /DROP TABLE IF EXISTS "o'brien";/);
  assert.match(table, /to_regclass\('"o''brien"'\)/, 'name is quoted as an identifier, then as a literal');
  assert.doesNotMatch(table, /CASCADE/i, 'nothing may be cascaded away silently');
});

test('masking: replacements are built on the server and respect column types', () => {
  const text = { name: 'email', type: 'character varying', nullable: true, maxLen: 60 };
  const int = { name: 'age', type: 'integer', nullable: false, maxLen: null };
  assert.equal(pg.maskExpr(text, 'null'), 'NULL');
  assert.equal(pg.maskExpr(text, 'empty'), "''");
  assert.equal(pg.maskExpr(int, 'empty'), '0');
  assert.equal(pg.maskExpr(text, { value: "O'Hara" }), "'O''Hara'");
  assert.equal(pg.maskExpr(text, { from: 'first_name' }), '"first_name"');
  assert.equal(pg.maskExpr(text, { concat: [{ column: 'a' }, '@1', { column: 'b' }], maxLength: 10 }), `LEFT(("a" || '@1' || "b")::text, 10)`);
  assert.match(pg.maskExpr(text, 'hash', "s'alt"), /^LEFT\(ENCODE\(SHA256\(CONVERT_TO\('s''alt' \|\| "email"::text, 'UTF8'\)\), 'hex'\), 60\)$/);
  assert.match(pg.maskExpr(int, 'random'), /FLOOR\(RANDOM\(\)/);

  const cols = new Map([['email', text], ['age', int]]);
  assert.equal(pg.maskProblem(text, 'hash', cols), null);
  assert.match(pg.maskProblem(int, 'hash', cols), /needs a text\/binary column/);
  assert.match(pg.maskProblem({ ...int, type: 'timestamp with time zone' }, 'random', cols), /needs a text or numeric column/);
  assert.match(pg.maskProblem({ ...text, nullable: false }, 'null', cols), /NOT NULL/);
  assert.equal(pg.isTemporal({ type: 'timestamp with time zone' }), true);
  assert.equal(pg.isTemporal({ type: 'date' }), true);
  assert.equal(pg.isTemporal({ type: 'integer' }), false);
});

test('createPool keeps the schema and does not connect until used', () => {
  const pool = pg.createPool({ host: 'h', port: 1, user: 'u', password: 'p', database: 'd', schema: 'qa', ssl: 'no-verify' });
  assert.equal(pool.schema, 'qa');
  assert.equal(pg.createPool({ host: 'h', port: 1, user: 'u', password: 'p', database: 'd' }).schema, 'public');
  return pool.end();
});
