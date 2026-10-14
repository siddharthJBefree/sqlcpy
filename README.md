# sqlcpy

Interactive terminal tool (npkill-style) that copies MySQL **tables, views, stored procedures, functions and triggers** from a *master* database to a *slave* database — in small chunks so the master never hangs.

## Features

- Lists every object section by section with live sync status (✔ in sync · ≠ differs · ✖ missing · • only in slave)
- Skips objects that are already identical (schema + row count + checksum for tables up to 50 MB)
- `space` copies the selected object; copies are queued and run one at a time
- Tables larger than ~1 MB are split into ~1 MB chunks (keyset pagination on the primary key) with a short pause between chunks
- Writes a `.sql` dump of every copied object to `dumps/<database>/`
- Docker-pull style progress: bar, rows, chunk n/N, speed, ETA
- Policy file: ignore tables, keep sensitive data on the master, copy only the latest rows of huge tables (see [Policy file](#policy-file))

## Install

```bash
cd backup-script
npm install
npm link        # makes the `sqlcpy` command available globally
```

Without linking you can always run `npm start` (or `node bin/sqlcpy.js`) from the project folder.

## Build a standalone Linux binary

The binary includes the Node.js runtime and project dependencies, so Node.js and npm
are not needed on the QA server. Build it from the project directory on a machine with
Node.js and npm installed:

```bash
npm install
npm run build:linux-x64
```

This creates `dist/sqlcpy-linux-x64` for Linux x86_64/amd64. Copy it to the QA server,
then make it executable if needed:

```bash
chmod +x sqlcpy-linux-x64
./sqlcpy-linux-x64
./sqlcpy-linux-x64 run-once path/to/.env
./sqlcpy-linux-x64 daemon path/to/.env
```

Keep `.env` and `sqlcpy.config.jsonc` outside the binary. By default sqlcpy reads them
from the current working directory; pass an env-file path as shown above or use
`CONFIG_FILE` to point to the policy file. The server must be Linux x86_64 with glibc
(Alpine/musl is not supported by this target).

## Build a standalone Windows binary

Build the Windows x64 executable from the project directory on a machine with Node.js
and npm installed:

```powershell
npm install
npm run build:windows-x64
```

This creates `dist/sqlcpy-win-x64.exe` for Windows x64. Copy the executable to the QA
server and run it from the directory containing `.env` and `sqlcpy.config.jsonc`:

```powershell
.\sqlcpy-win-x64.exe
.\sqlcpy-win-x64.exe run-once .\.env
.\sqlcpy-win-x64.exe daemon .\.env
```

Keep `.env` and `sqlcpy.config.jsonc` outside the executable. Both standalone targets
include Node.js and do not require it to be installed on the server.

## Build standalone macOS binaries

Build the executable for your Mac architecture from the project directory on a machine
with Node.js and npm installed. Build both architectures with:

```bash
npm install
npm run build:macos
```

Or build only one target:

```bash
npm run build:macos-x64     # Intel Macs
npm run build:macos-arm64   # Apple Silicon (M1/M2/M3/M4)
```

The executables are written to `dist/sqlcpy-macos-x64` and
`dist/sqlcpy-macos-arm64`. Copy the matching executable and your external `.env` and
`sqlcpy.config.jsonc` files to the Mac. Because cross-built macOS executables are not
signed on this build machine, ad-hoc sign the executable on the Mac before its first run:

```bash
codesign --force --sign - ./sqlcpy-macos-arm64
chmod +x sqlcpy-macos-arm64
./sqlcpy-macos-arm64 run-once ./.env
```

Replace the filename with `sqlcpy-macos-x64` for an Intel Mac. The macOS executables
bundle Node.js; Node.js and npm are not needed on the target Mac.

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
DB_TYPE=mysql           # engine; master and slave must be the same type (mysql, mariadb)
CHUNK_BYTES=1048576     # target size of each chunk
CHUNK_DELAY_MS=100      # pause between chunks
CHECKSUM_MAX_MB=50      # skip CHECKSUM TABLE above this size
CONCURRENCY=1           # chunks downloaded/inserted in parallel per table, whole number 1-10
DUMP_DIR=./dumps
CONFIG_FILE=./sqlcpy.config.jsonc   # policy file (default shown); must exist if you set it
MASK_SALT=some-long-random-string   # required only if the policy uses "hash" masking
```

A different env file can be passed as the first argument: `sqlcpy path/to/.env`.

## Read-only master user

The master connection must be read-only. On scan, sqlcpy runs `SHOW GRANTS` and refuses to continue if the
master user holds anything beyond `SELECT`, `SHOW VIEW`, `TRIGGER`, `EXECUTE` (and `USAGE`/`PROCESS`/`SHOW DATABASES`).

```sql
CREATE USER 'backup_user'@'%' IDENTIFIED BY 'change_me';
GRANT SELECT, SHOW VIEW, TRIGGER, EXECUTE ON your_database.* TO 'backup_user'@'%';
FLUSH PRIVILEGES;
```

Then set `master.user` / `master.password` to that user. (`TRIGGER` and `EXECUTE` are only needed to read
trigger and routine definitions; drop them if you don't copy those.)

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
sqlcpy daemon [path/to/.env]     # stays running, fires on "cron" (run under pm2 / systemd / a Windows service)
sqlcpy run-once [path/to/.env]   # one pass, exit code 0 ok · 1 error · 2 a table failed (for OS cron / Task Scheduler)
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

Copying a table **drops and recreates it on the slave** (foreign key checks are disabled during the copy). Double-check `SLAVE_*` before pressing `space`.

## License

[MIT](LICENSE.md)
