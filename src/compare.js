'use strict';
const { resolveScope } = require('./scope');

/**
 * Compare one object across master and slave.
 * Returns { status: 'same'|'different'|'missing'|'extra', detail, masterRows?, slaveRows? }
 *
 * A table with a config rule is "in sync" when what the rule lets through matches:
 *   schema only  -> definitions are identical (rows are withheld on purpose)
 *   range        -> every master row inside the range is on the slave, unchanged
 *   masked       -> everything except the masked columns matches
 */
/**
 * Row counts for a table that cannot be fully compared (missing / schema differs), so the list and
 * the rescan note still show how much data is involved. Best effort: a failure here must not hide the
 * real status, so it yields nulls instead of throwing. Counts honour the table's scope (range rows only).
 */
async function bestEffortCounts(ctx, item) {
  const { master, slave, driver } = ctx;
  try {
    const scope = await resolveScope(ctx, item.name);
    if (scope.mode === 'schema') return { masterRows: null, slaveRows: null, scopeLabel: '' };
    const where = scope.where || null;
    const masterRows = await driver.count(master, item.name, where);
    let slaveRows = null;
    if (item.slave) {
      // the slave may lack the range column when its schema differs
      try { slaveRows = await driver.count(slave, item.name, where); } catch (e) { /* leave null */ }
    }
    return { masterRows, slaveRows, scopeLabel: scope.range ? ` in ${scope.range.text}` : '' };
  } catch (e) {
    return { masterRows: null, slaveRows: null, scopeLabel: '' };
  }
}

async function compareObject(ctx, kind, item) {
  const { master, slave, cfg, driver } = ctx;
  if (!item.master) return { status: 'extra', detail: 'exists only in slave' };
  if (!item.slave) {
    if (kind !== 'tables') return { status: 'missing', detail: 'missing in slave' };
    const { masterRows, slaveRows, scopeLabel } = await bestEffortCounts(ctx, item);
    const rows = masterRows != null ? ` · ${masterRows} row(s)${scopeLabel} on master, 0 on slave` : '';
    return { status: 'missing', detail: 'missing in slave' + rows, masterRows, slaveRows };
  }

  const [mSql, sSql] = await Promise.all([
    driver.getCreateSql(master, kind, item.name).then((s) => driver.normalizeSql(s, cfg.master.database)),
    driver.getCreateSql(slave, kind, item.name).then((s) => driver.normalizeSql(s, cfg.slave.database)),
  ]);
  if (mSql !== sSql) {
    if (kind !== 'tables') return { status: 'different', detail: 'definition differs' };
    const { masterRows, slaveRows, scopeLabel } = await bestEffortCounts(ctx, item);
    const rows = masterRows != null ? ` · rows${scopeLabel} ${masterRows} vs ${slaveRows != null ? slaveRows : '?'}` : '';
    return { status: 'different', detail: 'schema differs' + rows, masterRows, slaveRows };
  }
  if (kind !== 'tables') return { status: 'same', detail: 'definition identical' };

  const scope = await resolveScope(ctx, item.name);
  if (scope.mode === 'schema') {
    return { status: 'same', detail: 'schema identical · rows withheld (sensitive table)', masterRows: null, slaveRows: null };
  }

  const filtered = scope.mode !== 'full';
  const where = scope.where || null;
  const range = scope.range;
  const inRange = range ? `${range.text} (since ${range.since})` : '';
  const masked = scope.masked && scope.masked.length ? ` · ${scope.masked.length} masked col(s) skipped` : '';

  const mRows = await driver.count(master, item.name, where);
  const sRows = await driver.count(slave, item.name, where);
  const res = { masterRows: mRows, slaveRows: sRows };
  if (mRows !== sRows) return { ...res, status: 'different', detail: `rows${range ? ' in ' + inRange : ''} ${mRows} vs ${sRows}` };

  // A range is cheap to hash even when the whole table is huge, so size the gate on the range.
  const estBytes = range ? mRows * (item.master.avgRowLength || 0) : item.master.bytes;
  if (estBytes <= cfg.checksumMaxBytes) {
    const [a, b] = filtered
      ? [await driver.digest(master, item.name, scope.digestColumns, where), await driver.digest(slave, item.name, scope.digestColumns, where)]
      : [await driver.checksum(master, item.name), await driver.checksum(slave, item.name)];
    if (a !== b) return { ...res, status: 'different', detail: `data checksum differs${range ? ' in ' + inRange : ''}${masked}` };
    return { ...res, status: 'same', detail: `${range ? inRange + ': ' : ''}rows + checksum match${masked}` };
  }
  return { ...res, status: 'same', detail: `${range ? inRange + ': ' : ''}rows match (checksum skipped: large table)${masked}` };
}

module.exports = { compareObject };
