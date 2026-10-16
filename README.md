# sqlcpy

Interactive terminal tool (npkill-style) that copies **tables, views, stored procedures, functions and triggers** from a *master* database to a *slave* database — in small chunks so the master never hangs. Works with **MySQL / MariaDB** and **PostgreSQL** (master and slave must be the same engine).

## Features

- Lists every object section by section with live sync status (✔ in sync · ≠ differs · ✖ missing · • only in slave)
- Skips objects that are already identical (schema + row count + checksum for tables up to 50 MB)
- `space` copies the selected object; copies are queued and run one at a time
- Tables larger than ~1 MB are split into ~1 MB chunks (keyset pagination on the primary key) with a short pause between chunks
- Writes a `.sql` dump of every copied object to `dumps/<database>/`
- Docker-pull style progress: bar, rows, chunk n/N, speed, ETA
- Policy file: ignore tables, keep sensitive data on the master, copy only the latest rows of huge tables (see [Policy file](#policy-file))

## Install and run

```bash
npm install
npm start                 # interactive terminal UI
npm run daemon            # unattended, follows schedule.cron (see Scheduled runs)
npm run run-once          # one scheduled pass, then exit
```

Everything is started through npm; there is no global command. To use another env file, pass it after `--`: `npm start -- path/to/.env`.

## Configure

Create a `.env` in the directory you run `sqlcpy` from:

```env
MASTER_HOST=10.10.20.41
MASTER_PORT=3306
MASTER_USERNAME=dev
MASTER_PASSWORD=secret
MASTER_DATABASE=bdms

SLAVE_HOST=localhost
SLAVE_PORT=3307
SLAVE_USERNAME=dev
SLAVE_PASSWORD=secret
SLAVE_DATABASE=bdms

# optional
DB_TYPE=mysql           # engine; master and slave must be the same type (mysql, mariadb, postgres)
CHUNK_BYTES=1048576     # target size of each chunk
CHUNK_DELAY_MS=100      # pause between chunks
CHECKSUM_MAX_MB=50      # skip the data checksum above this size
CONCURRENCY=1           # chunks downloaded/inserted in parallel per table, whole number 1-10
DUMP_DIR=./dumps
CONFIG_FILE=./sqlcpy.config.jsonc   # policy file (default shown); must exist if you set it
MASK_SALT=some-long-random-string   # required only if the policy uses "hash" masking
```

A different env file can be passed after `--`: `npm start -- path/to/.env`.

For PostgreSQL set `DB_TYPE=postgres` (`postgresql` / `pg` also work); the port defaults to 5432 and these extras apply:

```env
DB_TYPE=postgres
MASTER_PORT=5432
MASTER_SCHEMA=public    # schema to copy (default: public); master and slave schemas may differ
MASTER_SSL=true         # true = encrypted + verified, no-verify = encrypted, certificate not checked (default: off)
SLAVE_SCHEMA=public
SLAVE_SSL=true
```

See [PostgreSQL](#postgresql) for what is copied and what is not.

## Read-only master user

The master connection must be read-only. On scan, sqlcpy runs `SHOW GRANTS` and refuses to continue if the
master user holds anything beyond `SELECT`, `SHOW VIEW`, `TRIGGER`, `EXECUTE` (and `USAGE`/`PROCESS`/`SHOW DATABASES`).

```sql
CREATE USER 'backup_user'@'%' IDENTIFIED BY 'change_me';
GRANT SELECT, SHOW VIEW, TRIGGER, EXECUTE ON your_database.* TO 'backup_user'@'%';
-- required to read stored procedure / function bodies (MySQL 8.0.20+, global-only privilege)
GRANT SHOW_ROUTINE ON *.* TO 'backup_user'@'%';
FLUSH PRIVILEGES;
```

Then set `master.user` / `master.password` to that user. (`TRIGGER` and `EXECUTE` are only needed to read
trigger and routine definitions; drop them if you don't copy those.)

On PostgreSQL a read-only user needs `USAGE` on the schema and `SELECT` on its tables — definitions are read from the catalogs, which every user can see:

```sql
CREATE ROLE backup_user LOGIN PASSWORD 'change_me';
GRANT CONNECT ON DATABASE your_database TO backup_user;
GRANT USAGE ON SCHEMA public TO backup_user;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO backup_user;
```

(Function and procedure bodies are visible to any user who can see the function. If the guard is enabled it rejects a master user that is a superuser or holds `INSERT`/`UPDATE`/`DELETE`/`TRUNCATE` on any table in the schema.)

## PostgreSQL

Supported: PostgreSQL 12 or newer, copied between two databases (or two schemas) on the same engine. There is no `pg_dump` dependency: definitions are rebuilt from the system catalogs.

PostgreSQL also lists two kinds that must exist before the tables that use them, so copy these sections first (they are shown first):
- **Types** – enums, domains, composite and range types. An enum that already exists on the slave is updated in place (missing labels are added), so a new label reaches tables that use it; the other types are dropped and re-created, which fails if a table on the slave uses them.
- **Sequences** – free-standing sequences only (those behind `serial` / identity columns come with their table). The slave sequence is aligned in place and moved to the master's current position; the position itself is not part of the comparison.

Extensions (`CREATE EXTENSION`) are not copied: install the ones the master uses on the slave server yourself.

**What is copied** — tables (columns, defaults, `serial` / identity / generated columns, primary / unique / check / foreign-key / exclusion constraints, indexes, comments, `UNLOGGED`, storage options, and partitioned tables with their partitions), views, functions, procedures and triggers. Row data is moved as text, exactly as the server prints it (the integration tests cover arrays, `jsonb`, `bytea`, numerics, dates and timestamps with microseconds, unicode, quotes and backslashes). Sequences are moved past the loaded rows so new inserts on the slave do not collide.

**How it behaves**

- Objects live in `*_SCHEMA`; every connection pins `search_path` to it, so definitions are copied without schema names and master / slave schemas can differ. Names that need it are shown as `table.trigger` (triggers) and `name(arguments)` (overloaded functions / procedures).
- All sessions are pinned to `UTC`, ISO dates and exact float printing, so master and slave data checksums compare like with like. `range` cut-offs are therefore evaluated in UTC.
- Foreign keys: loads run with `session_replication_role = replica` so rows can arrive in any order. That needs a superuser (or `GRANT SET ON PARAMETER session_replication_role`); without it the load still works, but a child must then be copied **after** its parent. A table's own definition still needs the tables it references to exist, so copy parents first (a *copy all* pass may take a second round for deeply linked schemas).
- Copying a table drops and recreates it. Foreign keys from other tables and views built on it (also through other views) are detached first and put back afterwards: the keys come back `NOT VALID` (a `range`, masked or schema-only parent can legitimately leave child rows without a parent), and a view or key that no longer fits is skipped with a server warning and then shows as *missing* / *differs*. Nothing is dropped with `CASCADE`, so anything else that depends on the table (a materialized view, say) makes the copy fail with a message instead of being lost.
- Data checksum: there is no `CHECKSUM TABLE`, so an order-independent md5 digest of every column is compared instead (same size limit, `CHECKSUM_MAX_MB`).
- Sensitive-column masking works as on MySQL, with the replacement computed by the master inside the `SELECT`. It supports text, numeric and date/time columns; other types (`boolean`, `uuid`, `json` ...) can only be masked with `null`. `hash` is the SHA-256 (hex) of the salt plus the value.

**Not copied** (create these on the slave first / separately): extensions and the types they provide, custom types (`CREATE TYPE ... AS ENUM`, composites, domains), standalone sequences used in column defaults, materialized views, table inheritance (`INHERITS`), row-level-security policies, grants, ownership, tablespaces, and objects in other schemas. Objects that belong to an extension (for example PostGIS tables and functions) are ignored.

`atomicSwap` is not available on PostgreSQL (index and constraint names are schema-wide, so a temporary copy cannot be built beside the original); tables are dropped and recreated, and the schedule log says so.

**Tests.** `node --test test/*.test.js` runs the unit tests. `test/postgres.integration.test.js` needs a server and is skipped unless `SQLCPY_TEST_PG` is set (it creates and drops the databases `sqlcpy_it_master` / `sqlcpy_it_slave`):

```bash
docker run -d --name pgtest -e POSTGRES_PASSWORD=pw -p 55432:5432 postgres:17
SQLCPY_TEST_PG=postgres://postgres:pw@127.0.0.1:55432 node --test test/postgres.integration.test.js
```

## Policy file

`sqlcpy.config.jsonc` (comments allowed; see [sqlcpy.config.example.jsonc](sqlcpy.config.example.jsonc)) decides **what is allowed to leave the master**. Without it everything is copied in full, as before.

```jsonc
{
  "ignore": ["tmp_*", "*_bak"],                       // not listed, compared or copied at all
  "sensitive": {
    "tables":  ["oauth_tokens"],                      // structure only – no row is ever read
    "columns": {
      "users": {
        "email": "hash",
        "display_name": { "from": "first_name" },
        "password": {
          "concat": [
            { "column": "first_name" },
            "@123",
            { "column": "last_name" }
          ]
        },
        "nickname": { "value": "Sample User" },
        "phone": "random"
      }
    }
  },
  "range": {
    "audit_log": { "column": "created_at", "last": "1m" }   // only the latest month
  }
}
```

| rule | what happens | status / SCOPE column |
|---|---|---|
| `ignore` | hidden: never compared, copied or dropped (triggers on an ignored table too) | counted in the header (`· 3 ignored`) |
| `sensitive.tables` | table structure copied; **no `SELECT` of its rows is ever issued** – nothing in the slave, `dumps/` or on this machine | `schema only`; in sync when the definitions match |
| `sensitive.columns` | the master computes the replacement inside the `SELECT`, so the original value never leaves the server | `masked`; masked columns are left out of the sync check |
| `range` | only rows with `column` ≥ cut-off are copied (`last`: `12h` `7d` `2w` `1m` `1y`, or fixed `since`) | `30d`, `≥2026-01-01`; **in sync = every master row inside the range is on the slave, unchanged** (older rows are ignored). The table list shows whole-table estimates and a scoped row beneath it with in-range counts, estimated size, and status. |

Good to know:

- **Fail closed.** Unknown keys, bad durations, `hash` without `MASK_SALT`, masking a column that does not exist, masking a primary key, or a range on a non-date / unindexed column all refuse to run (config error, or that table shows `error` and is not copied). A sensitive rule naming a table that does not exist is flagged in the log.
- Column replacements can be `null`, `empty`, salted `hash`, or `random`; use `{ "value": "fixed value" }` for a custom literal, `{ "from": "other_column" }` to take a compatible, unmasked non-key column's value, or `{ "concat": [{ "column": "first_name" }, "@123", { "column": "last_name" }] }` to combine text columns and static text. Concatenation parts are quoted/escaped and never treated as SQL. Add `"maxLength": 100` next to `concat` to cap the result: anything beyond that many characters is trimmed on the master (`LEFT(CONCAT(...), 100)`), so a long name can no longer overflow the column. Values and derived columns are type-checked. Random replacements are pseudo-random text or a number from 0 to 9; replacements other than `hash` can collide with `UNIQUE` indexes, so use a suitable deterministic hash or unique-safe values when needed.
- **Range tables hold only the range** on the slave: a copy drops and recreates the table, as always. The cut-off is evaluated once on the master and the same instant is used for both sides.
- **A range needs an index** on its column on the master (paging is `ORDER BY column, pk`; a composite index that *starts* with the column counts). Without one every chunk would scan and sort the whole table, so sqlcpy refuses instead and the table shows `error`. The preferred fix is to add the index, e.g. `CREATE INDEX idx_audit_log_created_at ON audit_log (created_at);`. If you accept the full scans (small table, off-hours or replica, schema can't change), opt out per table with `"allowUnindexed": true`:

  ```jsonc
  "range": {
    "import_batches": { "column": "imported_at", "last": "90d", "allowUnindexed": true }
  }
  ```

  It is optional, defaults to `false`, applies to that table only, and must be the literal `true` (the string `"true"` counts as `false`).
- **Stale dumps.** Dumps written *before* a table was protected still hold real rows. sqlcpy warns about them in the log (it never deletes files); dumps written under a rule start with a `-- scope:` line.
- The `hash` salt is sent to the master inside the `SELECT`; it is meant to stop dictionary attacks on the copy, not to hide data from people who already have the master.
- Changing the policy file invalidates the scan cache automatically.
- In the interactive CLI, saving `sqlcpy.config.jsonc` reloads the policy and rescans automatically. Invalid edits are reported in the log and the last valid config stays active; edits are applied after any current copy finishes.

## Scheduled runs (unattended)

Add a `schedule` block to `sqlcpy.config.jsonc` (cron syntax as on [crontab.guru](https://crontab.guru)):

```jsonc
"schedule": {
  "cron": "0 2 * * *",                       // every day at 02:00
  "timezone": "Asia/Kolkata",                // optional, default: server local time
  // "tables": ["user", "hr_*"],             // optional; omit = every table the other rules allow
  "skipIfUnchanged": false,                  // false = always reload, so QA edits to old rows are picked up
  "atomicSwap": false                        // true = load a temp table, then RENAME over the old one
}
```

```
npm run daemon [-- path/to/.env]     # stays running, fires on "cron" (run under pm2 / systemd / a Windows service)
npm run run-once [-- path/to/.env]   # one pass, exit code 0 ok · 1 error · 2 a table failed (for OS cron / Task Scheduler)
```

- No terminal is needed. Each run re-reads the config file and logs to `<DUMP_DIR>/sqlcpy-schedule.log`.
- Without `tables`, a run covers every table the rest of the file allows: `ignore`d tables are skipped, and `sensitive` / `range` rules scope what is copied. Add `tables` only to narrow a run.
- Scheduled tables are processed and shown alphabetically by table name.
- `ignore`, `sensitive` and `range` rules apply exactly as in the interactive tool. A `range` table only refreshes rows inside its range, so widen it if QA edits older rows.
- A run that is still going makes the next tick skip. A failing table is logged and the others continue.
- `skipIfUnchanged: true` compares first and copies only what differs; for tables above `CHECKSUM_MAX_MB` it compares row counts only, so an edit that keeps the count is missed. Leave it `false` if QA edits existing rows.
- `atomicSwap: true` avoids a window with a missing table but needs room for two copies; tables with foreign keys fall back to drop + recreate.
- Scheduled runs never touch the interactive scan cache.

**Testing the schedule.** In the interactive UI press `t` for the schedule screen:

| key | action |
|---|---|
| `e` | type any cron expression and watch the next run times update live (preview only, nothing is saved) |
| `c` | back to the cron from the config file |
| `tab` | switch the arrow keys between the tables and the scheduler log (both scroll) |
| `g` then `y` | run the schedule right now, exactly as a cron tick would |
| `esc` / `t` | back |

## Keys

| key | action |
|---|---|
| `↑` `↓` / `j` `k` | move |
| `←` `→` / `tab` | jump between sections |
| `s` / `S` | cycle sort column (name, master rows, slave rows, size, status) / reverse direction |
| `space` | copy selected object (skipped if already in sync) |
| `a` | copy everything that differs or is missing |
| `f` | force copy, even if in sync |
| `x` | cancel current copy and clear queue |
| `R` / `r` | rescan all / rescan selected |
| `q` | quit |

## Library use

```js
const { SqlCpy, loadConfig } = require('sqlcpy');
const app = new SqlCpy(loadConfig());
await app.scan();                       // lists + compares
const t = app.items.find(i => i.name === 'orders');
await app.copy(t, { onProgress: console.log });
await app.close();
```

## Warning

Copying a table **drops and recreates it on the slave** (foreign key checks are disabled during the copy; on PostgreSQL see the notes above). Double-check `SLAVE_*` before pressing `space`.

## License

[MIT](LICENSE.md)
