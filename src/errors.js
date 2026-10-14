'use strict';

const HINTS = {
  ETIMEDOUT: 'Host did not answer. Is the VPN / tunnel up and is the host:port correct? Try: Test-NetConnection <host> -Port <port>',
  ECONNREFUSED: 'Nothing is listening on that host:port. Is MySQL running / is the SSH tunnel open?',
  ENOTFOUND: 'Host name could not be resolved. Check *_HOST in .env.',
  EHOSTUNREACH: 'No route to host. Check VPN / network.',
  ECONNRESET: 'Connection was dropped by the server or a firewall.',
  PROTOCOL_CONNECTION_LOST: 'Connection to the server was lost.',
  ER_ACCESS_DENIED_ERROR: 'Wrong username or password (or this host is not allowed to connect).',
  ER_DBACCESS_DENIED_ERROR: 'This user has no access to that database.',
  ER_BAD_DB_ERROR: 'Database does not exist. Check *_DATABASE in .env.',
  ER_TABLEACCESS_DENIED_ERROR: 'User lacks privileges on this table (SELECT on master / CREATE, DROP, INSERT on slave).',
  ER_SPECIFIC_ACCESS_DENIED_ERROR: 'User lacks a required privilege (e.g. SUPER / SET_USER_ID for triggers and routines).',
  ER_PARSE_ERROR: 'The definition could not be parsed by the slave server (version mismatch?).',
  ER_NET_PACKET_TOO_LARGE: 'Statement exceeded max_allowed_packet. Lower CHUNK_BYTES in .env.',
  ER_LOCK_WAIT_TIMEOUT: 'Timed out waiting for a lock. Try again when the table is less busy.',
  ER_LOCK_DEADLOCK: 'Deadlock detected. Try again.',
  ER_NO_REFERENCED_ROW_2: 'Foreign key violation. Copy the parent table first.',
  ER_CANT_CREATE_TABLE: 'Could not create table (usually a missing parent table for a foreign key).',
  ER_NO_SUCH_TABLE: 'A table this object depends on does not exist on the slave. Copy tables before views/triggers.',
  ER_VIEW_INVALID: 'View references a table/column missing on the slave. Copy its tables first.',
};

/** Normalize any thrown error into { code, message, hint } */
function describe(e) {
  const code = e.code || (e.errno ? String(e.errno) : '');
  const sqlMsg = e.sqlMessage || e.message || String(e);
  return {
    code,
    message: sqlMsg.replace(/\s+/g, ' ').trim(),
    hint: HINTS[code] || '',
  };
}

module.exports = { describe };
