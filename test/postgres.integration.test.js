'use strict';

// Needs a live server and is skipped otherwise. Example:
//   docker run -d --name pgtest -e POSTGRES_PASSWORD=pw -p 55432:5432 postgres:17
//   SQLCPY_TEST_PG=postgres://postgres:pw@127.0.0.1:55432 node --test test/postgres.integration.test.js
// It creates (and drops) the databases sqlcpy_it_master and sqlcpy_it_slave. The admin user must be able to
// create databases and SET session_replication_role (a superuser does).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client } = require('pg');
const { SqlCpy } = require('../src/index');
const { Rules } = require('../src/rules');

const URL_ = process.env.SQLCPY_TEST_PG;
const skip = URL_ ? false : 'set SQLCPY_TEST_PG=postgres://user:pw@host:port to run';

const MASTER = 'sqlcpy_it_master';
const SLAVE = 'sqlcpy_it_slave';

const MASTER_SQL = `
CREATE TYPE mood AS ENUM ('sad', 'ok', 'happy');
CREATE TYPE "Perm Kind" AS ENUM ('read', 'write');
CREATE DOMAIN positive_int AS integer NOT NULL DEFAULT 1 CONSTRAINT positive_chk CHECK (VALUE > 0);
CREATE TYPE address AS (street text, zip varchar(10), mood mood);
CREATE TYPE intspan AS RANGE (subtype = integer, subtype_diff = int4range_subdiff);
CREATE SEQUENCE ticket_seq AS bigint START 100 INCREMENT 5 CACHE 1;
SELECT setval('ticket_seq', 120);
CREATE TABLE users (
  id serial PRIMARY KEY,
  external_id varchar(32) NOT NULL UNIQUE,
  email varchar(60),
  display_name text NOT NULL DEFAULT 'anon',
  tags text[],
  meta jsonb,
  balance numeric(12,2) NOT NULL DEFAULT 0,
  score double precision,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  born date,
  avatar bytea,
  label text GENERATED ALWAYS AS (display_name || '!') STORED,
  mood mood NOT NULL DEFAULT 'ok',
  kinds "Perm Kind"[],
  level positive_int,
  home address,
  span intspan,
  ticket bigint NOT NULL DEFAULT nextval('ticket_seq'),
  CONSTRAINT balance_nonneg CHECK (balance >= 0)
);
COMMENT ON TABLE users IS 'the app''s users';
COMMENT ON COLUMN users.email IS 'login email';
CREATE INDEX users_email_idx ON users (lower(email));
CREATE TABLE orders (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id int NOT NULL REFERENCES users(id),
  total numeric(10,2) NOT NULL,
  placed_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX orders_placed_idx ON orders (placed_at);
CREATE TABLE "Mixed Case" ("Id" int PRIMARY KEY, "Weird""Col" text);
CREATE TABLE nopk (a int, b text);
CREATE TABLE audit (id serial PRIMARY KEY, at timestamptz NOT NULL, note text);
CREATE INDEX audit_at_idx ON audit (at);
CREATE TABLE secrets (id int PRIMARY KEY, token text);
CREATE TABLE measurements (day date NOT NULL, v int NOT NULL, PRIMARY KEY (day, v)) PARTITION BY RANGE (day);
CREATE TABLE measurements_2025 PARTITION OF measurements FOR VALUES FROM ('2025-01-01') TO ('2026-01-01');
CREATE TABLE measurements_2026 PARTITION OF measurements FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
CREATE VIEW order_totals AS SELECT user_id, sum(total) AS total FROM orders GROUP BY user_id;
CREATE VIEW big_spenders AS SELECT user_id FROM order_totals WHERE total > 100;
CREATE FUNCTION add_one(i int) RETURNS int LANGUAGE sql IMMUTABLE AS 'select i + 1';
CREATE FUNCTION add_one(i bigint) RETURNS bigint LANGUAGE sql IMMUTABLE AS 'select i + 1';
CREATE PROCEDURE bump(IN uid int) LANGUAGE plpgsql AS $$ BEGIN UPDATE users SET score = coalesce(score, 0) + 1 WHERE id = uid; END $$;
CREATE FUNCTION trim_name() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.display_name := trim(NEW.display_name); RETURN NEW; END $$;
CREATE TRIGGER users_trim BEFORE INSERT OR UPDATE ON users FOR EACH ROW EXECUTE FUNCTION trim_name();

INSERT INTO users (external_id, email, display_name, tags, meta, balance, score, active, created_at, born, avatar, mood, kinds, level, home, span)
SELECT 'ext-' || g,
       CASE WHEN g % 7 = 0 THEN NULL ELSE 'user' || g || '@Example.com' END,
       CASE g % 5 WHEN 0 THEN 'O''Brien \\ back' WHEN 1 THEN 'Zoë 日本語 🎉' WHEN 2 THEN E'multi\\nline\\ttab' ELSE 'plain ' || g END,
       CASE WHEN g % 3 = 0 THEN ARRAY['a', 'b,c', 'd"e'] END,
       CASE WHEN g % 4 = 0 THEN jsonb_build_object('n', g, 'nested', jsonb_build_array(1, 'two', null)) END,
       (g % 1000) / 7.0,
       CASE WHEN g % 9 = 0 THEN NULL ELSE g / 3.0 END,
       g % 2 = 0,
       timestamptz '2026-01-01 00:00:00+00' + (g || ' minutes')::interval + (g % 1000 || ' microseconds')::interval,
       CASE WHEN g % 6 = 0 THEN NULL ELSE date '2000-01-01' + g END,
       CASE WHEN g % 8 = 0 THEN decode(lpad(to_hex(g), 8, '0'), 'hex') END,
       (ARRAY['sad', 'ok', 'happy'])[1 + g % 3]::mood,
       CASE WHEN g % 2 = 0 THEN ARRAY['read', 'write']::"Perm Kind"[] END,
       g,
       CASE WHEN g % 5 = 0 THEN ROW('1 Main, St', '12345', 'happy')::address END,
       intspan(g, g + 10)
FROM generate_series(1, 2500) g;
INSERT INTO orders (user_id, total, placed_at)
SELECT 1 + g % 2500, (g % 500) + 0.25, timestamp '2026-02-01' + (g || ' seconds')::interval FROM generate_series(1, 3000) g;
INSERT INTO "Mixed Case" SELECT g, 'v' || g FROM generate_series(1, 50) g;
INSERT INTO nopk SELECT g % 10, 'row ' || g FROM generate_series(1, 6000) g;
INSERT INTO audit (at, note) SELECT now() - (g || ' hours')::interval, 'n' || g FROM generate_series(1, 4000) g;
INSERT INTO secrets VALUES (1, 'top-secret');
INSERT INTO measurements SELECT date '2025-06-01' + (g % 400), g FROM generate_series(1, 800) g;
`;

