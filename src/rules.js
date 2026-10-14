'use strict';
const fs = require('fs');
const crypto = require('crypto');

/**
 * Policy file (sqlcpy.config.jsonc): what to ignore, what must never leave the master, what to copy only partially.
 *
 *   {
 *     "ignore": ["tmp_*", "*_bak"],                       // not listed, compared or copied at all
 *     "sensitive": {
 *       "tables":  ["oauth_tokens"],                      // structure only – no row is ever read from the master
 *       "columns": { "users": { "password": "empty", "email": "hash" } }   // replaced ON the master, in the SELECT
 *     },
 *     "range": {
 *       "audit_log": { "column": "created_at", "last": "30d" }             // only the latest rows
 *     }
 *   }
 *
 * The file is validated strictly (unknown keys are errors): a typo must never silently copy a sensitive table.
 */

const MASK_MODES = ['null', 'empty', 'hash', 'random'];
const UNITS = {
  h: ['HOUR', 'h'], hour: ['HOUR', 'h'], hours: ['HOUR', 'h'],
  d: ['DAY', 'd'], day: ['DAY', 'd'], days: ['DAY', 'd'],
  w: ['WEEK', 'w'], week: ['WEEK', 'w'], weeks: ['WEEK', 'w'],
  m: ['MONTH', 'm'], month: ['MONTH', 'm'], months: ['MONTH', 'm'],
  y: ['YEAR', 'y'], year: ['YEAR', 'y'], years: ['YEAR', 'y'],
};
const SINCE_RE = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/;

class ConfigError extends Error {
  constructor(msg) {
    super(msg);
    this.hint = 'Fix the config file, or point CONFIG_FILE in .env at another one';
  }
}

