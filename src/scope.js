'use strict';

/**
 * Turn the policy for one table into concrete SQL fragments, validated against the live master schema.
 * Throws a readable Error when a rule cannot be applied safely – callers must treat that as "do not copy".
 *
 * Returns
 *   { mode: 'full' }                                         no rule: copy / compare the whole table as before
 *   { mode: 'schema' }                                       structure only, rows never read
 *   { mode: 'range'|'masked', select, columns, digestColumns, where, orderLead, range, masked }
 *       select         column list for SELECT (sensitive columns replaced by their mask expression)
 *       digestColumns  columns that take part in the sync checksum (everything except masked columns)
 *       where          { sql, params } for the range, or null
 *       orderLead      columns that must precede the primary key when paging (the range column)
 */
async function resolveScope(ctx, name) {
  const { master, cfg, driver } = ctx;
  const rule = cfg.rules.tableRule(name);
  if (rule.schemaOnly) return { mode: 'schema' };
  if (!rule.range && !rule.masks) return { mode: 'full' };

  const db = cfg.master.database;
  const cols = await driver.columns(master, db, name);
  const byName = new Map(cols.map((c) => [c.name.toLowerCase(), c]));
  const problems = [];
  const masks = new Map(); // lower-cased column -> replacement rule

  const key = (await driver.primaryKey(master, db, name)).map((c) => c.toLowerCase());
  if (rule.range) key.push(rule.range.column.toLowerCase()); // paging and range filtering read these raw

  for (const [col, mode] of Object.entries(rule.masks || {})) {
    const meta = byName.get(col.toLowerCase());
    if (!meta) problems.push(`sensitive column "${col}" does not exist (typo? it would otherwise be copied unprotected)`);
    else if (key.includes(meta.name.toLowerCase())) problems.push(`"${meta.name}" is a primary-key / range column and cannot be masked – list the whole table under sensitive.tables instead`);
    else {
      const why = driver.maskProblem(meta, mode, byName);
      if (why) problems.push(`"${meta.name}" ${why}`);
      else masks.set(meta.name.toLowerCase(), mode);
    }
  }

  for (const [col, mode] of masks) {
    if (!mode || typeof mode !== 'object') continue;
    const sources = mode.from ? [mode.from]
      : mode.concat ? mode.concat.filter((part) => typeof part !== 'string').map((part) => part.column)
        : [];
    for (const sourceName of sources) {
      const source = byName.get(sourceName.toLowerCase());
      if (!source) continue;
      if (source.name.toLowerCase() === col) {
        problems.push(`"${col}" cannot derive its replacement from itself`);
      } else if (masks.has(source.name.toLowerCase())) {
        problems.push(`"${col}" derives from "${source.name}", which is also masked; use an unmasked source column`);
      } else if (key.includes(source.name.toLowerCase())) {
        problems.push(`"${col}" derives from primary-key / range column "${source.name}"; choose a non-key source column`);
      }
    }
  }

  const scope = { mode: masks.size && !rule.range ? 'masked' : 'range', range: null, where: null, orderLead: [], masked: [] };

  if (rule.range) {
    const w = rule.range;
    const meta = byName.get(w.column.toLowerCase());
    if (!meta) problems.push(`range column "${w.column}" does not exist`);
    else if (!driver.isTemporal(meta)) problems.push(`range column "${meta.name}" is ${meta.type}; it must be a date, datetime or timestamp column`);
    else if (!w.allowUnindexed && !(await driver.indexedColumns(master, db, name)).has(meta.name.toLowerCase())) {
      problems.push(`range column "${meta.name}" has no index, so every chunk would scan the whole table on the master – add an index, or set "allowUnindexed": true for this table`);
    }
    if (!problems.length) {
      const since = await driver.cutoff(master, w);
      scope.range = { column: meta.name, since, label: w.label, text: w.text };
      scope.where = { sql: `${driver.quote(meta.name)} >= ?`, params: [since] };
      scope.orderLead = [meta.name];
    }
  }

  if (problems.length) throw new Error(`${name}: ${problems.join('; ')}`);

  const salt = cfg.maskSalt || '';
  scope.columns = cols.map((c) => c.name);
  scope.digestColumns = cols.filter((c) => !masks.has(c.name.toLowerCase())).map((c) => c.name);
  scope.masked = cols.filter((c) => masks.has(c.name.toLowerCase())).map((c) => c.name);
  scope.select = cols
    .map((c) => (masks.has(c.name.toLowerCase())
      ? `${driver.maskExpr(c, masks.get(c.name.toLowerCase()), salt)} AS ${driver.quote(c.name)}`
      : driver.quote(c.name)))
    .join(', ');
  return scope;
}

/** One line for dump headers / log messages, e.g. "last 30d (since 2026-09-13 10:00:00), masked: password, email". */
function describeScope(scope) {
  if (scope.mode === 'schema') return 'schema only – rows withheld by config';
  const parts = [];
  if (scope.range) parts.push(`${scope.range.text} on ${scope.range.column} (since ${scope.range.since})`);
  if (scope.masked && scope.masked.length) parts.push(`masked: ${scope.masked.join(', ')}`);
  return parts.join(', ');
}

module.exports = { resolveScope, describeScope };