async function admin(db, sql) {
  const u = new URL(URL_);
  if (db) u.pathname = '/' + db;
  const c = new Client({ connectionString: u.toString() });
  await c.connect();
  try { return await c.query(sql); } finally { await c.end(); }
}

async function freshDatabases() {
  for (const db of [MASTER, SLAVE]) await admin(null, `DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
  for (const db of [MASTER, SLAVE]) await admin(null, `CREATE DATABASE ${db}`);
}

async function dropDatabases() {
  for (const db of [MASTER, SLAVE]) await admin(null, `DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
}

function config(dir, rules) {
  const u = new URL(URL_);
  const side = (database) => ({ host: u.hostname, port: Number(u.port || 5432), user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database });
  return {
    type: 'postgres',
    master: side(MASTER),
    slave: side(SLAVE),
    chunkBytes: 64 * 1024, // small, so the 2500-row tables really are split into chunks
    chunkDelayMs: 0,
    concurrency: 1,
    checksumMaxBytes: 50 * 1024 * 1024,
    dumpDir: dir,
    cacheFile: path.join(dir, 'cache.json'),
    maskSalt: 'salt',
    configFile: path.join(dir, 'none.jsonc'),
    rules: rules || new Rules({}),
  };
}

const ORDER = ['types', 'sequences', 'functions', 'procedures', 'tables', 'views', 'triggers'];
// dependencies first (parents before children, views before the views built on them), as an operator would copy them
const WITHIN_KIND = {
  types: ['mood', 'Perm Kind', 'positive_int', 'address', 'intspan'], // address uses mood
  tables: ['users', 'orders', 'Mixed Case', 'nopk', 'audit', 'secrets', 'measurements'],
  views: ['order_totals', 'big_spenders'],
};

async function copyAll(app) {
  const rank = (i) => ORDER.indexOf(i.kind) * 100 + (WITHIN_KIND[i.kind] ? WITHIN_KIND[i.kind].indexOf(i.name) : 0);
  for (const it of [...app.items].sort((a, b) => rank(a) - rank(b))) await app.copy(it);
}

const byName = (app, kind, name) => app.items.find((i) => i.kind === kind && i.name === name);
const statusOf = (app) => Object.fromEntries(app.items.map((i) => [`${i.kind}:${i.name}`, i.status]));

test('postgres: copy a rich schema and compare reports in sync', { skip }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlcpy-pg-'));
  await freshDatabases();
  await admin(MASTER, MASTER_SQL);

  const app = new SqlCpy(config(dir));
  app.headless = true;
  t.after(async () => {
    await app.close();
    await dropDatabases();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await t.test('scan lists every object kind; partitions are folded into their parent', async () => {
    await app.scan({ force: true });
    const names = (kind) => app.items.filter((i) => i.kind === kind).map((i) => i.name).sort();
    assert.deepEqual(names('types'), ['Perm Kind', 'address', 'intspan', 'mood', 'positive_int']);
    assert.deepEqual(names('sequences'), ['ticket_seq'], 'sequences owned by serial / identity columns are not listed');
    assert.deepEqual(names('tables'), ['Mixed Case', 'audit', 'measurements', 'nopk', 'orders', 'secrets', 'users']);
    assert.deepEqual(names('views'), ['big_spenders', 'order_totals']);
    assert.deepEqual(names('functions'), ['add_one(i bigint)', 'add_one(i integer)', 'trim_name()']);
    assert.deepEqual(names('procedures').map((n) => n.replace('(IN ', '(')), ['bump(uid integer)']); // newer servers print the IN
    assert.deepEqual(names('triggers'), ['users.users_trim']);
    assert.ok(app.items.every((i) => i.status === 'missing'), 'nothing exists on the slave yet');
  });

  await t.test('copy everything, then every object is in sync', async () => {
    await copyAll(app);
    await app.scan({ force: true });
    const bad = Object.entries(statusOf(app)).filter(([, s]) => s !== 'same');
    assert.deepEqual(bad, [], app.items.filter((i) => i.status !== 'same').map((i) => `${i.kind}:${i.name} ${i.status} ${i.detail}`).join('\n'));
    assert.equal(byName(app, 'tables', 'users').masterRows, 2500);
  });

  await t.test('types and sequences: a new enum label reaches a slave whose tables already use the type', async () => {
    const seq = await admin(SLAVE, `SELECT last_value FROM ticket_seq`);
    assert.equal(Number(seq.rows[0].last_value), 120 + 5 * 2500, 'the slave sequence carries on from the master position');
    await admin(MASTER, `ALTER TYPE mood ADD VALUE 'ecstatic' AFTER 'happy'; ALTER TYPE mood ADD VALUE 'grim' BEFORE 'sad'`);
    await app.scan({ force: true });
    assert.equal(byName(app, 'types', 'mood').status, 'different');
    await app.copy(byName(app, 'types', 'mood'));
    assert.equal(byName(app, 'types', 'mood').status, 'same');
    const r = await admin(SLAVE, `SELECT string_agg(enumlabel, ',' ORDER BY enumsortorder) AS l FROM pg_enum WHERE enumtypid = 'mood'::regtype`);
    assert.equal(r.rows[0].l, 'grim,sad,ok,happy,ecstatic');
    await app.copy(byName(app, 'sequences', 'ticket_seq')); // in use by users.ticket: aligned in place, not dropped
    assert.equal(byName(app, 'sequences', 'ticket_seq').status, 'same');
  });

  await t.test('values survive exactly (quotes, unicode, arrays, json, bytea, timestamps, nulls)', async () => {
    const q = (db) => admin(db, `SELECT id, external_id, email, display_name, tags, meta, balance, score, active, created_at, born, encode(avatar, 'hex') AS av, label, mood, kinds, level, home, span, ticket FROM users ORDER BY id`);
    const [m, s] = [await q(MASTER), await q(SLAVE)];
    assert.equal(s.rows.length, 2500);
    assert.deepEqual(s.rows, m.rows);
  });

  await t.test('sequences continue after the loaded rows, identity columns kept their values', async () => {
    const r = await admin(SLAVE, `INSERT INTO users (external_id) VALUES ('after-copy') RETURNING id`);
    assert.equal(r.rows[0].id, 2501);
    const o = await admin(SLAVE, `INSERT INTO orders (user_id, total) VALUES (1, 1) RETURNING id`);
    assert.equal(Number(o.rows[0].id), 3001);
    await admin(SLAVE, `DELETE FROM orders WHERE id = 3001; DELETE FROM users WHERE id = 2501`);
  });

  await t.test('constraints, comments, partitions and the generated column were recreated', async () => {
    const r = await admin(SLAVE, `SELECT
      (SELECT count(*) FROM pg_constraint WHERE conname = 'balance_nonneg') AS chk,
      (SELECT count(*) FROM pg_constraint WHERE conrelid = 'orders'::regclass AND contype = 'f') AS fk,
      obj_description('users'::regclass, 'pg_class') AS tcomment,
      (SELECT count(*) FROM pg_inherits WHERE inhparent = 'measurements'::regclass) AS parts,
      (SELECT attgenerated FROM pg_attribute WHERE attrelid = 'users'::regclass AND attname = 'label') AS gen`);
    assert.deepEqual({ ...r.rows[0], chk: Number(r.rows[0].chk), fk: Number(r.rows[0].fk), parts: Number(r.rows[0].parts) },
      { chk: 1, fk: 1, tcomment: "the app's users", parts: 2, gen: 's' });
  });

  await t.test('re-copying a referenced, view-backed table keeps the foreign key and both views', async () => {
    await app.copy(byName(app, 'tables', 'users')); // orders -> users is detached for the drop and must be re-attached
    const fk = await admin(SLAVE, `SELECT count(*) AS c, bool_and(convalidated) AS valid FROM pg_constraint WHERE conrelid = 'orders'::regclass AND contype = 'f'`);
    assert.deepEqual(fk.rows[0], { c: '1', valid: false }, 'restored NOT VALID: a partial copy may leave orphans');
    await app.copy(byName(app, 'tables', 'orders')); // the two views over orders are detached for the drop and rebuilt
    const r = await admin(SLAVE, `SELECT
      (SELECT count(*) FROM pg_constraint WHERE conrelid = 'orders'::regclass AND contype = 'f') AS fk,
      (SELECT count(*) FROM pg_views WHERE viewname IN ('order_totals', 'big_spenders')) AS views`);
    assert.deepEqual({ fk: Number(r.rows[0].fk), views: Number(r.rows[0].views) }, { fk: 1, views: 2 });
    await app.scan({ force: true });
    assert.deepEqual(Object.entries(statusOf(app)).filter(([k, s]) => s !== 'same' && !k.startsWith('triggers:')), []);
  });

  await t.test('tables are loaded in several chunks, sequentially and in parallel', async () => {
    for (const concurrency of [1, 3]) {
      const other = new SqlCpy({ ...config(dir), concurrency });
      other.headless = true;
      try {
        await other.scan({ force: true });
        for (const name of ['users', 'orders', 'audit', 'nopk']) { // keyed, FK child, timestamp-keyed, keyless
          const it = byName(other, 'tables', name);
          let chunks = 0;
          const res = await other.copy(it, { onProgress: (p) => { chunks = Math.max(chunks, p.chunks || 0); } });
          assert.ok(chunks > 1, `${name} should be split into several chunks (concurrency ${concurrency}), got ${chunks}`);
          assert.equal(it.status, 'same', `${name} (concurrency ${concurrency}): ${it.detail}`);
          assert.equal(res.rows, it.masterRows);
        }
      } finally {
        await other.close();
      }
    }
  });

  await t.test('a changed row is detected, and copying fixes it', async () => {
    await admin(SLAVE, `UPDATE nopk SET b = 'tampered' WHERE ctid = (SELECT ctid FROM nopk LIMIT 1)`);
    const it = byName(app, 'tables', 'nopk');
    await app.check(it);
    assert.equal(it.status, 'different');
    await app.copy(it);
    assert.equal(it.status, 'same');
  });

  await t.test('a changed definition is detected', async () => {
    await admin(SLAVE, `CREATE OR REPLACE FUNCTION trim_name() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`);
    const it = byName(app, 'functions', 'trim_name()');
    await app.check(it);
    assert.equal(it.status, 'different');
    await app.copy(it);
    assert.equal(it.status, 'same');
  });
});

test('postgres: policy rules (sensitive tables, masked columns, ranges)', { skip }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlcpy-pg-'));
  await freshDatabases();
  await admin(MASTER, MASTER_SQL);

  const rules = new Rules({
    sensitive: {
      tables: ['secrets'],
      columns: { users: { email: 'hash', display_name: { value: 'Sample' }, tags: 'null', score: 'random', avatar: 'empty', meta: 'null' } },
    },
    range: { audit: { column: 'at', last: '30d' } },
  }, null, { salt: 'salt' });
  const app = new SqlCpy(config(dir, rules));
  app.headless = true;
  t.after(async () => {
    await app.close();
    await dropDatabases();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await app.scan({ force: true });
  await copyAll(app);
  await app.scan({ force: true });

  await t.test('sensitive table: structure only, no rows', async () => {
    assert.equal((await admin(SLAVE, 'SELECT count(*) AS c FROM secrets')).rows[0].c, '0');
    assert.equal(byName(app, 'tables', 'secrets').status, 'same');
  });

  await t.test('masked columns are replaced on the master side and the rest matches', async () => {
    const r = await admin(SLAVE, `SELECT count(*) AS n, count(DISTINCT display_name) AS names, min(length(email)) AS minlen, max(length(email)) AS maxlen,
                                         count(*) FILTER (WHERE email = (SELECT email FROM users LIMIT 1) ) AS same_email FROM users WHERE email IS NOT NULL`);
    assert.equal(r.rows[0].names, '1');
    assert.equal(r.rows[0].minlen, 60); // sha256 hex (64) trimmed to the column length
    assert.equal(r.rows[0].maxlen, 60);
    const leak = await admin(SLAVE, `SELECT count(*) AS c FROM users WHERE email ILIKE '%@example.com'`);
    assert.equal(leak.rows[0].c, '0', 'no real email may reach the slave');
    assert.equal(byName(app, 'tables', 'users').status, 'same');
  });

  await t.test('range table holds only the latest rows and is in sync', async () => {
    const r = await admin(SLAVE, `SELECT count(*) AS c, min(at) > now() - interval '31 days' AS recent FROM audit`);
    assert.ok(Number(r.rows[0].c) > 0 && Number(r.rows[0].c) < 4000);
    assert.equal(r.rows[0].recent, true);
    assert.equal(byName(app, 'tables', 'audit').status, 'same');
  });
});

test('postgres: read-only guard', { skip }, async () => {
  await admin(null, 'DROP ROLE IF EXISTS sqlcpy_ro');
  await admin(null, "CREATE ROLE sqlcpy_ro LOGIN PASSWORD 'ro'");
  await admin(null, `DROP DATABASE IF EXISTS ${MASTER} WITH (FORCE)`);
  await admin(null, `CREATE DATABASE ${MASTER}`);
  await admin(MASTER, 'CREATE TABLE t (id int); GRANT SELECT ON t TO sqlcpy_ro');
  const u = new URL(URL_);
  const driver = require('../src/drivers/pg');
  const pool = driver.createPool({ host: u.hostname, port: Number(u.port || 5432), user: 'sqlcpy_ro', password: 'ro', database: MASTER });
  try {
    await driver.assertReadOnly(pool); // SELECT only: fine
    await admin(MASTER, 'GRANT UPDATE ON t TO sqlcpy_ro');
    await assert.rejects(driver.assertReadOnly(pool), (e) => e.code === 'NOT_READ_ONLY' && e.privileges.includes('UPDATE'));
  } finally {
    await pool.end();
    await admin(null, `DROP DATABASE IF EXISTS ${MASTER} WITH (FORCE)`);
    await admin(null, 'DROP ROLE IF EXISTS sqlcpy_ro');
  }
});

test('postgres: tables that reference each other copy in any order', { skip }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlcpy-pg-'));
  await freshDatabases();
  await admin(MASTER, `
CREATE TABLE department (id int PRIMARY KEY, name text, head_id int);
CREATE TABLE "user" (id int PRIMARY KEY, name text, department_id int REFERENCES department(id));
ALTER TABLE department ADD CONSTRAINT department_head_fk FOREIGN KEY (head_id) REFERENCES "user"(id);
INSERT INTO department VALUES (1, 'eng', NULL);
INSERT INTO "user" VALUES (1, 'ann', 1);
UPDATE department SET head_id = 1;`);

  const app = new SqlCpy(config(dir));
  app.headless = true;
  t.after(async () => {
    await app.close();
    await dropDatabases();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await app.scan({ force: true });

  const fks = () => admin(SLAVE, `SELECT conrelid::regclass::text AS tbl, conname FROM pg_constraint WHERE contype = 'f' ORDER BY 1, 2`);

  await app.copy(byName(app, 'tables', 'department')); // its parent "user" is not on the slave yet
  assert.deepEqual((await fks()).rows, []);
  await app.copy(byName(app, 'tables', 'user')); // brings back both its own key and department's key to it
  assert.deepEqual((await fks()).rows.map((r) => r.conname).sort(), ['department_head_fk', 'user_department_id_fkey']);

  await app.copy(byName(app, 'tables', 'department')); // and re-copying either side keeps them
  await app.copy(byName(app, 'tables', 'user'));
  assert.equal((await fks()).rows.length, 2);

  await app.scan({ force: true });
  assert.deepEqual(Object.entries(statusOf(app)).filter(([, s]) => s !== 'same'), []);
});
