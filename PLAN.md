# sqlcpy – plan

Goal: interactive terminal tool (npkill-style) that copies database objects from a **master** DB to a **slave** DB, safely and in small chunks.

**Scope rule:** master and slave are always the **same engine** (`DB_TYPE`). No cross-engine copy, so no type mapping or DDL translation – master's DDL replays verbatim on slave.

Legend: ✅ done · 🚧 in progress · 📋 planned · 🔮 later / optional · ⚠️ risk / watch-out

---

## 🗺️ Roadmap at a glance

| Phase | What | Status |
|---|---|---|
| 0.x | MySQL / MariaDB copy tool + TUI | ✅ Done |
| 1 | Driver contract refactor (no new DB) | 📋 Next |
| 2 | PostgreSQL + SQLite | 📋 Planned |
| 3 | SQL Server + Oracle | 📋 Planned |
| 4 | IBM Db2 | 📋 Planned |
| 5 | Snowflake + Databricks (+ clone fast path) | 🔮 Later |
| 6 | MongoDB + Redis (document / kv family) | 🔮 Later |

---

## ✅ Achieved so far (v0.1.0)

### Core copy engine
- ✅ Scan master and slave, compare objects one at a time (gentle on master)
- ✅ Object kinds: tables, views, stored procedures, functions, triggers
- ✅ Status per object: in sync / differs / missing in slave / only in slave / queued / copying / error
- ✅ Compare = normalized DDL + `COUNT(*)` + `CHECKSUM TABLE` (tables up to `CHECKSUM_MAX_MB`)
- ✅ Table copy: `SHOW CREATE TABLE` → local dump `dumps/<db>/<table>.sql` → applied to slave in ~1 MB keyset-paginated chunks
- ✅ Throttling: pause between chunks (`CHUNK_DELAY_MS`) so master never stalls
- ✅ Parallel chunk workers (`CONCURRENCY` 1–10) for keyed tables
- ✅ Keyless tables fall back to `LIMIT/OFFSET`
- ✅ Slave session relaxes FK / unique checks during load, restored afterwards
- ✅ DEFINER, db qualifiers and `AUTO_INCREMENT` stripped so definitions are comparable and portable
- ✅ Cancel whole queue (`x`) or one item (`c`); re-compare after copy
- ✅ Friendly connection error hints (`src/errors.js`)

### Architecture
- ✅ Engine-specific code isolated behind a driver contract (`src/drivers/`)
- ✅ `DB_TYPE` selects the driver; `mariadb` aliases `mysql`
- ✅ Library class `SqlCpy` (EventEmitter) usable without the TUI

### Terminal UI
- ✅ Sections with cursor, sticky status and docker-pull style progress
- ✅ Sort by name / master rows / slave rows / size / status, toggle direction
- ✅ Text filter (`/`) and status filter (`v`)
- ✅ Log view with level filter, text filter, sort (newest / oldest / level), clear
- ✅ Per-item log (`e`) – log entries tagged with the item they belong to
- ✅ Scan cache – instant startup from `.sqlcpy-cache.json`, `R` rescan all, `r` rescan one
- ✅ Distinct status symbols (`●` `◐` `○` `◇` `◆` `▲`) and relative time ("just now")
- ✅ SCOPE column (`schema only` / `masked` / `30d`), `· N ignored` in the header, policy + stale-dump warnings in the log

### Policy file (`sqlcpy.config.jsonc`)
- ✅ `ignore` – glob patterns; hidden from scan, compare and copy (triggers on ignored tables too)
- ✅ `sensitive.tables` – structure only; **no row is ever selected** (nothing in slave, dumps or on the client)
- ✅ `sensitive.columns` – `null` / `empty` / salted `hash`, computed by the master inside the `SELECT` (raw value never fetched); masked columns excluded from the sync check
- ✅ `range` – only the latest rows (`last: 12h|7d|2w|1m|1y` or `since`); paging by `(range column, pk)` so the time index drives it; refuses unindexed columns unless `allowUnindexed`
- ✅ Sync semantics: range table is **in sync when every master row inside the range is on the slave** (count + order-independent digest over the range; masked columns skipped)
- ✅ Fail closed: strict schema (unknown keys error), column / type / index validation before anything on the slave is touched, typo'd table names warned, cache invalidated when the policy changes
- ✅ Stale dumps written before a table was protected are flagged (never auto-deleted)
- 🔮 Range on integer epoch columns (`unix` / `unix_ms`); "latest N rows" ranges; per-column `format`-preserving masks (emails, phone numbers)
- ⚠️ Slave timezone: range cut-offs are compared in each session's time zone; fine when both servers share one (as today's copy already assumes for `TIMESTAMP`)

