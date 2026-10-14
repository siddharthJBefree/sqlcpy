#!/usr/bin/env node
'use strict';
const path = require('path');
const { SqlCpy, loadConfig } = require('../src/index');
const { UI } = require('../src/ui');
const { describe } = require('../src/errors');

const col = (n, s) => `\x1b[${n}m${s}\x1b[0m`;
const red = (s) => col(31, s), green = (s) => col(32, s), yellow = (s) => col(33, s), cyan = (s) => col(36, s), gray = (s) => col(90, s), bold = (s) => col(1, s);

const COMMANDS = ['daemon', 'run-once'];

/** Unattended modes: no TTY needed. `daemon` follows schedule.cron; `run-once` does one pass (for OS cron / Task Scheduler). */
async function headless(command, cfg) {
  const { runOnce, startDaemon, makeLogger, logFile } = require('../src/schedule');
  const log = makeLogger(logFile(cfg));
  if (!cfg.rules.schedule) {
    log('ERROR', `no "schedule" block in ${cfg.rules.file || 'the config file'} – see sqlcpy.config.example.jsonc`);
    process.exit(1);
  }
  const app = new SqlCpy(cfg);
  app.headless = true;
  if (command === 'run-once') {
    let code = 0;
    try {
      const r = await runOnce(app, log);
      code = r.failed ? 2 : 0;
    } catch (e) {
      log('ERROR', describe(e).message);
      code = 1;
    }
    await app.close();
    process.exit(code);
  }
  startDaemon(app, log);
  const stop = async () => { log('INFO', 'stopping'); await app.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

async function main() {
  const command = COMMANDS.includes(process.argv[2]) ? process.argv[2] : null;
  const envPath = command ? process.argv[3] : process.argv[2];
  let cfg;
  try {
    cfg = loadConfig(envPath);
  } catch (e) {
    console.error(`${red('✖ Configuration error:')} ${e.message}`);
    console.error(gray(`  ${e.hint || `Looked for .env in ${process.cwd()} (or pass a path: sqlcpy path/to/.env)`}`));
    process.exit(1);
  }
  if (command) return headless(command, cfg);
  if (!process.stdin.isTTY) {
    console.error(red('✖ sqlcpy needs an interactive terminal.'));
    process.exit(1);
  }

  console.log(`\n ${bold(cyan('sqlcpy'))} ${gray('– checking connections')}\n`);
  const app = new SqlCpy(cfg);
  let failed = false;
  for (const side of ['master', 'slave']) {
    const { host, port, user, database } = cfg[side];
    const target = `${user}@${host}:${port}/${database}`;
    const t0 = Date.now();
    try {
      const [r] = await app[side].query('SELECT VERSION() AS v');
      if (side === 'master' && app.driver.assertReadOnly) await app.driver.assertReadOnly(app.master);
      console.log(` ${green('✔')} ${bold(side.padEnd(6))} ${target} ${gray(`MySQL ${r[0].v} · ${Date.now() - t0}ms`)}`);
    } catch (e) {
      failed = true;
      if (e.code === 'NOT_READ_ONLY') {
        console.log(` ${red('✖')} ${bold(side.padEnd(6))} ${target}`);
        console.log(`     ${red('Master user must be read-only.')}`);
        console.log(`     ${gray('Extra privileges:')} ${yellow(e.privileges.join(', '))}`);
        console.log(`\n     ${bold('Run this on the master as an admin, then set MASTER_USER / MASTER_PASSWORD to it:')}\n`);
        for (const line of [
          `CREATE USER 'backup_user'@'%' IDENTIFIED BY 'change_me';`,
          `GRANT SELECT, SHOW VIEW, TRIGGER, EXECUTE ON \`${database}\`.* TO 'backup_user'@'%';`,
          'FLUSH PRIVILEGES;',
        ]) console.log(`       ${cyan(line)}`);
        console.log('');
        continue;
      }
      const d = describe(e);
      console.log(` ${red('✖')} ${bold(side.padEnd(6))} ${target}`);
      console.log(`     ${red(d.code || 'ERROR')} ${d.message}`);
      if (d.hint) console.log(`     ${yellow('→ ' + d.hint)}`);
    }
  }
  if (failed) {
    console.log(`\n ${red('Cannot continue.')} ${gray('Fix the connection(s) above (values come from .env) and run sqlcpy again.')}\n`);
    await app.close();
    process.exit(1);
  }
  new UI(app).start();
}

main().catch((e) => {
  const d = describe(e);
  console.error(`${red('✖ ' + (d.code || 'Error'))} ${d.message}`);
  process.exit(1);
});
