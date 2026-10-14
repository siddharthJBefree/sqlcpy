'use strict';

// Add a new engine by dropping a driver module next to mysql.js and registering it here.
const drivers = {
  mysql: require('./mysql'),
};
drivers.mariadb = drivers.mysql;

const types = () => Object.keys(drivers);

function getDriver(type) {
  const d = drivers[type];
  if (!d) throw new Error(`Unsupported DB_TYPE "${type}". Supported: ${types().join(', ')}`);
  return d;
}

module.exports = { getDriver, types };