---

## ⚙️ Config (.env)

`MASTER_*` and `SLAVE_*` (HOST, PORT, USERNAME, PASSWORD, DATABASE), plus `DB_TYPE` (default `mysql`).

| Option | Default | Notes |
|---|---|---|
| `CHUNK_BYTES` | 1048576 | target bytes per chunk |
| `CHUNK_DELAY_MS` | 100 | pause between chunks |
| `CHECKSUM_MAX_MB` | 50 | skip checksum above this size |
| `CONCURRENCY` | 1 | must be 1–10 |
| `DUMP_DIR` | ./dumps | local dump output |
| `CACHE_FILE` | `<DUMP_DIR>/.sqlcpy-cache.json` | scan cache |
| `CONFIG_FILE` | `./sqlcpy.config.jsonc` | policy file; optional, but an explicitly set path must exist |
| `MASK_SALT` | – | required when the policy uses `"hash"` masking |

## 🏗️ Architecture

| file | job |
|---|---|
| `src/config.js` | read .env, validate, load the policy |
| `src/rules.js` | policy file: JSONC parse, strict validation, glob matching, per-table rule lookup |
| `src/scope.js` | turn a table's rule into SQL (select list, range `WHERE`, paging order), validated against the live schema |
| `src/drivers/` | one module per engine (`mysql.js`): pool, quoting, list objects, DDL, PK, count/checksum, session setup. Selected by `DB_TYPE` |
| `src/objects.js` | object kinds + labels |
| `src/compare.js` | decide in-sync / different / missing / extra (scope-aware: range, masked, schema-only) |
| `src/copier.js` | dump + copy one object; tables use keyset-paginated chunks with a pause between chunks |
| `src/errors.js` | map driver errors to readable messages |
| `src/index.js` | `SqlCpy` library class – scan(), copy(), compare() |
| `src/ui.js` | TUI: sections, cursor, status, progress, log view |
| `bin/sqlcpy.js` | CLI entry |

## ⌨️ Keys

| Key | Action |
|---|---|
| `↑/↓` `j/k` · `PgUp/PgDn` · `Home/End` | move |
| `←/→` `Tab` | jump section |
| `space` | copy selected (queued) – in-sync objects are skipped |
| `f` | force copy |
| `a` | copy all out-of-sync |
| `x` / `c` | cancel queue / cancel selected |
| `R` / `r` | rescan all / rescan selected |
| `s` / `S` | cycle sort column / flip direction |
| `/` | text filter |
| `v` | cycle status filter · `esc` clears filters |
| `l` / `e` | log view / log for selected item |
| `q` | quit |

---

## 🚀 Roadmap – multi-database support

Target engines: Oracle, MySQL ✅, SQL Server, PostgreSQL, MongoDB, Snowflake, Databricks, Redis, IBM Db2, SQLite.

### 📋 Phase 1 – Driver contract refactor (no new DB, MySQL must pass unchanged)

MySQL assumptions still leak out of the driver into `copier.js`, `compare.js` and `config.js`. They must move behind the driver first:

