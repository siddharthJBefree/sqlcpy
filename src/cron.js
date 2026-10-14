'use strict';

/**
 * Crontab (5 field) expression helper: parse, validate and enumerate the next run times, optionally in an
 * IANA time zone. node-cron fires the jobs; this exists so the schedule can be previewed without waiting.
 *   fields: minute hour day-of-month month day-of-week     e.g. "0 2 * * 1-5"
 *   syntax: *  a  a-b  a,b  *\/n  a-b/n  a/n, month names (jan-dec), weekday names (sun-sat), 7 = sunday.
 * As in classic cron, when both day-of-month and day-of-week are restricted a day matches if EITHER does.
 */

const NAMES = {
  month: ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'],
  dow: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'],
};
const FIELDS = [
  { key: 'minute', min: 0, max: 59 },
  { key: 'hour', min: 0, max: 23 },
  { key: 'dom', label: 'day-of-month', min: 1, max: 31 },
  { key: 'month', min: 1, max: 12, names: NAMES.month, base: 1 },
  { key: 'dow', label: 'day-of-week', min: 0, max: 7, names: NAMES.dow, base: 0 },
];

function value(token, f) {
  if (f.names) {
    const i = f.names.indexOf(token.toLowerCase());
    if (i >= 0) return i + f.base;
  }
  if (!/^\d+$/.test(token)) throw new Error(`"${token}" is not a valid ${f.label || f.key}`);
  const n = Number(token);
  if (n < f.min || n > f.max) throw new Error(`${f.label || f.key} ${n} is out of range (${f.min}-${f.max})`);
  return n;
}

function parseField(text, f) {
  const set = new Set();
  let star = false;
  for (const part of text.split(',')) {
    if (!part) throw new Error(`empty item in ${f.label || f.key}`);
    const [range, stepText, extra] = part.split('/');
    if (extra !== undefined) throw new Error(`"${part}" has more than one "/"`);
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText) || Number(stepText) < 1) throw new Error(`step "${stepText}" in ${f.label || f.key} must be a positive number`);
      step = Number(stepText);
    }
    let lo; let hi;
    if (range === '*') {
      lo = f.min; hi = f.key === 'dow' ? 6 : f.max;
      if (stepText === undefined) star = true;
    } else if (range.includes('-')) {
      const [a, b, more] = range.split('-');
      if (more !== undefined) throw new Error(`"${range}" is not a valid range`);
      lo = value(a, f); hi = value(b, f);
      if (lo > hi) throw new Error(`range "${range}" in ${f.label || f.key} runs backwards`);
    } else {
      lo = value(range, f);
      hi = stepText !== undefined ? (f.key === 'dow' ? 6 : f.max) : lo; // "5/15" means 5 through the end
    }
    for (let v = lo; v <= hi; v += step) set.add(f.key === 'dow' && v === 7 ? 0 : v);
  }
  return { set, star };
}

/** -> { fields: { minute, hour, dom, month, dow }, domStar, dowStar } or throws Error with a readable reason. */
function parse(expr) {
  if (typeof expr !== 'string') throw new Error('cron expression must be text');
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`needs 5 fields (minute hour day-of-month month day-of-week), got ${expr.trim() ? parts.length : 0}`);
  const out = {};
  const stars = {};
  FIELDS.forEach((f, i) => {
    const r = parseField(parts[i], f);
    out[f.key] = r.set;
    stars[f.key] = r.star;
  });
  return { fields: out, domStar: stars.dom, dowStar: stars.dow, parts };
}

function validate(expr) {
  try { parse(expr); return null; } catch (e) { return e.message; }
}

const fmt = (tz) => new Intl.DateTimeFormat('en-US', {
  timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});
const formatters = new Map();

/** Offset (ms) of the zone from UTC at an instant; zone null = this machine's local zone. */
function offsetAt(ms, tz) {
  if (!tz) return -new Date(ms).getTimezoneOffset() * 60000;
  let f = formatters.get(tz);
  if (!f) { f = fmt(tz); formatters.set(tz, f); }
  const p = {};
  for (const x of f.formatToParts(new Date(ms))) p[x.type] = Number(x.value);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** Wall-clock time of `wallMs` (stored as if UTC) in the zone -> the real instant. */
function wallToInstant(wallMs, tz) {
  let inst = wallMs - offsetAt(wallMs, tz);
  const off2 = offsetAt(inst, tz);
  inst = wallMs - off2;
  return inst;
}

/**
 * Next `count` run instants (ms since epoch) strictly after `from`.
 * Works on wall-clock time in the zone, so "0 2 * * *" with Asia/Kolkata means 02:00 there.
 */
function nextRuns(expr, { from = Date.now(), tz = null, count = 5 } = {}) {
  const { fields, domStar, dowStar } = parse(expr);
  const runs = [];
  let t = from + offsetAt(from, tz);
  t = Math.floor(t / 60000) * 60000 + 60000; // next whole minute, wall clock
  const limit = t + 6 * 366 * 86400000;
  const dayOk = (d) => {
    const domHit = fields.dom.has(d.getUTCDate());
    const dowHit = fields.dow.has(d.getUTCDay());
    if (domStar && dowStar) return true;
    if (domStar) return dowHit;
    if (dowStar) return domHit;
    return domHit || dowHit;
  };
  while (runs.length < count && t < limit) {
    const d = new Date(t);
    if (!fields.month.has(d.getUTCMonth() + 1)) { t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1); continue; }
    if (!dayOk(d)) { t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1); continue; }
    if (!fields.hour.has(d.getUTCHours())) { t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours() + 1); continue; }
    if (!fields.minute.has(d.getUTCMinutes())) { t += 60000; continue; }
    const inst = wallToInstant(t, tz);
    if (inst > from && (!runs.length || inst > runs[runs.length - 1])) runs.push(inst);
    t += 60000;
  }
  return runs;
}

/** Plain-words breakdown of the five fields, e.g. "minute 0 · hour 2 · every day-of-month · …". */
function breakdown(expr) {
  const { parts } = parse(expr);
  return FIELDS.map((f, i) => `${f.label || f.key} ${parts[i]}`);
}

/** "2026-10-15 02:00 Thu" in the zone. */
function formatInstant(ms, tz) {
  const d = new Date(ms + offsetAt(ms, tz));
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} ${NAMES.dow[d.getUTCDay()].replace(/^./, (x) => x.toUpperCase())}`;
}

module.exports = { parse, validate, nextRuns, breakdown, formatInstant };
