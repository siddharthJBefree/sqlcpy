'use strict';
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const config = require('./config');
const { getDriver } = require('./drivers');
const { KINDS, LABELS } = require('./objects');
const { compareObject } = require('./compare');
const { copyObject } = require('./copier');
const { Rules, globToRegExp } = require('./rules');

/**
 * Library entry. Events: 'items' (after listing), 'item' (an item changed).
 *   const s = new SqlCpy(config.load());
 *   await s.scan(); await s.copy(s.items[0]);
 */
class SqlCpy extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.driver = getDriver(cfg.type);
    this.master = this.driver.createPool(cfg.master, cfg.concurrency);
    this.slave = this.driver.createPool(cfg.slave, cfg.concurrency);
    this.rules = cfg.rules;
    this.items = [];
    this.ignored = []; // [{ kind, name }] hidden by the config's "ignore" rules
    this.warnings = [];
    this.headless = false; // true in daemon / run-once: never write the UI's scan cache
  }

  get ctx() {
    return { master: this.master, slave: this.slave, cfg: this.cfg, driver: this.driver };
  }

  /** Reload the policy file; keep the active rules unchanged if the new file is invalid. */
  reloadConfig() {
    const rules = Rules.load(this.cfg.configFile, {
      required: this.cfg.configRequired,
      salt: this.cfg.maskSalt,
    });
    if (rules.fingerprint === this.rules.fingerprint) return false;
    this.rules = rules;
    this.cfg.rules = rules;
    return true;
  }

  /** Throws unless the master user is read-only (checked once per run). */
  async ensureReadOnlyMaster() {
    if (!this.driver.assertReadOnly) return;
    if (!this._readOnlyCheck) this._readOnlyCheck = this.driver.assertReadOnly(this.master);
    await this._readOnlyCheck;
  }

  /** List both sides with the config's "ignore" rules applied, so ignored objects are never compared, copied or dropped. */
  async _list() {
    const { driver, cfg } = this;
    await this.ensureReadOnlyMaster();
    const [m, s] = await Promise.all([driver.listObjects(this.master, cfg.master.database), driver.listObjects(this.slave, cfg.slave.database)]);
    const fm = this.rules.filter(m);
    const fsl = this.rules.filter(s);
    const seen = new Set();
    this.ignored = [...fm.ignored, ...fsl.ignored].filter((x) => !seen.has(x.kind + ':' + x.name) && seen.add(x.kind + ':' + x.name));
    return [fm.listing, fsl.listing];
  }

  _scopeOf(item) {
    return item.kind === 'tables' ? this.rules.scopeOf(item.name) : null;
  }

  /** Problems the user should see right away: unmatched protection rules, and old dumps written before a table was protected. */
  _warnings() {
    const out = [];
    const tables = [...this.items.filter((i) => i.kind === 'tables' && i.master), ...this.ignored.filter((i) => i.kind === 'tables')];
    out.push(...this.rules.unmatched(tables.map((t) => t.name)));
    const dir = path.join(this.cfg.dumpDir, this.cfg.master.database);
    const ignored = new Set(this.ignored.filter((i) => i.kind === 'tables').map((i) => i.name));
    for (const t of tables) {
      if (!ignored.has(t.name) && this.rules.scopeOf(t.name).mode === 'full') continue;
      const file = path.join(dir, t.name + '.sql');
      try {
        const head = Buffer.alloc(400);
        const fd = fs.openSync(file, 'r');
        const n = fs.readSync(fd, head, 0, head.length, 0);
        fs.closeSync(fd);
        // dumps written under a rule carry a "-- scope:" line; anything else predates the rule and holds real rows
        if (ignored.has(t.name) || !head.toString('utf8', 0, n).includes('-- scope:')) {
          out.push(`stale dump ${file} was written before ${t.name} was protected and may contain real rows – delete it`);
        }
      } catch (e) { /* no dump – nothing to warn about */ }
    }
    return out;
  }

  get cacheKey() {
    const { cfg } = this;
    const side = (x) => `${x.host}:${x.port}/${x.database}`;
    return `${cfg.type}|${side(cfg.master)}|${side(cfg.slave)}|rules:${this.rules.fingerprint}`;
  }

  /** Restore items from the cache file; returns the scan time, or null if there is no usable cache. */
  _loadCache() {
    try {
      const data = JSON.parse(fs.readFileSync(this.cfg.cacheFile, 'utf8'));
      if (data.key !== this.cacheKey || !Array.isArray(data.items) || !data.items.length) return null;
      this.items = data.items.map((it) => ({ detail: '', ...it }));
      for (const it of this.items) it.scope = this._scopeOf(it);
      this.ignored = Array.isArray(data.ignored) ? data.ignored : [];
      this.scannedAt = data.scannedAt || null;
      return this.scannedAt || Date.now();
    } catch (e) {
      return null;
    }
  }

  _saveCache() {
    if (this.scanning || this._stop || this.headless) return; // a scheduled run must not overwrite the UI's scan cache
    const items = this.items.map((it) => {
      const status = it.status === 'queued' || it.status === 'copying' ? (it.prevStatus || 'different') : it.status;
      const { kind, name, master, slave, detail, masterRows, slaveRows, checkedAt } = it;
      return { kind, name, master, slave, status, detail, masterRows, slaveRows, checkedAt };
    });
    try {
      const json = JSON.stringify({ key: this.cacheKey, scannedAt: this.scannedAt, ignored: this.ignored, items }, (k, v) => (typeof v === 'bigint' ? Number(v) : v));
      fs.mkdirSync(path.dirname(this.cfg.cacheFile), { recursive: true });
      fs.writeFileSync(this.cfg.cacheFile, json);
    } catch (e) { /* cache is best-effort */ }
  }

  /**
   * Use the cached result when there is one (unless force), otherwise list both sides
   * and compare each object one at a time (gentle on the master).
   * Resolves to { cached, at }.
   */
  async scan({ force = false } = {}) {
    await this.ensureReadOnlyMaster(); // also when serving the cache, so a writable master is never used silently
    if (!force) {
      const at = this._loadCache();
      if (at) { this.warnings = this._warnings(); this.emit('items', this.items); return { cached: true, at }; }
    }
    this.scanning = true;
    try {
      const [m, s] = await this._list();
      this.items = [];
      for (const kind of KINDS.filter((k) => this.driver.kinds.includes(k))) {
        const names = new Set([...m[kind].map((x) => x.name), ...s[kind].map((x) => x.name)]);
        for (const name of [...names].sort()) {
          this.items.push({
            kind, name,
            master: m[kind].find((x) => x.name === name) || null,
            slave: s[kind].find((x) => x.name === name) || null,
            status: 'checking', detail: '', scope: this._scopeOf({ kind, name }),
          });
        }
      }
      this.emit('items', this.items);
      for (const it of this.items) {
        if (this._stop) return { cached: false, at: null };
        await this.check(it);
      }
      this.scannedAt = Date.now();
      this.warnings = this._warnings();
    } finally {
      this.scanning = false;
    }
    this._saveCache();
    return { cached: false, at: this.scannedAt };
  }

  /**
   * Table items whose names match any of the patterns (globs, case-insensitive), compared with the slave
   * only when the caller checks them. Used by scheduled runs and the schedule preview.
   * Resolves to { items, unmatched: [patterns that matched no table on the master] }.
   */
  async tablesMatching(patterns) {
    const [m, s] = await this._list();
    const res = patterns.map((p) => ({ pattern: p, re: globToRegExp(p), hit: false }));
    const items = [];
    for (const t of m.tables) {
      const hits = res.filter((r) => r.re.test(t.name));
      if (!hits.length) continue;
      hits.forEach((r) => { r.hit = true; });
      items.push({ kind: 'tables', name: t.name, master: t, slave: s.tables.find((x) => x.name === t.name) || null, status: 'checking', detail: '', scope: this._scopeOf({ kind: 'tables', name: t.name }) });
    }
    items.sort((a, b) => a.name.localeCompare(b.name));
    return { items, unmatched: res.filter((r) => !r.hit).map((r) => r.pattern) };
  }

  async check(item) {
    item.status = 'checking';
    this.emit('item', item);
    try {
      Object.assign(item, await compareObject(this.ctx, item.kind, item));
    } catch (e) {
      item.status = 'error';
      item.detail = e.message;
    }
    item.checkedAt = Date.now();
    this.emit('item', item);
    return item;
  }

  /** Re-list both sides and re-compare a single object. Resolves to null if it no longer exists anywhere. */
  async recheck(item) {
    const [m, s] = await this._list();
    item.master = m[item.kind].find((x) => x.name === item.name) || null;
    item.slave = s[item.kind].find((x) => x.name === item.name) || null;
    if (!item.master && !item.slave) {
      this.items = this.items.filter((i) => i !== item);
      this.emit('items', this.items);
      this._saveCache();
      return null;
    }
    await this.check(item);
    this._saveCache();
    return item;
  }

  /** Copy one object master -> slave, then re-compare. */
  async copy(item, { onProgress, signal, swap = false } = {}) {
    const res = await copyObject({ ...this.ctx, swap }, item.kind, item, onProgress, signal);
    const [m, s] = await this._list();
    item.master = m[item.kind].find((x) => x.name === item.name) || item.master;
    item.slave = s[item.kind].find((x) => x.name === item.name) || null;
    await this.check(item);
    this._saveCache();
    return res;
  }

  async close() {
    this._stop = true;
    await Promise.allSettled([this.master.end(), this.slave.end()]);
  }
}

module.exports = { SqlCpy, loadConfig: config.load, KINDS, LABELS };
