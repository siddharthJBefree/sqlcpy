'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Rules } = require('../src/rules');
const mysql = require('../src/drivers/mysql');
const { resolveScope } = require('../src/scope');

const columns = [
  { name: 'id', type: 'int', nullable: false, maxLen: null },
  { name: 'external_id', type: 'varchar', nullable: false, maxLen: 32 },
  { name: 'first_name', type: 'varchar', nullable: false, maxLen: 20 },
  { name: 'last_name', type: 'varchar', nullable: false, maxLen: 20 },
  { name: 'email', type: 'varchar', nullable: true, maxLen: 60 },
  { name: 'display_name', type: 'varchar', nullable: false, maxLen: 40 },
  { name: 'password', type: 'varchar', nullable: false, maxLen: 255 },
  { name: 'phone', type: 'varchar', nullable: true, maxLen: 15 },
  { name: 'login_count', type: 'int', nullable: false, maxLen: null },
];

function context(masks) {
  return {
    master: {},
    cfg: {
      master: { database: 'master' },
      maskSalt: '',
      rules: new Rules({ sensitive: { columns: { users: masks } } }),
    },
    driver: {
      ...mysql,
      columns: async () => columns,
      primaryKey: async () => ['external_id'],
    },
  };
}

test('parses literal and other-column replacement rules', () => {
  const rules = new Rules({
    sensitive: {
      columns: {
        users: {
          nickname: { value: 'Example' },
          display_name: { from: 'first_name' },
          password: { concat: [{ column: 'first_name' }, '@123', { column: 'last_name' }] },
          phone: 'random',
        },
      },
    },
  });
  assert.deepEqual({ ...rules.tableRule('users').masks }, {
    nickname: { value: 'Example' },
    display_name: { from: 'first_name' },
    password: { concat: [{ column: 'first_name' }, '@123', { column: 'last_name' }] },
    phone: 'random',
  });
});

test('exposes configured ranges as range scope', () => {
  const rules = new Rules({ range: { users: { column: 'created_at', last: '7d' } } });
  assert.equal(rules.scopeOf('users').mode, 'range');
});

test('rejects malformed replacement rules', () => {
  assert.throws(
    () => new Rules({ sensitive: { columns: { users: { email: { value: 'x', from: 'name' } } } } }),
    /give exactly one of "value", "from", or "concat"/,
  );
  assert.throws(
    () => new Rules({ sensitive: { columns: { users: { email: { value: { unsafe: true } } } } } }),
    /must be a string, number, boolean, or null/,
  );
  assert.throws(
    () => new Rules({ sensitive: { columns: { users: { email: { concat: [{ column: 'first_name' }, 42] } } } } }),
    /must be text or \{ "column": "name" \}/,
  );
});

test('builds escaped custom, derived, and random expressions for the master SELECT', async () => {
  const ctx = context({
    email: { value: "x' OR 1=1 --" },
    display_name: { from: 'first_name' },
    password: { concat: [{ column: 'first_name' }, "@123' OR 'x'='x", { column: 'last_name' }] },
    phone: 'random',
    login_count: 'random',
  });
  const scope = await resolveScope(ctx, 'users');

  assert.ok(scope.select.includes("'x\\' OR 1=1 --'"));
  assert.match(scope.select, /`first_name` AS `display_name`/);
  assert.ok(scope.select.includes("CONCAT(`first_name`, '@123\\' OR \\'x\\'=\\'x', `last_name`) AS `password`"));
  assert.ok(scope.select.includes('LEFT(MD5(RAND()), 15) AS `phone`'));
  assert.ok(scope.select.includes('FLOOR(RAND() * 10) AS `login_count`'));
  assert.deepEqual(scope.masked, ['email', 'display_name', 'password', 'phone', 'login_count']);
});

test('rejects deriving from a masked column or a key column', async () => {
  await assert.rejects(
    resolveScope(context({ first_name: 'random', display_name: { from: 'first_name' } }), 'users'),
    /derives from "first_name", which is also masked/,
  );
  await assert.rejects(
    resolveScope(context({ display_name: { from: 'external_id' } }), 'users'),
    /derives from primary-key \/ range column "external_id"/,
  );
  await assert.rejects(
    resolveScope(context({
      first_name: 'random',
      password: { concat: [{ column: 'first_name' }, '@123'] },
    }), 'users'),
    /derives from "first_name", which is also masked/,
  );
  await assert.rejects(
    resolveScope(context({ password: { concat: [{ column: 'external_id' }, '@123'] } }), 'users'),
    /derives from primary-key \/ range column "external_id"/,
  );
});

test('caps a concat replacement with maxLength by trimming the extra characters', async () => {
  const rules = new Rules({
    sensitive: { columns: { users: { display_name: { concat: [{ column: 'first_name' }, '@', { column: 'last_name' }], maxLength: 40 } } } },
  });
  assert.deepEqual({ ...rules.tableRule('users').masks }, {
    display_name: { concat: [{ column: 'first_name' }, '@', { column: 'last_name' }], maxLength: 40 },
  });

  const scope = await resolveScope(
    context({ display_name: { concat: [{ column: 'first_name' }, '@', { column: 'last_name' }], maxLength: 40 } }),
    'users',
  );
  assert.ok(scope.select.includes('LEFT(CONCAT(`first_name`, \'@\', `last_name`), 40) AS `display_name`'));
});

