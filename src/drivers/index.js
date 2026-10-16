'use strict';

// Add a new engine by dropping a driver module next to mysql.js and registering it here.
// Drivers load on first use, so an engine's client library is only needed when that engine is selected.
const loaders = {
  mysql: () => require('./mysql'),
  mariadb: () => require('./mysql'),
  postgres: () => require('./pg'),
  postgresql: () => require('./pg'),
  pg: () => require('./pg'),
};

const types = () => Object.keys(loaders);

function getDriver(type) {
  const load = loaders[type];
  if (!load) throw new Error(`Unsupported DB_TYPE "${type}". Supported: ${types().join(', ')}`);
  return load();
}

module.exports = { getDriver, types };
