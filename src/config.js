'use strict';
const path = require('path');
const dotenv = require('dotenv');
const { getDriver } = require('./drivers');
const { Rules } = require('./rules');

function load(envPath) {
  dotenv.config({ path: envPath || path.join(process.cwd(), '.env') });
  const e = process.env;
  const type = String(e.DB_TYPE || 'mysql').toLowerCase();
  const driver = getDriver(type); // throws on unsupported type
  const side = (p) => ({
    host: e[`${p}_HOST`],
    port: Number(e[`${p}_PORT`] || driver.defaultPort),
    user: e[`${p}_USERNAME`],
    password: e[`${p}_PASSWORD`] || '',
    database: e[`${p}_DATABASE`],
  });
  const cfg = {
    type, // master and slave are always the same engine
    master: side('MASTER'),
    slave: side('SLAVE'),
    chunkBytes: Number(e.CHUNK_BYTES || 1024 * 1024),
    chunkDelayMs: Number(e.CHUNK_DELAY_MS || 100),
    concurrency: Number(e.CONCURRENCY || 1),
    checksumMaxBytes: Number(e.CHECKSUM_MAX_MB || 50) * 1024 * 1024,
    dumpDir: path.resolve(e.DUMP_DIR || path.join(process.cwd(), 'dumps')),
  };
  cfg.cacheFile = path.resolve(e.CACHE_FILE || path.join(cfg.dumpDir, '.sqlcpy-cache.json'));
  // Policy file: what to ignore / withhold / copy partially. Named explicitly => must exist.
  cfg.maskSalt = e.MASK_SALT || '';
  cfg.configFile = path.resolve(e.CONFIG_FILE || path.join(process.cwd(), 'sqlcpy.config.jsonc'));
  cfg.configRequired = Boolean(e.CONFIG_FILE);
  cfg.rules = Rules.load(cfg.configFile, { required: cfg.configRequired, salt: cfg.maskSalt });
  for (const s of ['master', 'slave']) {
    for (const k of ['host', 'user', 'database']) {
      if (!cfg[s][k]) throw new Error(`Missing ${s.toUpperCase()}_${k === 'user' ? 'USERNAME' : k.toUpperCase()} in .env`);
    }
  }
  if (!Number.isInteger(cfg.concurrency) || cfg.concurrency < 1 || cfg.concurrency > 10) {
    throw new Error(`CONCURRENCY must be a whole number between 1 and 10 (got "${e.CONCURRENCY}") in .env`);
  }
  return cfg;
}

module.exports = { load };