test('rejects a bad maxLength, or one that is not on a concat rule', () => {
  assert.throws(
    () => new Rules({ sensitive: { columns: { users: { email: { concat: ['a', 'b'], maxLength: 0 } } } } }),
    /maxLength: must be a positive whole number/,
  );
  assert.throws(
    () => new Rules({ sensitive: { columns: { users: { email: { value: 'x', maxLength: 5 } } } } }),
    /maxLength: only applies to "concat"/,
  );
});

test('validates replacement types and literal lengths', async () => {
  await assert.rejects(
    resolveScope(context({ display_name: { value: 'x'.repeat(41) } }), 'users'),
    /shorter than the custom value/,
  );
  await assert.rejects(
    resolveScope(context({ phone: 'random', login_count: { from: 'phone' } }), 'users'),
    /not compatible with int/,
  );
  await assert.rejects(
    resolveScope(context({ display_name: { concat: [{ column: 'first_name' }, '@', { column: 'last_name' }] } }), 'users'),
    /may produce 41 characters, exceeding its length limit of 40/,
  );
});

test('schedule block: valid cron, defaults, and strict validation', () => {
  const ok = new Rules({ schedule: { cron: '*/15 * * * *', tables: ['user', 'hr_*'], timezone: 'Asia/Kolkata' } });
  assert.equal(ok.schedule.cron, '*/15 * * * *');
  assert.equal(ok.schedule.skipIfUnchanged, false);
  assert.equal(ok.schedule.atomicSwap, false);
  assert.equal(ok.schedule.tables.length, 2);
  assert.equal(new Rules({}).schedule, null);

  const bad = (schedule, re) => assert.throws(() => new Rules({ schedule }), re);
  bad({ cron: 'every day', tables: ['a'] }, /schedule\.cron/);
  bad({ cron: '0 0 31 2 99', tables: ['a'] }, /schedule\.cron/);
  bad({ cron: '0 2 * * * *', tables: ['a'] }, /5-field/);
  assert.equal(new Rules({ schedule: { cron: '0 2 * * *' } }).schedule.allTables, true); // follows the other rules
  bad({ cron: '0 2 * * *', tables: [] }, /schedule\.tables/);
  bad({ cron: '0 2 * * *', tables: ['a'], timezone: 'Mars/Base' }, /timezone/);
  bad({ cron: '0 2 * * *', tables: ['a'], atomicSwap: 'yes' }, /atomicSwap/);
  bad({ cron: '0 2 * * *', tables: ['a'], atomicSwa: true }, /unknown key/);
});

test('changing the schedule does not change the rules fingerprint (no needless rescans)', () => {
  const a = new Rules({ ignore: ['x'], schedule: { cron: '0 2 * * *', tables: ['a'] } });
  const b = new Rules({ ignore: ['x'], schedule: { cron: '0 3 * * *', tables: ['a', 'b'] } });
  assert.equal(a.fingerprint, b.fingerprint);
});

test('schedule table matching returns tables alphabetically', async () => {
  const { SqlCpy } = require('../src/index');
  const app = Object.create(SqlCpy.prototype);
  const tables = ['zebra', 'Alpha', 'beta'].map((name) => ({ name }));
  app._list = async () => [{ tables }, { tables: [] }];
  app.rules = { scopeOf: () => ({ mode: 'full' }) };

  const { items } = await app.tablesMatching(['*']);
  assert.deepEqual(items.map((item) => item.name), ['Alpha', 'beta', 'zebra']);
});

test('cron preview: next runs honour the time zone, day-of-month/week OR rule and validation', () => {
  const cron = require('../src/cron');
  const from = Date.UTC(2026, 9, 14, 10, 0, 0); // 15:30 in Kolkata
  const fmt = (e, tz, n = 3) => cron.nextRuns(e, { from, tz, count: n }).map((t) => cron.formatInstant(t, tz));
  assert.deepEqual(fmt('0 2 * * *', 'Asia/Kolkata', 2), ['2026-10-15 02:00 Thu', '2026-10-16 02:00 Fri']);
  assert.deepEqual(fmt('*/20 * * * *', 'UTC', 2), ['2026-10-14 10:20 Wed', '2026-10-14 10:40 Wed']);
  assert.deepEqual(fmt('0 9 * * mon-fri', 'UTC', 3), ['2026-10-15 09:00 Thu', '2026-10-16 09:00 Fri', '2026-10-19 09:00 Mon']);
  assert.deepEqual(fmt('0 0 13 * fri', 'UTC', 2), ['2026-10-16 00:00 Fri', '2026-10-23 00:00 Fri']); // either day matches
  assert.deepEqual(fmt('0 2 * * 7', 'UTC', 1), ['2026-10-18 02:00 Sun']); // 7 = Sunday
  assert.deepEqual(cron.nextRuns('0 0 30 2 *', { from, count: 1 }), []);
  assert.match(cron.validate('61 * * * *'), /out of range/);
  assert.match(cron.validate('* * * *'), /5 fields/);
  assert.equal(cron.validate('*/5 0-6 1,15 jan-mar *'), null);
});
