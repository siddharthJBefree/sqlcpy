'use strict';
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const { KINDS, LABELS } = require('./objects');
const { describe } = require('./errors');
const cron = require('./cron');
const { runOnce, logFile, tailLog, makeLogger } = require('./schedule');

const A = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', inv: '\x1b[7m',
  black: '\x1b[30m', bgWhite: '\x1b[47m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m', gray: '\x1b[90m',
};
const c = (col, s) => A[col] + s + A.reset;
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const fmtBytes = (n) => {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return (n / 1024 ** i).toFixed(i ? 1 : 0) + ' ' + u[i];
};
const fmtNum = (n) => (n == null ? '-' : Number(n).toLocaleString('en-US'));
const fmtAgo = (t) => {
  if (!t) return '-';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};
const fmtTime = (s) => {
  s = Math.max(0, Math.round(s));
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`;
};
const pad = (s, w) => (s.length > w ? s.slice(0, w - 1) + '…' : s.padEnd(w));
const padL = (s, w) => (s.length > w ? s.slice(0, w) : s.padStart(w));
const ANSI = /\[[0-9;]*m/g;
// Truncate to w visible columns so a long line can never wrap and scroll the screen.
const clip = (line, w) => {
  if ((line.replace(ANSI, '')).length <= w) return line;
  let out = '', vis = 0;
  for (let i = 0; i < line.length && vis < w - 1;) {
    const m = /^\[[0-9;]*m/.exec(line.slice(i));
    if (m) { out += m[0]; i += m[0].length; } else { out += line[i++]; vis++; }
  }
  return out + A.reset + '…';
};
const selectedRow = (line, width) => {
  const visible = line.replace(ANSI, '');
  const padded = line + ' '.repeat(Math.max(0, width - visible.length));
  return A.bgWhite + A.black + padded.replace(/\x1b\[([0-9;]*)m/g, (_, codes) => {
    if (codes === '0') return A.reset + A.bgWhite + A.black;
    return `\x1b[${codes === '90' ? '30' : codes};47m`;
  }) + A.reset;
};
// Flow [key, label] hints onto as few lines as fit in w columns.
const hintLines = (hints, w) => {
  const lines = [];
  let cur = '', len = 0;
  hints.forEach(([k, label], i) => {
    const text = ` ${k} ${label}${i < hints.length - 1 ? ' |' : ''}`;
    if (len && len + text.length > w) { lines.push(cur); cur = ''; len = 0; }
    cur += c('bold', ` ${k}`) + c('gray', ` ${label}${i < hints.length - 1 ? ' |' : ''}`);
    len += text.length;
  });
  if (cur) lines.push(cur);
  return lines;
};
const bar = (frac, w) => {
  const f = Math.max(0, Math.min(1, frac));
  const n = Math.round(f * w);
  return c('cyan', '█'.repeat(n)) + c('gray', '░'.repeat(w - n));
};

class UI {
  constructor(app) {
    this.app = app;
    this.cursor = 0;
    this.selection = null;
    this.sortBy = 'name';
    this.sortDirection = 1;
    this.filter = '';
    this.filtering = false;
    this.view = 'main';
    this.logFilter = '';
    this.logFiltering = false;
    this.logLevelFilter = null;
    this.logSort = 'newest';
    this.logScroll = 0;
    this.logItem = null;
    this.statusFilter = null;
    this.scroll = 0;
    this.queue = [];
    this.current = null;
    this.progress = null;
    this.abort = null;
    this.log = [];
    this.frame = 0;
    this.scanning = true;
    this.done = new Map(); // item -> {rows, bytes, file}
    this.configWatcher = null;
    this.configReloadTimer = null;
    // schedule screen: input = cron text being previewed (null = the config's); focus = pane the arrow keys scroll
    this.sch = { editing: false, input: null, confirm: false, running: false, scroll: 0, focus: 'table', logScroll: 0 };
  }

  start() {
    const out = process.stdout;
    out.write('\x1b[?1049h\x1b[?25l');
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('keypress', (_, key) => this.onKey(key || {}));
    out.on('resize', () => this.render());
    this.timer = setInterval(() => { this.frame++; this.render(); }, 100);
    this.app.on('items', () => this.render());
    this.app.on('item', () => this.render());
    this.noteConfig();
    this.watchConfig();
    this.rescan(false);
    this.render();
  }

  watchConfig() {
    const file = this.app.cfg.configFile;
    const dir = path.dirname(file);
    const base = path.basename(file);
    try {
      this.configWatcher = fs.watch(dir, { persistent: false }, (_, changed) => {
        if (changed && changed.toString() !== base) return;
        clearTimeout(this.configReloadTimer);
        this.configReloadTimer = setTimeout(() => this.reloadConfig(), 250);
      });
      this.configWatcher.on('error', (e) => {
        this.note(`✖ Config watcher failed: ${e.message}`, 'red');
        this.render();
      });
    } catch (e) {
      this.note(`✖ Cannot watch config file ${file}: ${e.message}`, 'red');
    }
  }

  reloadConfig() {
    if (this.current || this.queue.length || this.scanning) {
      this.configReloadTimer = setTimeout(() => this.reloadConfig(), 500);
      return;
    }
    try {
      if (!this.app.reloadConfig()) return;
      this.noteConfig();
      this.note('Config saved – applying updated rules and rescanning', 'cyan');
      this.rescan();
    } catch (e) {
      this.note(`✖ Config reload failed: ${e.message} – keeping the previous config`, 'red');
      this.render();
    }
  }

  noteConfig() {
    const { rules, cfg } = this.app;
    if (!rules.file) return this.note(`No config file at ${cfg.configFile} – every table is copied in full`, 'gray');
    this.note(`Config ${rules.file}: ${rules.summary()}`, 'cyan');
  }

  /** After a scan (fresh or cached): what the config hid, and anything that looks unsafe. */
  noteScanPolicy() {
    const ig = this.app.ignored;
    if (ig.length) {
      const names = ig.slice(0, 8).map((i) => i.name).join(', ');
      this.note(`${ig.length} object(s) ignored by config: ${names}${ig.length > 8 ? ', …' : ''}`, 'gray');
    }
    for (const w of this.app.warnings) this.note('! ' + w, 'yellow');
  }

  stop() {
    clearInterval(this.timer);
    clearTimeout(this.configReloadTimer);
    if (this.configWatcher) this.configWatcher.close();
    process.stdout.write('\x1b[?25h\x1b[?1049l');
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
  }

  note(msg, col = 'gray', item = null) {
    this.log.push({ t: Date.now(), msg, col, item });
    if (this.log.length > 500) this.log.shift();
  }

  fmtLog(e) { return c(e.col, new Date(e.t).toLocaleTimeString() + ' ' + e.msg); }

  logLevel(e) { return { red: 'error', yellow: 'warn', green: 'ok' }[e.col] || 'info'; }

  visibleLogs() {
    const needle = this.logFilter.toLowerCase();
    const list = this.log.filter((e) => (!this.logItem || e.item === this.logItem) && (!this.logLevelFilter || this.logLevel(e) === this.logLevelFilter) && (!needle || e.msg.toLowerCase().includes(needle)));
    const rank = { error: 0, warn: 1, ok: 2, info: 3 };
    if (this.logSort === 'level') return list.sort((a, b) => rank[this.logLevel(a)] - rank[this.logLevel(b)] || b.t - a.t);
    return this.logSort === 'oldest' ? list : list.reverse();
  }

  onLogKey(k) {
    if (this.logFiltering) {
      if (k.name === 'escape') { this.logFilter = ''; this.logFiltering = false; }
      else if (k.name === 'return' || k.name === 'enter') this.logFiltering = false;
      else if (k.name === 'backspace') this.logFilter = this.logFilter.slice(0, -1);
      else if (k.sequence && k.sequence.length === 1 && k.sequence >= ' ' && !k.ctrl && !k.meta) this.logFilter += k.sequence;
      this.logScroll = 0;
    this.logItem = null;
      return this.render();
    }
    const page = Math.max(1, (process.stdout.rows || 30) - 8);
    if (k.name === 'q') return this.quit();
    if (k.name === 'escape' && this.logFilter) { this.logFilter = ''; this.logScroll = 0; }
    else if (k.name === 'escape' && this.logItem) { this.logItem = null; this.logScroll = 0; }
    else if (k.name === 'escape' || k.name === 'l') { this.view = 'main'; this.logItem = null; }
    else if (k.sequence === '/') this.logFiltering = true;
    else if (k.name === 'up' || k.name === 'k') this.logScroll = Math.max(0, this.logScroll - 1);
    else if (k.name === 'down' || k.name === 'j') this.logScroll++;
    else if (k.name === 'pageup') this.logScroll = Math.max(0, this.logScroll - page);
    else if (k.name === 'pagedown') this.logScroll += page;
    else if (k.name === 'home') this.logScroll = 0;
    else if (k.name === 'end') this.logScroll = Infinity;
    else if (k.name === 'v') {
      const opts = [null, 'error', 'warn', 'ok', 'info'];
      this.logLevelFilter = opts[(opts.indexOf(this.logLevelFilter) + 1) % opts.length];
      this.logScroll = 0;
    this.logItem = null;
    } else if (k.name === 's') {
      const opts = ['newest', 'oldest', 'level'];
      this.logSort = opts[(opts.indexOf(this.logSort) + 1) % opts.length];
      this.logScroll = 0;
    this.logItem = null;
    } else if (k.name === 'c') { this.log = []; this.logScroll = 0; }
    this.render();
  }

  renderLog() {
    const W = Math.max(60, process.stdout.columns || 100);
    const H = Math.max(15, process.stdout.rows || 30);
    const all = this.log;
    const list = this.visibleLogs();
    const bodyH = H - 6;
    this.logScroll = Math.max(0, Math.min(this.logScroll, list.length - bodyH));
    const n = (lv) => all.filter((e) => this.logLevel(e) === lv).length;
    const L = [];
    L.push(` ${A.bold}${A.cyan}sqlcpy${A.reset}  ${A.bold}Log${A.reset}  ${c('gray', `${list.length}/${all.length} shown · sort: ${this.logSort}`)}${this.logItem ? '  ' + c('cyan', '[item: ' + this.logItem.name + ']') : ''}${this.logLevelFilter ? '  ' + c('yellow', '[level: ' + this.logLevelFilter + ']') : ''}`);
    L.push(` ${c('red', '✖ ' + n('error'))} errors  ${c('yellow', '! ' + n('warn'))} warnings  ${c('green', '✔ ' + n('ok'))} ok  ${c('gray', '• ' + n('info') + ' info')}`);
    L.push(this.logFiltering || this.logFilter
      ? ` ${c('cyan', '/')}${this.logFilter}${this.logFiltering ? c('cyan', '█') : ''} ${c('gray', this.logFiltering ? '· enter keep · esc clear' : '· esc clear')}`
      : c('gray', ' ' + '─'.repeat(W - 2)));
    for (const e of list.slice(this.logScroll, this.logScroll + bodyH)) {
      const text = new Date(e.t).toLocaleTimeString() + ' ' + e.msg;
      L.push(' ' + c(e.col, text.length > W - 2 ? text.slice(0, W - 3) + '…' : text));
    }
    if (!list.length) L.push(c('gray', '   No log entries'));
    while (L.length < H - 2) L.push('');
    L.push(c('gray', ' ' + '─'.repeat(W - 2)));
    L.push(
      c('bold', ' ↑↓') + c('gray', ' scroll |') +
      c('bold', ' /') + c('gray', ' filter |') +
      c('bold', ' v') + c('gray', ' level |') +
      c('bold', ' s') + c('gray', ' sort newest/oldest/level |') +
      c('bold', ' c') + c('gray', ' clear |') +
      c('bold', ' esc/l') + c('gray', ' back |') +
      c('bold', ' q') + c('gray', ' quit')
    );
    process.stdout.write('\x1b[H' + L.slice(0, H).map((l) => clip(l, W) + '\x1b[K').join('\n') + '\x1b[J');
  }

  rescan(force = true) {
    if (this.current || this.queue.length || this.sch.running) return this.note('Finish or cancel copying before rescanning', 'yellow');
    this.scanning = true;
    this.app.scan({ force }).then((res) => {
      this.scanning = false;
      this.noteScanPolicy();
      if (res.cached) return this.note(`Loaded ${this.items.length} items from cache (scanned ${new Date(res.at).toLocaleString()}) – R rescan all, r rescan selected`, 'cyan');
      const f = this.items.filter((i) => i.status === 'error').length;
      this.note(f ? `Scan complete with ${f} error(s) – select the red items for details` : 'Scan complete', f ? 'yellow' : 'green');
    }).catch((e) => { this.scanning = false; const d = describe(e); this.note(`✖ Scan failed: ${d.code} ${d.message}`, 'red'); if (d.hint) this.note('  → ' + d.hint, 'yellow'); });
  }

  rescanItem(item) {
    if (!item) return;
    if (this.scanning) return this.note('Full scan in progress', 'yellow');
    if (item === this.current || this.queue.includes(item) || item.status === 'checking') return this.note(`${item.name}: busy, try again when it finishes`, 'yellow', item);
    this.note(`Rescanning ${item.name}`, 'cyan', item);
    this.app.recheck(item).then((r) => {
      if (!r) return this.note(`${item.name} no longer exists on either side – removed`, 'yellow', item);
      this.note(`${item.name}: ${item.status}${item.detail ? ' – ' + item.detail : ''}`, item.status === 'error' ? 'red' : item.status === 'same' ? 'green' : 'yellow', item);
    }).catch((e) => { const d = describe(e); this.note(`✖ Rescan of ${item.name} failed: ${d.code ? d.code + ' ' : ''}${d.message}`, 'red', item); });
  }

  get items() { return this.app.items; }
  sortedItems() {
    const fields = {
      name: (it) => it.name,
      masterRows: (it) => it.kind === 'tables' ? (it.scope?.mode === 'range' ? it.master?.approxRows : it.masterRows ?? it.master?.approxRows) : null,
      slaveRows: (it) => it.kind === 'tables' ? (it.scope?.mode === 'range' ? it.slave?.approxRows : it.slaveRows ?? it.slave?.approxRows) : null,
      size: (it) => it.kind === 'tables' ? it.master?.bytes : null,
      status: (it) => ({ same: 0, different: 1, missing: 2, extra: 3, error: 4, queued: 5, copying: 6, checking: 7 })[it.status],
    };
    const value = fields[this.sortBy];
    const kindOrder = new Map(KINDS.map((kind, index) => [kind, index]));
    const needle = this.filter.toLowerCase();
    // The Queued tab also shows the item currently being copied, so the active row stays visible there.
    const inFilter = (it) => !this.statusFilter || it.status === this.statusFilter || (this.statusFilter === 'queued' && it.status === 'copying');
    const visible = this.items.filter((it) => (!needle || it.name.toLowerCase().includes(needle)) && inFilter(it));
    return [...visible].sort((a, b) => {
      const kindDiff = kindOrder.get(a.kind) - kindOrder.get(b.kind);
      if (kindDiff) return kindDiff;
      const aValue = value(a);
      const bValue = value(b);
      if (aValue == null) return bValue == null ? a.name.localeCompare(b.name) : 1;
      if (bValue == null) return -1;
      const diff = typeof aValue === 'string'
        ? aValue.localeCompare(bValue, undefined, { numeric: true, sensitivity: 'base' })
        : aValue - bValue;
      return diff ? diff * this.sortDirection : a.name.localeCompare(b.name);
    });
  }

  selected(items = this.sortedItems()) {
    if (this.selection && items.includes(this.selection)) {
      this.cursor = items.indexOf(this.selection);
      return this.selection;
    }
    this.cursor = Math.max(0, Math.min(this.cursor, items.length - 1));
    this.selection = items[this.cursor] || null;
    return this.selection;
  }

  onFilterKey(k) {
    if (k.name === 'escape') { this.filter = ''; this.filtering = false; }
    else if (k.name === 'return' || k.name === 'enter') this.filtering = false;
    else if (k.name === 'backspace') this.filter = this.filter.slice(0, -1);
    else if (k.sequence && k.sequence.length === 1 && k.sequence >= ' ' && !k.ctrl && !k.meta) this.filter += k.sequence;
    else if (k.name === 'up' || k.name === 'down') { this.filtering = false; return this.onKey(k); }
    this.cursor = 0;
    this.selection = null;
    this.scroll = 0;
    this.render();
  }

  async onKey(k) {
    if (k.ctrl && k.name === 'c') return this.quit();
    if (this.view === 'log') return this.onLogKey(k);
    if (this.view === 'schedule') return this.onScheduleKey(k);
    if (this.filtering) return this.onFilterKey(k);
    if (k.name === 'q') return this.quit();
    if (k.name === 'l') { this.view = 'log'; this.logItem = null; this.logScroll = 0; this.render(); return; }
    if (k.name === 't') { this.view = 'schedule'; this.sch.scroll = 0; this.render(); return; }
    if (k.name === 'e') {
      const it = this.selected();
      if (it) { this.view = 'log'; this.logItem = it; this.logScroll = 0; this.render(); }
      return;
    }
    if (k.sequence === '/') { this.filtering = true; this.render(); return; }
    if (k.name === 'v') {
      const opts = [null, 'same', 'different', 'missing', 'extra', 'error', 'queued'];
      this.statusFilter = opts[(opts.indexOf(this.statusFilter) + 1) % opts.length];
      this.cursor = 0; this.selection = null; this.scroll = 0;
      this.note(`Status filter: ${this.statusFilter || 'all'}`, 'cyan');
      this.render();
      return;
    }
    if (k.name === 'escape' && (this.filter || this.statusFilter)) {
      this.filter = ''; this.statusFilter = null; this.cursor = 0; this.selection = null; this.scroll = 0;
      this.render();
      return;
    }
    const items = this.sortedItems();
    const selected = this.selected(items);
    const n = items.length;
    if (k.name === 'up' || k.name === 'k') this.cursor = Math.max(0, this.cursor - 1);
    else if (k.name === 'down' || k.name === 'j') this.cursor = Math.min(n - 1, this.cursor + 1);
    else if (k.name === 'pageup') this.cursor = Math.max(0, this.cursor - 10);
    else if (k.name === 'pagedown') this.cursor = Math.min(n - 1, this.cursor + 10);
    else if (k.name === 'home') this.cursor = 0;
    else if (k.name === 'end') this.cursor = Math.max(0, n - 1);
    else if (k.name === 'right' || k.name === 'tab') this.jumpSection(1);
    else if (k.name === 'left') this.jumpSection(-1);
    else if (k.name === 's' && k.shift) {
      this.sortDirection *= -1;
      this.cursor = this.sortedItems().indexOf(selected);
      this.note(`Sort ${this.sortBy} ${this.sortDirection === 1 ? 'ascending' : 'descending'}`, 'cyan');
    } else if (k.name === 's') {
      const fields = ['name', 'masterRows', 'slaveRows', 'size', 'status'];
      this.sortBy = fields[(fields.indexOf(this.sortBy) + 1) % fields.length];
      this.cursor = this.sortedItems().indexOf(selected);
      this.note(`Sort by ${this.sortBy} (${this.sortDirection === 1 ? 'ascending' : 'descending'})`, 'cyan');
    } else if (k.name === 'space') this.enqueue(this.selected(), false);
    else if (k.name === 'f') this.enqueue(this.selected(), true);
    else if (k.name === 'a') this.enqueueAll();
    else if (k.name === 'x') this.cancel();
    else if (k.name === 'c') this.cancelItem(this.selected());
    else if (k.name === 'r' && k.shift) this.rescan();
    else if (k.name === 'r') this.rescanItem(this.selected());
    if (k.name !== 's') this.selection = this.sortedItems()[this.cursor] || null;
    else this.selected();
    this.render();
  }

  jumpSection(dir) {
    const it = this.selected();
    if (!it) return;
    const items = this.sortedItems();
    const kinds = KINDS.filter((kd) => items.some((i) => i.kind === kd));
    const idx = (kinds.indexOf(it.kind) + dir + kinds.length) % kinds.length;
    this.cursor = items.findIndex((i) => i.kind === kinds[idx]);
    this.selection = items[this.cursor];
  }

  enqueue(item, force) {
    if (!item) return;
    if (this.sch.running) return this.note('A scheduled run is in progress – wait for it to finish', 'yellow');
    if (item.status === 'extra') return this.note(`${item.name}: only exists in slave, nothing to copy`, 'yellow', item);
    if (item.status === 'checking') return this.note(`${item.name}: still being compared`, 'yellow', item);
    if (item.status === 'same' && !force) return this.note(`${item.name}: already in sync – skipped (press f to force)`, 'yellow', item);
    if (item === this.current || this.queue.includes(item)) return;
    this.queue.push(item);
    item.prevStatus = item.status;
    item.status = 'queued';
    this.pump();
  }

  enqueueAll() {
    for (const it of this.sortedItems()) if (it.status === 'different' || it.status === 'missing') this.enqueue(it, false);
  }

  cancel() {
    for (const it of this.queue) it.status = it.prevStatus || 'different';
    this.queue = [];
    if (this.abort) this.abort.abort();
  }

  cancelItem(item) {
    if (!item) return;
    if (item === this.current) {
      if (this.abort) this.abort.abort();
    } else if (this.queue.includes(item)) {
      this.queue = this.queue.filter((q) => q !== item);
      item.status = item.prevStatus || 'different';
      this.note(`Removed ${item.name} from queue`, 'yellow', item);
    } else this.note(`${item.name}: not queued or copying`, 'gray', item);
  }

  async pump() {
    if (this.current) return;
    while (this.queue.length) {
      const item = this.queue.shift();
      this.current = item;
      this.abort = new AbortController();
      this.progress = null;
      item.status = 'copying';
      this.note(`Copying ${item.kind.slice(0, -1)} ${item.name}`, 'cyan', item);
      try {
        const res = await this.app.copy(item, { signal: this.abort.signal, onProgress: (p) => { this.progress = p; } });
        this.done.set(item, res);
        this.note(`✔ ${item.name} copied (${fmtNum(res.rows)} rows, ${fmtBytes(res.bytes)}${res.note ? ' · ' + res.note : ''}) → ${res.file}`, 'green', item);
      } catch (e) {
        const d = describe(e);
        item.status = e.cancelled ? (item.prevStatus || 'different') : 'error';
        item.detail = e.cancelled ? 'cancelled' : `${d.code ? d.code + ': ' : ''}${d.message}${d.hint ? '  → ' + d.hint : ''}`;
        this.note(e.cancelled ? `⏹ cancelled ${item.name}` : `✖ failed ${item.name}: ${d.code ? d.code + ' ' : ''}${d.message}`, e.cancelled ? 'yellow' : 'red', item);
        if (!e.cancelled && d.hint) this.note('  → ' + d.hint, 'yellow', item);
      }
      this.current = null;
      this.progress = null;
      this.abort = null;
    }
    this.render();
  }


  // ---- schedule screen ---------------------------------------------------------------------------

  /** The cron text being shown: what the user typed, else the config's. */
  schedCron() {
    const sched = this.app.rules.schedule;
    return this.sch.input !== null ? this.sch.input : sched ? sched.cron : '';
  }

  schedBusy() {
    if (this.current || this.queue.length || this.scanning || this.sch.running) {
      this.note('Wait for the current scan / copy / run to finish', 'yellow');
      return true;
    }
    return false;
  }

  onScheduleKey(k) {
    const sch = this.sch;
    if (k.ctrl && k.name === 'c') return this.quit();
    if (sch.editing) {
      if (k.name === 'escape') { sch.editing = false; sch.input = null; }
      else if (k.name === 'return' || k.name === 'enter') sch.editing = false;
      else if (k.name === 'backspace') sch.input = (sch.input || '').slice(0, -1);
      else if (k.sequence && k.sequence.length === 1 && k.sequence >= ' ' && !k.ctrl && !k.meta) sch.input = (sch.input || '') + k.sequence;
      return this.render();
    }
    if (sch.confirm) {
      sch.confirm = false;
      if (k.name === 'y') this.runScheduleNow();
      return this.render();
    }
    if (k.name === 'q') return this.quit();
    if (k.name === 'escape' || k.name === 't') this.view = 'main';
    else if (k.name === 'e') { sch.editing = true; if (sch.input === null) sch.input = this.schedCron() || '0 2 * * *'; }
    else if (k.name === 'c') sch.input = null;
    else if (k.name === 'tab') sch.focus = sch.focus === 'table' ? 'log' : 'table';
    else if (k.name === 'g') {
      if (!this.app.rules.schedule) this.note('No "schedule" block in the config file – nothing to run', 'yellow');
      else if (!this.schedBusy()) {
        if (sch.input !== null && sch.input !== this.app.rules.schedule.cron) this.note('Run now uses the tables and options from the config file; the typed cron is only a preview', 'gray');
        sch.confirm = true;
      }
    } else {
      const d = { up: -1, k: -1, down: 1, j: 1, pageup: -10, pagedown: 10 }[k.name];
      if (d && sch.focus === 'log') sch.logScroll = Math.max(0, sch.logScroll - d); // 0 = newest line at the bottom
      else if (d) sch.scroll = Math.max(0, sch.scroll + d);
      else if (k.name === 'home') { if (sch.focus === 'log') sch.logScroll = Infinity; else sch.scroll = 0; }
      else if (k.name === 'end') { if (sch.focus === 'log') sch.logScroll = 0; else sch.scroll = Infinity; }
    }
    this.render();
  }

  runScheduleNow() {
    const sch = this.sch;
    if (this.schedBusy()) return;
    sch.running = true;
    const col = { INFO: 'gray', WARN: 'yellow', ERROR: 'red' };
    this.note('Schedule run started by hand (same as a cron tick)', 'cyan');
    const toFile = makeLogger(logFile(this.app.cfg), true); // same file the daemon writes, so the run shows up there too
    const hooks = { onProgress: (p) => { this.progress = p; }, onItem: () => { this.progress = null; } };
    runOnce(this.app, (level, msg) => { toFile(level, '[manual] ' + msg); this.note(msg, col[level] || 'gray'); this.render(); }, hooks)
      .then((r) => {
        sch.running = false;
        this.progress = null;
        this.note(r.failed ? `Run finished with ${r.failed} failure(s)` : 'Run finished', r.failed ? 'red' : 'green');
        this.rescan(true);
      })
      .catch((e) => { sch.running = false; this.progress = null; this.note(`✖ Run failed: ${describe(e).message}`, 'red'); });
  }

  renderSchedule() {
    const W = Math.max(60, process.stdout.columns || 100);
    const H = Math.max(15, process.stdout.rows || 30);
    const sch = this.sch;
    const sched = this.app.rules.schedule;
    const tz = sched ? sched.timezone : null;
    const text = this.schedCron();
    const typed = sch.input !== null;
    const why = text ? cron.validate(text) : 'no schedule block in the config file';
    const L = [];
    L.push(` ${A.bold}${A.cyan}sqlcpy${A.reset}  ${A.bold}Schedule${A.reset}  ${c('gray', 'live view of the scheduled tables – nothing here changes the slave unless you press g')}`);
    L.push(c('gray', ' ' + '─'.repeat(W - 2)));

    const zone = tz || 'server local time';
    L.push(` ${c('gray', 'Cron     ')} ${sch.editing ? c('cyan', text) + c('cyan', '█') : A.bold + (text || '-') + A.reset}  ${c('gray', '· ' + zone)}  ${typed ? c('yellow', '[typed preview – not saved]') : sched ? c('gray', '[from config]') : ''}`);
    if (why) {
      L.push(` ${c('gray', '         ')} ${c('red', '✖ ' + why)}`);
      if (!sched) L.push(c('gray', '           add  "schedule": { "cron": "0 2 * * *", "tables": ["user"] }  to the config file (see sqlcpy.config.example.jsonc)'));
    } else {
      L.push(` ${c('gray', '         ')} ${c('gray', cron.breakdown(text).join(' · '))}`);
    }
    const now = Date.now();
    L.push(` ${c('gray', 'Now      ')} ${cron.formatInstant(now, tz)} ${c('gray', '(' + zone + ')')}`);
    if (sched) L.push(` ${c('gray', 'Options  ')} skipIfUnchanged ${c(sched.skipIfUnchanged ? 'green' : 'gray', String(sched.skipIfUnchanged))} · atomicSwap ${c(sched.atomicSwap ? 'green' : 'gray', String(sched.atomicSwap))}`);
    if (sch.running) L.push(` ${c('cyan', SPIN[this.frame % SPIN.length])} ${c('cyan', 'run in progress – see the log (l)')}`);

    L.push('');
    L.push(` ${A.bold}Next runs${A.reset}`);
    if (!why) {
      let runs = [];
      try { runs = cron.nextRuns(text, { from: now, tz, count: 6 }); } catch (e) { /* shown below */ }
      if (!runs.length) L.push(c('yellow', '   never fires in the next 6 years (e.g. 30 February)'));
      runs.forEach((t, i) => {
        const s = Math.round((t - now) / 1000);
        const rel = s >= 86400 ? `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h` : s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${Math.max(1, Math.round(s / 60))}m`;
        L.push(`   ${c('gray', String(i + 1))}  ${cron.formatInstant(t, tz)}   ${c('gray', 'in ' + rel)}`);
      });
    }

    L.push('');
    // tables in scope, live: same columns and status/progress as the main screen, just no row actions
    let body = [];
    if (!sched) {
      L.push(c('gray', ' Tables: none – no schedule block'));
    } else {
      const names = sched.allTables ? 'all tables per ignore/sensitive/range rules' : sched.tables.map((t) => t.pattern).join(', ');
      const hit = this.items.filter((i) => i.kind === 'tables' && i.master && (sched.allTables || sched.tables.some((t) => t.re.test(i.name))));
      L.push(` ${A.bold}Tables${A.reset} ${c('gray', `${names} → ${hit.length} in scope`)}${sch.focus === 'table' ? c('cyan', '  ◂ focus') : ''}`);
      const nameW = Math.max(14, W - 2 - 12 - 12 - 10 - 24 - 9 - 8);
      L.push(c('dim', `   ${pad('TABLE', nameW)} ${padL('MASTER ROWS', 11)} ${padL('SLAVE ROWS', 11)} ${padL('SIZE', 9)}  ${pad('STATUS', 24)}${padL('CHECKED', 9)}`));
      const rows = (it) => {
        if (it.scope && it.scope.mode === 'schema') return [null, null];
        const r = it.scope && it.scope.mode === 'range';
        return [r ? it.master.approxRows : it.masterRows != null ? it.masterRows : it.master.approxRows,
          it.slave ? (r ? it.slave.approxRows : it.slaveRows != null ? it.slaveRows : it.slave.approxRows) : null];
      };
      body = hit.sort((a, b) => a.name.localeCompare(b.name)).map((it) => {
        const [m, sl] = rows(it);
        const tag = it.scope && it.scope.tag ? c('cyan', ' ' + it.scope.tag) : '';
        return `   ${pad(it.name, nameW)} ${padL(fmtNum(m), 11)} ${padL(fmtNum(sl), 11)} ${padL(it.master ? fmtBytes(it.master.bytes) : '', 9)}  ${this.statusCell(it, 24)}${c('gray', padL(fmtAgo(it.checkedAt), 9))}${tag}`;
      });
      if (!hit.length && !this.scanning) body.push(c('gray', '   no table matches yet – check the config or rescan (R on the main screen)'));
    }

    // what the daemon / run-once wrote – the cron only fires in `sqlcpy daemon`, never in this window
    const file = logFile(this.app.cfg);
    const LOGH = Math.max(3, Math.min(10, Math.floor(H / 3)));
    if (!sch.logAt || Date.now() - sch.logAt > 1000) { sch.logLines = tailLog(file, 400); sch.logAt = Date.now(); }
    const lines = sch.logLines || [];
    sch.logScroll = Math.max(0, Math.min(sch.logScroll, lines.length - LOGH));
    const logBox = [c('gray', ' ' + '─'.repeat(W - 2)), ` ${A.bold}Scheduler log${A.reset} ${c('gray', file)}${sch.focus === 'log' ? c('cyan', '  ◂ focus') : ''}${sch.logScroll ? c('yellow', `  ↑${sch.logScroll} older`) : ''}`];
    if (lines.length) {
      const end = lines.length - sch.logScroll;
      for (const line of lines.slice(Math.max(0, end - LOGH), end)) logBox.push('   ' + c(/ ERROR /.test(line) ? 'red' : / WARN /.test(line) ? 'yellow' : 'gray', line));
    } else {
      logBox.push(c('yellow', '   nothing logged yet – the cron fires only while  node bin/sqlcpy.js daemon  (npm run daemon) is running;'));
      logBox.push(c('gray', '   press g to run once by hand, or start the daemon in another terminal (it works without this screen).'));
    }
    const bodyH = Math.max(1, H - L.length - 3 - logBox.length);
    sch.scroll = Math.max(0, Math.min(sch.scroll, body.length - bodyH));
    L.push(...body.slice(sch.scroll, sch.scroll + bodyH));
    while (L.length < H - 3 - logBox.length) L.push('');
    L.push(...logBox);
    L.push(c('gray', ' ' + '─'.repeat(W - 2)));
    L.push(sch.confirm
      ? ` ${c('yellow', 'Run the schedule NOW against the slave? This drops and reloads the listed tables.')}  ${c('bold', 'y')} ${c('gray', 'confirm |')} ${c('gray', 'any other key cancels')}`
      : sch.editing
        ? ` ${c('gray', 'type a cron expression – next runs update live |')} ${c('bold', 'enter')} ${c('gray', 'keep |')} ${c('bold', 'esc')} ${c('gray', 'discard')}`
        : hintLines([['e', 'try a cron expression'], ['c', 'back to config cron'], ['g', 'run now'], ['tab', 'table/log focus'], ['↑↓ PgUp/PgDn', 'scroll'], ['esc/t', 'back'], ['q', 'quit']], W)[0]);
    process.stdout.write('\x1b[H' + L.slice(0, H).map((l) => clip(l, W) + '\x1b[K').join('\n') + '\x1b[J');
  }

  async quit() {
    if (this.abort) this.abort.abort();
    this.stop();
    await this.app.close();
    process.exit(0);
  }

  statusCell(it, w) {
    const sp = SPIN[this.frame % SPIN.length];
    switch (it.status) {
      case 'same': return c('green', pad('● in sync', w));
      case 'different': return c('yellow', pad('◐ differs', w));
      case 'missing': return c('red', pad('○ missing in slave', w));
      case 'extra': return c('gray', pad('◇ only in slave', w));
      case 'queued': return c('magenta', pad('◆ queued', w));
      case 'error': return c('red', A.bold + pad('▲ error (see below)', w));
      case 'copying': {
        const p = this.progress;
        const frac = p && p.rowsTotal ? p.rowsDone / p.rowsTotal : 0;
        return c('cyan', sp + ' ') + bar(frac, w - 7) + c('cyan', ' ' + padL(Math.round(frac * 100) + '%', 4));
      }
      default: return c('gray', pad(sp + ' checking', w));
    }
  }

  render() {
    if (this.view === 'log') return this.renderLog();
    if (this.view === 'schedule') return this.renderSchedule();
    const W = Math.max(60, process.stdout.columns || 100);
    const H = Math.max(15, process.stdout.rows || 30);
    const items = this.sortedItems();
    const selectedItem = this.selected(items);
    const L = [];

    const m = this.app.cfg.master, s = this.app.cfg.slave;
    L.push(` ${A.bold}${A.cyan}sqlcpy${A.reset}  ${c('gray', 'master')} ${A.bold}${m.database}${A.reset}${c('gray', '@' + m.host)}  ${c('cyan', '➜')}  ${c('gray', 'slave')} ${A.bold}${s.database}${A.reset}${c('gray', '@' + s.host)}${this.app.ignored.length ? '  ' + c('gray', '· ' + this.app.ignored.length + ' ignored') : ''}`);
    const cnt = (st) => this.items.filter((i) => i.status === st).length;
    const tabs = [
      [null, 'cyan', `All ${this.items.length}`],
      ['same', 'green', `● In sync ${cnt('same')}`],
      ['different', 'yellow', `◐ Differ ${cnt('different')}`],
      ['missing', 'red', `○ Missing ${cnt('missing')}`],
      ['extra', 'gray', `◇ Extra ${cnt('extra')}`],
    ];
    if (cnt('error') || this.statusFilter === 'error') tabs.push(['error', 'red', `▲ Error ${cnt('error')}`]);
    tabs.push(['queued', 'magenta', `◆ Queued ${this.queue.length + (this.current ? 1 : 0)}`]);
    const tabBar = tabs.map(([key, col, label]) => (this.statusFilter === key ? A.inv + A[col] + A.bold + ` ${label} ` + A.reset : c(col, ` ${label} `))).join(c('gray', '│'));
    let left = '';
    if (this.filtering || this.filter || this.statusFilter) {
      left = ` ${c('cyan', '/')}${this.filter}${this.filtering ? c('cyan', '█') : ''} ${c('gray', `${items.length}/${this.items.length}${this.filtering ? ' · enter keep · esc clear' : ' · esc clear'}`)}`;
    }
    if (this.scanning) left += '  ' + c('gray', SPIN[this.frame % SPIN.length] + ' scanning ' + items.filter((i) => i.status !== 'checking').length + '/' + items.length);
    const visLen = (str) => str.replace(/\x1b\[[0-9;]*m/g, '').length;
    const gap = Math.max(1, W - 1 - visLen(left) - visLen(tabBar));
    L.push(left + ' '.repeat(gap) + tabBar);

    const scopeW = this.app.rules.empty ? 0 : 12; // SCOPE column only when a config has rules
    const nameW = Math.max(scopeW ? 12 : 16, W - 2 - 2 - 12 - 12 - 10 - 24 - 2 - 10 - scopeW);
    L.push(c('gray', ' ' + '─'.repeat(W - 2)));
    const indicator = (key) => this.sortBy === key ? (this.sortDirection === 1 ? '↑' : '↓') : '';
    L.push(c('dim', `   ${pad('NAME' + indicator('name'), nameW + 2)}${padL('MASTER ROWS' + indicator('masterRows'), 12)} ${padL('SLAVE ROWS' + indicator('slaveRows'), 11)} ${padL('SIZE' + indicator('size'), 9)}  ${pad('STATUS' + indicator('status'), 24)} ${scopeW ? pad('SCOPE', scopeW) : ''}${padL('CHECKED', 9)}`));

    // body rows (section headers interleaved)
    const rows = [];
    let lastKind = null;
    items.forEach((it, idx) => {
      if (it.kind !== lastKind) {
        lastKind = it.kind;
        const inKind = items.filter((i) => i.kind === it.kind);
        const bad = inKind.filter((i) => ['different', 'missing'].includes(i.status)).length;
        rows.push({ header: ` ${A.bold}${LABELS[it.kind]}${A.reset} ${c('gray', '(' + inKind.length + ')')}${bad ? ' ' + c('yellow', bad + ' need copy') : ''}` });
      }
      rows.push({ it, idx });
      if (it.scope && it.scope.mode === 'range') rows.push({ it, idx, scoped: true });
    });

    const help = hintLines([
      ['↑↓', 'move'], ['←→', 'tab section'], ['space', 'copy'], ['a', 'copy all'], ['f', 'force'],
      ['s', 'sort column'], ['S', 'sort ASC/DESC'], ['/', 'filter'], ['v', 'status filter'], ['l', 'log'], ['e', 'item log'],
      ['t', 'schedule'], ['x', 'cancel all'], ['c', 'cancel selected'], ['R', 'rescan all'], ['r', 'rescan selected'], ['q', 'quit'],
    ], W);
    const cur = this.current;
    const detailItem = cur || selectedItem;
    const hasScopeDetails = detailItem && detailItem.scope && detailItem.scope.mode !== 'full';
    const footerH = 8 + help.length + (hasScopeDetails ? 1 : 0);
    const bodyH = Math.max(3, H - L.length - footerH);
    const curRow = Math.max(0, rows.findIndex((r) => r.idx === this.cursor));
    const scopeRow = rows.findIndex((r) => r.idx === this.cursor && r.scoped);
    const curEndRow = scopeRow < 0 ? curRow : scopeRow;
    if (curRow < this.scroll) this.scroll = curRow;
    if (curEndRow >= this.scroll + bodyH) this.scroll = curEndRow - bodyH + 1;
    if (this.scroll > 0 && rows[this.scroll] && !rows[this.scroll].header && rows[this.scroll - 1]?.header && curRow > this.scroll) this.scroll--;

    for (const r of rows.slice(this.scroll, this.scroll + bodyH)) {
      if (r.header) { L.push(r.header); continue; }
      const it = r.it;
      const scoped = Boolean(r.scoped);
      const sel = !scoped && r.idx === this.cursor;
      const selected = r.idx === this.cursor;
      const schemaOnly = it.scope && it.scope.mode === 'schema'; // rows withheld on purpose – nothing to show
      const rangeScoped = it.scope && it.scope.mode === 'range';
      const mRows = it.kind !== 'tables' || schemaOnly ? null
        : scoped ? it.masterRows
          : rangeScoped ? it.master && it.master.approxRows
            : it.masterRows != null ? it.masterRows : it.master && it.master.approxRows;
      const sRows = it.kind !== 'tables' || schemaOnly ? null
        : scoped ? it.slaveRows
          : rangeScoped ? it.slave && it.slave.approxRows
            : it.slaveRows != null ? it.slaveRows : it.slave && it.slave.approxRows;
      const scopeText = pad((it.scope && it.scope.tag) || '', scopeW - 1);
      const scopeCell = scopeW ? c('cyan', scopeText) + ' ' : '';
      const size = scoped
        ? it.master && it.master.avgRowLength > 0 && it.masterRows != null
          ? `~${fmtBytes(it.masterRows * it.master.avgRowLength)}`
          : '-'
        : it.kind === 'tables' && it.master ? fmtBytes(it.master.bytes) : it.kind === 'triggers' && it.master ? it.master.table : '';
      const nameCol = pad(scoped ? `↳ ${it.scope.tag} scoped` : it.name, nameW);
      const line = `${sel ? '❯ ' : '  '}${nameCol}  ${padL(fmtNum(it.kind === 'tables' && it.master ? mRows : null), 11)} ${padL(fmtNum(it.kind === 'tables' && it.slave ? sRows : null), 11)} ${padL(size, 9)}  ${this.statusCell(it, 24)} ${scopeCell}${c('gray', padL(fmtAgo(it.checkedAt), 9))}`;
      // Keep the selected row uniformly white while retaining readable status and scope colors.
      L.push(selected ? selectedRow(line, W) : line);
    }
    if (!items.length) L.push(c('gray', '   No items match the filter'));
    while (L.length < 4 + bodyH) L.push('');

    // footer
    L.push(c('gray', ' ' + '─'.repeat(W - 2)));
    if (cur) {
      const p = this.progress || {};
      const frac = p.rowsTotal ? p.rowsDone / p.rowsTotal : 0;
      const el = p.started ? (Date.now() - p.started) / 1000 : 0;
      const spd = el > 0 ? p.bytesDone / el : 0;
      const eta = frac > 0 ? el / frac - el : 0;
      L.push(` ${c('cyan', SPIN[this.frame % SPIN.length])} ${A.bold}${cur.name}${A.reset} ${c('gray', p.phase === 'schema' ? 'creating schema…' : p.keyed === false ? '(no primary key – offset paging)' : '')}`);
      L.push(` ${bar(frac, Math.min(50, W - 40))} ${padL((frac * 100).toFixed(1) + '%', 6)}  ${fmtNum(p.rowsDone || 0)}/${fmtNum(p.rowsTotal || 0)} rows`);
      L.push(c('gray', `   chunk ${p.chunk || 0}/${p.chunks || 0} · ${fmtBytes(p.bytesDone || 0)} · ${fmtBytes(spd)}/s · ETA ${fmtTime(eta)} · elapsed ${fmtTime(el)}`));
    } else {
      const it = this.selected();
      const dcol = { same: 'green', different: 'yellow', missing: 'red', error: 'red', extra: 'gray' }[it && it.status] || 'gray';
      const detail = it ? (it.detail || it.status) + (it.checkedAt ? ` · checked ${new Date(it.checkedAt).toLocaleString()}` : '') : '';
      L.push(it ? ` ${A.bold}${it.name}${A.reset} ${c(dcol, '– ' + detail.slice(0, Math.max(10, W - it.name.length - 8)))}` : '');
      L.push(it && detail.length > W - it.name.length - 8 ? '   ' + c(dcol, detail.slice(W - it.name.length - 8, W * 2 - it.name.length - 16)) : '');
      L.push('');
    }
    if (hasScopeDetails) {
      const { scope } = detailItem;
      let details;
      if (scope.mode === 'schema') {
        details = `${scope.tag} · rows and size withheld`;
      } else {
        const rows = `master ${fmtNum(detailItem.masterRows)} rows · slave ${fmtNum(detailItem.slaveRows)} rows`;
        const rowLength = detailItem.master && detailItem.master.avgRowLength;
        const bytes = scope.mode === 'range'
          ? rowLength > 0 && detailItem.masterRows != null ? `~${fmtBytes(detailItem.masterRows * rowLength)} data` : '-'
          : detailItem.master && detailItem.master.bytes != null ? `~${fmtBytes(detailItem.master.bytes)} total` : '-';
        details = `${scope.tag} · ${rows} · size ${bytes}`;
      }
      L.push(c('gray', `   Scope: ${details}`));
    }
    const logs = this.log.slice(-3).map((e) => this.fmtLog(e));
    while (logs.length < 3) logs.unshift('');
    for (const l of logs) L.push(' ' + l);
    L.push(...help);

    process.stdout.write('\x1b[H' + L.slice(0, H).map((l) => clip(l, W) + '\x1b[K').join('\n') + '\x1b[J');
  }
}

module.exports = { UI };
