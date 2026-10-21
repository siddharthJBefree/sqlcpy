'use strict';

const HASH_MIN_LENGTH = 16; // shorter hex strings collide too easily to keep unique indexes valid

/**
 * Validation of sensitive-column replacement rules, shared by every driver. Which replacements are legal
 * depends only on the column's type family, so each driver passes its own type vocabulary (sets of
 * lower-cased `col.type` values); the SQL that implements a replacement stays in the driver (maskExpr).
 */
function createMaskProblem({ stringTypes, textTypes, numberTypes, timeTypes }) {
  const maskCategory = (col) => (
    stringTypes.has(col.type) ? 'string'
      : numberTypes.has(col.type) ? 'number'
        : timeTypes.has(col.type) ? 'temporal' : null
  );

  /** Why `mode` cannot be applied to `col` on this engine, or null if it can. */
  return function maskProblem(col, mode, columns) {
    if (mode && typeof mode === 'object' && mode.when) {
      const { when, ...rest } = mode;
      if (!columns.get(when.column.toLowerCase())) return `"when" column "${when.column}" does not exist`;
      return maskProblem(col, rest, columns);
    }
    if (mode && typeof mode === 'object' && Array.isArray(mode.replace)) {
      if (!textTypes.has(col.type)) return `"replace" needs a text column (is ${col.type})`;
      if (col.maxLen != null && mode.replace.some(([a, b]) => b.length > a.length)) {
        return `"replace" could lengthen the text beyond the column limit of ${col.maxLen} – use replacements no longer than the text they replace`;
      }
      return null;
    }
    if (mode && typeof mode === 'object' && Object.prototype.hasOwnProperty.call(mode, 'value')) {
      const value = mode.value;
      if (value === null) return col.nullable ? null : 'is NOT NULL, so a null custom value would fail the insert';
      const category = maskCategory(col);
      if (typeof value === 'string' && (category === 'string' || category === 'temporal')) {
        if (col.maxLen != null && value.length > col.maxLen) return `has length ${col.maxLen}, shorter than the custom value`;
        return null;
      }
      if (typeof value === 'number' && Number.isFinite(value) && category === 'number') return null;
      if (typeof value === 'boolean' && category === 'number') return null;
      return `type ${col.type} is incompatible with the custom value`;
    }
    if (mode && typeof mode === 'object' && typeof mode.from === 'string') {
      const source = columns.get(mode.from.toLowerCase());
      if (!source) return `source column "${mode.from}" does not exist`;
      const targetCategory = maskCategory(col);
      if (!targetCategory || targetCategory !== maskCategory(source)) {
        return `cannot derive from "${source.name}" (${source.type}) because it is not compatible with ${col.type}`;
      }
      if (!col.nullable && source.nullable) return `cannot derive from nullable column "${source.name}" because this column is NOT NULL`;
      if (col.maxLen != null && source.maxLen != null && source.maxLen > col.maxLen) {
        return `cannot derive from "${source.name}" because its maximum length (${source.maxLen}) exceeds ${col.maxLen}`;
      }
      return null;
    }
    if (mode && typeof mode === 'object' && Array.isArray(mode.concat)) {
      if (!textTypes.has(col.type)) return `"concat" needs a text column (is ${col.type})`;
      let length = 0;
      for (const part of mode.concat) {
        if (typeof part === 'string') {
          length += part.length;
          continue;
        }
        const source = columns.get(part.column.toLowerCase());
        if (!source) return `source column "${part.column}" does not exist`;
        if (!textTypes.has(source.type)) return `cannot concatenate "${source.name}" because it is not a text column`;
        if (!col.nullable && source.nullable) return `cannot concatenate nullable column "${source.name}" into this NOT NULL column`;
        if (source.maxLen == null) length = null;
        else if (length != null) length += source.maxLen;
      }
      if (mode.maxLength != null) length = length == null ? mode.maxLength : Math.min(length, mode.maxLength);
      if (length != null && col.maxLen != null && length > col.maxLen) {
        return `may produce ${length} characters, exceeding its length limit of ${col.maxLen}`;
      }
      return null;
    }
    if (mode === 'random') {
      if (textTypes.has(col.type) || numberTypes.has(col.type)) return null;
      return `"random" needs a text or numeric column (is ${col.type})`;
    }
    if (mode === 'null') return col.nullable ? null : 'is NOT NULL, so "null" would fail the insert – use "empty" or "hash"';
    if (mode === 'empty') return stringTypes.has(col.type) || numberTypes.has(col.type) ? null : `type ${col.type} cannot be blanked – use "null"`;
    if (mode === 'hash') {
      if (!stringTypes.has(col.type)) return `"hash" needs a text/binary column (is ${col.type})`;
      if (col.maxLen != null && col.maxLen < HASH_MIN_LENGTH) return `is only ${col.maxLen} characters – too short to hash without collisions, use "empty" or "null"`;
      return null;
    }
    return `unknown mode ${mode}`;
  };
}

module.exports = { createMaskProblem };
