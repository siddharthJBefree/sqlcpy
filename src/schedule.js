'use strict';
const fs = require('fs');
const path = require('path');
const { describe } = require('./errors');

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const fmtMs = (ms) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);

/** Timestamped console + file logger (the file lives next to the dumps). */
function makeLogger(file, quiet = false) {
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch (e) { /* logging stays console-only */ }
  return (level, msg) => {
    const line = `${stamp()} ${level.padEnd(5)} ${msg}`;
    if (!quiet) (level === 'ERROR' ? console.error : console.log)(line);
    try { fs.appendFileSync(file, line + '\n'); } catch (e) { /* best effort */ }
  };
}

const logFile = (cfg) => path.join(cfg.dumpDir, 'sqlcpy-schedule.log');

/** Last `n` lines of the schedule log (what the daemon / run-once wrote), or null if there is none yet. */
function tailLog(file, n = 8) {
  try {
    const size = fs.statSync(file).size;
    const len = Math.min(size, 64 * 1024);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    return buf.toString('utf8').split(/\r?\n/).filter(Boolean).slice(-n);
  } catch (e) {
    return null;
  }
}

/**
 * One unattended pass: re-read the policy file, then refresh the tables in scope (all non-ignored tables, or "schedule.tables" when given).
 * A failing table is logged and does not stop the others. Resolves to { copied, skipped, failed, missing }.
 */
async function runOnce(app, log, { onProgress, onItem } = {}) {
  const t0 = Date.now();
  try {
    if (app.reloadConfig()) log('INFO', 'config changed on disk – new rules applied');
  } catch (e) {
    log('WARN', `config file is invalid, keeping the previous rules: ${e.message}`);
  }
  const sched = app.rules.schedule;
  const out = { copied: 0, skipped: 0, failed: 0, missing: [] };
  if (!sched) throw new Error('no "schedule" block in the config file');

  const { items, unmatched } = await app.tablesMatching(sched.tables.map((t) => t.pattern));
  for (const p of unmatched) log('WARN', `schedule.tables "${p}" matches no table on the master (or it is ignored)`);
  out.missing = unmatched;
  log('INFO', `run started · ${items.length} table(s)${sched.atomicSwap ? ' · atomic swap' : ''}${sched.skipIfUnchanged ? ' · skip unchanged' : ''}`);

  for (const item of items) item.prevStatus = item.status;
  for (const item of items) {
    const t = Date.now();
    try {
      if (sched.skipIfUnchanged) {
        await app.check(item);
        if (item.status === 'same') {
          out.skipped++;
          log('INFO', `${item.name}: unchanged, skipped`);
          continue;
        }
      }
      item.status = 'copying';
      if (onItem) onItem(item);
      const r = await app.copy(item, { swap: sched.atomicSwap, onProgress });
      out.copied++;
      log('INFO', `${item.name}: copied ${r.rows} row(s)${r.note ? ` (${r.note})` : ''} in ${fmtMs(Date.now() - t)} · now ${item.status}`);
      if (item.status === 'error' || item.status === 'different') log('WARN', `${item.name}: after the copy the table is "${item.status}" – ${item.detail}`);
    } catch (e) {
      out.failed++;
      if (item.status === 'copying') item.status = 'error';
      const d = describe(e);
      log('ERROR', `${item.name}: ${d.code ? d.code + ' ' : ''}${d.message}`);
    }
  }
  if (onItem) onItem(null);
  log(out.failed ? 'ERROR' : 'INFO', `run finished in ${fmtMs(Date.now() - t0)} · ${out.copied} copied, ${out.skipped} skipped, ${out.failed} failed`);
  return out;
}

/** Run on the schedule until the process is stopped. A run that is still going makes the next tick skip. */
function startDaemon(app, log) {
  const cron = require('node-cron');
  const sched = app.rules.schedule;
  if (!sched) throw new Error('no "schedule" block in the config file – nothing to run');
  let running = false;
  const cronLib = require('./cron');
  const announceNext = () => {
    try {
      const [t] = cronLib.nextRuns(sched.cron, { tz: sched.timezone, count: 1 });
      if (t) log('INFO', `next run ${cronLib.formatInstant(t, sched.timezone)} (${sched.timezone || 'server local time'})`);
    } catch (e) { /* cosmetic */ }
  };
  const tick = async () => {
    if (running) { log('WARN', 'previous run is still going – this tick skipped'); return; }
    running = true;
    try {
      await runOnce(app, log);
    } catch (e) {
      log('ERROR', `run failed: ${describe(e).message}`);
    } finally {
      running = false;
      announceNext();
    }
  };
  const opts = sched.timezone ? { timezone: sched.timezone } : {};
  const task = cron.schedule(sched.cron, tick, opts);
  log('INFO', `daemon started · cron "${sched.cron}"${sched.timezone ? ` (${sched.timezone})` : ''} · ${sched.allTables ? 'all tables (per ignore / sensitive / range rules)' : sched.tables.map((t) => t.pattern).join(', ')}`);
  announceNext();
  return { task, isRunning: () => running };
}

module.exports = { runOnce, startDaemon, makeLogger, logFile, tailLog };