| Leak | Becomes |
|---|---|
| `?` placeholders and `[rows, fields]` result shape | normalizing query wrapper |
| `LIMIT n OFFSET m` | `driver.pageSql()` |
| Row-value keyset `(a,b) > (?,?)` | portable expansion or `driver.keysetWhere()` |
| JS-built multi-row `INSERT`, `MAX_STATEMENT_BYTES` tuned to `max_allowed_packet` | `driver.buildInserts()` |
| `database` only, no schema | `SCHEMA` (+ catalog for Databricks) and qualified names |
| Hard-coded `host` / `user` required | `driver.configFields` / `driver.validateConfig()` |
| Eager `require` of every driver | lazy `require` (users don't need Oracle / Db2 native libs for MySQL) |
| `getConnection()` / `.release()` assumed | wrapper that fakes a pool for single-connection engines |
| "Is MySQL running?" in `errors.js` | per-driver error hints |

Also in this phase:
- 📋 `driver.serverVersion()` + UI warning when master and slave **major versions differ** (⚠️ same engine ≠ same version; replayed DDL can fail or change behaviour)
- 📋 `docker-compose` with every engine and a copy-and-compare smoke test per driver (there are no tests today)
- 📋 Per-engine label set in `objects.js` (needed later for collections / keyspaces)

### 📋 Phase 2 – PostgreSQL + SQLite
- 📋 **PostgreSQL** (`pg`): DDL rebuilt from `pg_catalog` (no `pg_dump` dependency); FK relax via `session_replication_role=replica` (needs superuser, fall back to warning); checksum via `md5(string_agg(...))`
- 📋 **SQLite** (`better-sqlite3`): DDL from `sqlite_master.sql`; single connection so concurrency forced to 1; `PRAGMA foreign_keys`; row hash computed in JS; config is a file path (no host/user)

### 📋 Phase 3 – SQL Server + Oracle
- 📋 **SQL Server** (`mssql`): no row-value comparison; table DDL rebuilt from `sys.*` (views/procs via `sp_helptext`); FK relax per table (`NOCHECK CONSTRAINT`); `IDENTITY_INSERT`; checksum via `CHECKSUM_AGG(BINARY_CHECKSUM(*))`
- 📋 **Oracle** (`oracledb` thin mode): `DBMS_METADATA.GET_DDL` with transform params stripping storage / owner / segment clauses; `FETCH FIRST` paging, `:n` binds, no multi-row `INSERT`; per-constraint disable

### 📋 Phase 4 – IBM Db2
- 📋 `ibm_db` (native addon, large CLI driver download – awkward on Windows); DDL from `SYSCAT` reconstruction

### 🔮 Phase 5 – Snowflake + Databricks
- 🔮 Generic row copy first (`snowflake-sdk`, `@databricks/sql`); DDL via `GET_DDL()` / `SHOW CREATE TABLE`
- 🔮 ⚠️ Row-by-row `INSERT` is slow and PKs are not enforced – keyless `OFFSET` paging is fragile
- 🔮 **Clone fast path** when master and slave share an account / workspace: Snowflake `CLONE` or stage + `COPY`; Databricks `DEEP CLONE` / CTAS. Opt-in via env var (bypasses chunked, throttled behaviour)
- 🔮 Databricks: token auth, Unity Catalog three-part names, smaller `kinds` set

### 🔮 Phase 6 – MongoDB + Redis (document / kv family)
Not SQL-shaped (no DDL, `INSERT`, PK ranges or `.sql` dumps), so they get a separate driver `family: 'sql' | 'document' | 'kv'` and a copier / compare strategy per family.
- 🔮 **MongoDB** (`mongodb`): unit = collection; cursor + `bulkWrite` in batches, indexes recreated; raw BSON / canonical EJSON to preserve types; NDJSON dump; compare = count + index set + hash
- 🔮 **Redis** (`ioredis`): unit = key; `SCAN` + `DUMP`/`RESTORE` preserving TTL (valid because same-engine); compare = key count + per-key digest

### 🧩 Per-engine checklist (every new driver)
1. `src/drivers/<engine>.js` implementing the contract at the top of `mysql.js`
2. Register in `src/drivers/index.js`
3. Add npm dependency (prefer `optionalDependencies` + lazy require)
4. Error hints in `src/errors.js`
5. `.env` example + README section
6. Docker smoke test (copy → compare reports "in sync")

---

## ❓ Open decisions
- 📌 Clone fast paths (Phase 5): default-on when detected, or opt-in? **Recommendation: opt-in.**
- 📌 PostgreSQL DDL: catalog reconstruction (self-contained) vs `pg_dump` (higher fidelity, external binary). **Recommendation: catalog reconstruction.**
- 📌 Native-addon engines (`better-sqlite3`, `ibm_db`): ship as optional dependencies so a failed build doesn't break `npm install`.