/** Remove // and /* *\/ comments, leaving string contents alone. */
function stripComments(text) {
  let out = '';
  for (let i = 0; i < text.length;) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

/** Table-name glob (* and ?), case-insensitive: over-matching is the safe direction for a protection rule. */
function globToRegExp(pattern) {
  const body = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${body}$`, 'i');
}

function parseLast(value, where, problems) {
  const m = /^(\d+)\s*([a-z]+)$/i.exec(String(value).trim());
  const unit = m && UNITS[m[2].toLowerCase()];
  if (!m || !unit || Number(m[1]) < 1) {
    problems.push(`${where}.last: "${value}" is not a duration – use e.g. "30d", "1w", "1m" (month), "12h", "1y"`);
    return null;
  }
  return { amount: Number(m[1]), unit: unit[0], label: `${m[1]}${unit[1]}`, text: `last ${m[1]}${unit[1]}` };
}

function checkKeys(obj, allowed, where, problems) {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) problems.push(`${where}: unknown key "${k}" (allowed: ${allowed.join(', ')})`);
  }
}

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** "schedule" block: when to run unattended and which tables to refresh. Returns the normalized object or null. */
function parseSchedule(s, problems) {
  if (!isObject(s)) { problems.push('schedule: must be an object with "cron" and "tables"'); return null; }
  checkKeys(s, ['cron', 'timezone', 'tables', 'skipIfUnchanged', 'atomicSwap'], 'schedule', problems);
  const before = problems.length;
  if (typeof s.cron !== 'string' || s.cron.trim().split(/\s+/).length !== 5) {
    problems.push('schedule.cron: required – a 5-field crontab expression such as "0 2 * * *" (see https://crontab.guru)');
  } else {
    const why = require('./cron').validate(s.cron);
    if (why) problems.push(`schedule.cron: "${s.cron}" – ${why} (see https://crontab.guru)`);
    else if (!require('node-cron').validate(s.cron)) problems.push(`schedule.cron: "${s.cron}" is not accepted by the scheduler – use plain numbers, ranges, lists and steps`);
  }
  if (s.timezone !== undefined) {
    let ok = typeof s.timezone === 'string' && s.timezone;
    if (ok) { try { new Intl.DateTimeFormat('en', { timeZone: s.timezone }); } catch (e) { ok = false; } }
    if (!ok) problems.push(`schedule.timezone: "${s.timezone}" is not an IANA time zone such as "Asia/Kolkata" or "UTC"`);
  }
  if (s.tables !== undefined && (!Array.isArray(s.tables) || !s.tables.length || s.tables.some((x) => typeof x !== 'string' || !x))) {
    problems.push('schedule.tables: optional – leave it out to refresh every table the other rules allow, or give a non-empty list of names / patterns (e.g. ["user", "hr_*"])');
  }
  for (const k of ['skipIfUnchanged', 'atomicSwap']) {
    if (s[k] !== undefined && typeof s[k] !== 'boolean') problems.push(`schedule.${k}: must be true or false`);
  }
  if (problems.length > before) return null;
  return {
    cron: s.cron.trim().replace(/\s+/g, ' '),
    timezone: s.timezone || null,
    allTables: s.tables === undefined, // no list: every table that "ignore" lets through, scoped by "sensitive" / "range"
    tables: (s.tables === undefined ? ['*'] : s.tables).map((p) => ({ pattern: p, re: globToRegExp(p) })),
    skipIfUnchanged: s.skipIfUnchanged === true, // false: always reload, so edits to old rows are picked up
    atomicSwap: s.atomicSwap === true,           // true: load into a temp table, then RENAME – no moment without the table
  };
}

class Rules {
  /** @param {object} spec parsed policy  @param {string|null} file where it came from (null = no policy) */
  constructor(spec = {}, file = null, { salt = '' } = {}) {
    this.file = file;
    this.salt = salt;
    const problems = [];
    const at = file || 'config';
    if (!isObject(spec)) throw new ConfigError(`${at}: top level must be an object`);
    checkKeys(spec, ['ignore', 'sensitive', 'range', 'schedule'], at, problems);

    this.ignore = [];
    const ign = spec.ignore === undefined ? [] : spec.ignore;
    if (!Array.isArray(ign) || ign.some((x) => typeof x !== 'string' || !x)) problems.push('ignore: must be a list of table names / patterns');
    else this.ignore = ign.map((p) => ({ pattern: p, re: globToRegExp(p) }));

    const sens = spec.sensitive === undefined ? {} : spec.sensitive;
    this.schemaOnly = [];
    this.masks = [];
    if (!isObject(sens)) problems.push('sensitive: must be an object with "tables" and/or "columns"');
    else {
      checkKeys(sens, ['tables', 'columns'], 'sensitive', problems);
      const tables = sens.tables === undefined ? [] : sens.tables;
      if (!Array.isArray(tables) || tables.some((x) => typeof x !== 'string' || !x)) problems.push('sensitive.tables: must be a list of table names / patterns');
      else this.schemaOnly = tables.map((p) => ({ pattern: p, re: globToRegExp(p) }));

      const cols = sens.columns === undefined ? {} : sens.columns;
      if (!isObject(cols)) problems.push('sensitive.columns: must be { "table": { "column": "mode|{value}|{from}|{concat}" } }');
      else {
        for (const [table, map] of Object.entries(cols)) {
          if (!isObject(map) || !Object.keys(map).length) { problems.push(`sensitive.columns.${table}: must be a non-empty { "column": "mode" } object`); continue; }
          const normalized = Object.create(null);
          for (const [col, mask] of Object.entries(map)) {
            if (MASK_MODES.includes(mask)) {
              normalized[col] = mask;
              if (mask === 'hash' && !salt) problems.push(`sensitive.columns.${table}.${col}: "hash" needs MASK_SALT in .env (so hashes cannot be dictionary-reversed)`);
              continue;
            }
            if (!isObject(mask)) {
              problems.push(`sensitive.columns.${table}.${col}: use one of ${MASK_MODES.join(', ')}, { "value": ... }, { "from": "other_column" }, or { "concat": [...] }`);
              continue;
            }
            const keys = Object.keys(mask).filter((k) => k !== 'maxLength');
            if (keys.length !== 1 || !['value', 'from', 'concat'].includes(keys[0])) {
              problems.push(`sensitive.columns.${table}.${col}: give exactly one of "value", "from", or "concat"`);
              continue;
            }
            if (mask.maxLength !== undefined && keys[0] !== 'concat') {
              problems.push(`sensitive.columns.${table}.${col}.maxLength: only applies to "concat"`);
              continue;
            }
            if (keys[0] === 'from') {
              if (typeof mask.from !== 'string' || !mask.from) {
                problems.push(`sensitive.columns.${table}.${col}.from: must be a column name`);
                continue;
              }
              normalized[col] = { from: mask.from };
            } else if (keys[0] === 'value') {
              const value = mask.value;
              if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) {
                problems.push(`sensitive.columns.${table}.${col}.value: must be a string, number, boolean, or null`);
                continue;
              }
              if (typeof value === 'number' && !Number.isFinite(value)) {
                problems.push(`sensitive.columns.${table}.${col}.value: must be a finite number`);
                continue;
              }
              normalized[col] = { value };
            } else {
              if (!Array.isArray(mask.concat) || mask.concat.length < 2) {
                problems.push(`sensitive.columns.${table}.${col}.concat: must be a list of at least two text or { "column": "name" } parts`);
                continue;
              }
              if (mask.maxLength !== undefined && !(Number.isInteger(mask.maxLength) && mask.maxLength > 0)) {
                problems.push(`sensitive.columns.${table}.${col}.maxLength: must be a positive whole number of characters`);
                continue;
              }
              const parts = [];
              let valid = true;
              for (const [i, part] of mask.concat.entries()) {
                if (typeof part === 'string') {
                  parts.push(part);
                } else if (isObject(part) && Object.keys(part).length === 1
                    && typeof part.column === 'string' && part.column) {
                  parts.push({ column: part.column });
                } else {
                  problems.push(`sensitive.columns.${table}.${col}.concat[${i}]: must be text or { "column": "name" }`);
                  valid = false;
                }
              }
              if (valid) normalized[col] = mask.maxLength === undefined ? { concat: parts } : { concat: parts, maxLength: mask.maxLength };
            }
          }
          this.masks.push({ pattern: table, re: globToRegExp(table), columns: normalized });
        }
      }
    }

    const wins = spec.range === undefined ? {} : spec.range;
    this.ranges = [];
    if (!isObject(wins)) problems.push('range: must be { "table": { "column": "...", "last": "30d" } }');
    else {
      for (const [table, w] of Object.entries(wins)) {
        const where = `range.${table}`;
        if (!isObject(w)) { problems.push(`${where}: must be an object`); continue; }
        checkKeys(w, ['column', 'last', 'since', 'allowUnindexed'], where, problems);
        if (typeof w.column !== 'string' || !w.column) problems.push(`${where}.column: required – the date/datetime/timestamp column that says how new a row is`);
        if ((w.last === undefined) === (w.since === undefined)) problems.push(`${where}: give exactly one of "last" (e.g. "30d") or "since" (e.g. "2026-01-01")`);
        const range = { column: w.column, allowUnindexed: w.allowUnindexed === true };
        if (w.last !== undefined) Object.assign(range, parseLast(w.last, where, problems));
        if (w.since !== undefined) {
          if (typeof w.since !== 'string' || !SINCE_RE.test(w.since)) problems.push(`${where}.since: "${w.since}" must look like 2026-01-01 or 2026-01-01 08:00:00`);
          else Object.assign(range, { since: w.since.replace('T', ' '), label: `≥${w.since.slice(0, 10)}`, text: `since ${w.since.slice(0, 10)}` });
        }
        this.ranges.push({ pattern: table, re: globToRegExp(table), range });
      }
    }

    this.schedule = null;
    if (spec.schedule !== undefined) this.schedule = parseSchedule(spec.schedule, problems);

    if (problems.length) throw new ConfigError(`${at}:\n  - ${problems.join('\n  - ')}`);
    this._spec = spec;
    this._scopes = new Map();
  }

  /** Read a policy file. A missing file is only an error when `required` (the user named it explicitly). */
  static load(file, { required = false, salt = '' } = {}) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT' && !required) return new Rules({}, null, { salt });
      throw new ConfigError(`Cannot read config file ${file}: ${e.message}`);
    }
    let spec;
    try {
      spec = JSON.parse(stripComments(text));
    } catch (e) {
      throw new ConfigError(`${file}: ${e.message}`);
    }
    return new Rules(spec, file, { salt });
  }

  get empty() {
    return !this.ignore.length && !this.schemaOnly.length && !this.masks.length && !this.ranges.length;
  }

  /** Changes whenever the policy changes, so a cached scan made under other rules is not reused. */
  get fingerprint() {
    const { schedule, ...policy } = this._spec; // when to run does not change what a scan means
    return crypto.createHash('sha1').update(JSON.stringify(policy)).digest('hex').slice(0, 12);
  }

  /** Exact name beats a pattern; otherwise the first declared pattern wins. */
  _pick(list, name) {
    return list.find((r) => r.pattern.toLowerCase() === name.toLowerCase()) || list.find((r) => r.re.test(name)) || null;
  }

  isIgnored(kind, item) {
    if (kind === 'triggers' && item.table && this.isIgnored('tables', { name: item.table })) return true; // would fail on the slave
    return this.ignore.some((r) => r.re.test(item.name));
  }

  /** Drop ignored objects from a driver listing. Returns { listing, ignored: [{kind, name}] }. */
  filter(listing) {
    const out = {};
    const ignored = [];
    for (const [kind, items] of Object.entries(listing)) {
      out[kind] = [];
      for (const it of items) (this.isIgnored(kind, it) ? ignored.push({ kind, name: it.name }) : out[kind].push(it));
    }
    return { listing: out, ignored };
  }

  /** What applies to one table: { schemaOnly, range, masks } (schemaOnly wins over the rest – the stricter rule). */
  tableRule(name) {
    if (this._pick(this.schemaOnly, name)) return { schemaOnly: true, range: null, masks: null };
    const range = this._pick(this.ranges, name);
    const m = this._pick(this.masks, name);
    return { schemaOnly: false, range: range ? range.range : null, masks: m ? m.columns : null };
  }

  /** Static description for the UI: { mode: full|range|masked|schema, tag }. */
  scopeOf(name) {
    let s = this._scopes.get(name);
    if (!s) {
      const r = this.tableRule(name);
      const parts = [];
      if (r.range) parts.push(r.range.label);
      if (r.masks) parts.push('masked');
      s = r.schemaOnly ? { mode: 'schema', tag: 'schema only' }
        : { mode: r.range ? 'range' : r.masks ? 'masked' : 'full', tag: parts.join('·') };
      this._scopes.set(name, s);
    }
    return s;
  }

  /** Exact-name protection rules that match no known table – almost always a typo. */
  unmatched(tableNames) {
    const known = new Set(tableNames.map((n) => n.toLowerCase()));
    const miss = [];
    const check = (list, label) => {
      for (const r of list) {
        if (/[*?]/.test(r.pattern)) continue;
        if (!known.has(r.pattern.toLowerCase())) miss.push(`${label} "${r.pattern}" matches no table on the master – typo? (the real table is NOT protected)`);
      }
    };
    check(this.schemaOnly, 'sensitive.tables');
    check(this.masks, 'sensitive.columns');
    check(this.ranges, 'range');
    return miss;
  }

  summary() {
    if (!this.file) return null;
    const bits = [];
    if (this.ignore.length) bits.push(`${this.ignore.length} ignore`);
    if (this.schemaOnly.length) bits.push(`${this.schemaOnly.length} schema-only`);
    if (this.masks.length) bits.push(`${this.masks.length} masked`);
    if (this.ranges.length) bits.push(`${this.ranges.length} range`);
    if (this.schedule) bits.push(`schedule ${this.schedule.cron}`);
    return bits.length ? bits.join(' · ') + ' rule(s)' : 'no rules';
  }
}

module.exports = { Rules, ConfigError, stripComments, globToRegExp };
