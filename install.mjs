#!/usr/bin/env node
// ClauJev. Copyright (c) 2026 Alisson Civalski — MIT License — https://github.com/Civalski/claujev
// Manual installer for ClauJev (the plugin is the recommended way). Linux, macOS and Windows, Node 20+.
//
//   node install.mjs              install or update
//   node install.mjs --link       install with a symlink (if you are going to edit the code)
//   node install.mjs --uninstall  remove the hooks from settings.json (keeps .env, config and logs)
//   node install.mjs --force      install even if the ClauJev plugin is installed
//
// Folder: $CLAUJEV_HOME or ~/.claude/claujev
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, symlinkSync, rmSync, chmodSync, lstatSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO = dirname(fileURLToPath(import.meta.url));
const HOME_DIR = process.env.CLAUJEV_HOME || join(homedir(), '.claude', 'claujev');
const PLUGIN = join(REPO, 'plugins', 'claujev');
const SETTINGS = join(homedir(), '.claude', 'settings.json');
const SCRIPT = join(HOME_DIR, 'claujev.mjs');
const args = new Set(process.argv.slice(2));

const [major] = process.versions.node.split('.').map(Number);
if (major < 20) {
  console.error(`ClauJev needs Node.js 20 or newer (found ${process.versions.node}).`);
  process.exit(1);
}

// Command of each hook. Forward slashes work on every system.
const cmd = (hook) => `node "${SCRIPT.replace(/\\/g, '/')}" ${hook}`;
const entry = (hook, timeout) => ({ type: 'command', command: cmd(hook), timeout });
const HOOKS = {
  SessionStart: [{ hooks: [entry('session', 10)] }],
  UserPromptSubmit: [{ hooks: [entry('prompt', 15)] }],
  PreToolUse: [
    { matcher: 'Bash|PowerShell', hooks: [entry('bash', 15)] },
    { matcher: 'Agent', hooks: [entry('agent', 15)] },
  ],
  PostToolUse: [{ matcher: 'Edit|Write|MultiEdit|NotebookEdit', hooks: [entry('edit', 15)] }],
  Stop: [{ hooks: [entry('stop', 60)] }],
  SubagentStop: [{ hooks: [entry('subagent', 20)] }],
};

const isOurs = (group) => JSON.stringify(group).includes('claujev.mjs');
const isLegacy = (group) => JSON.stringify(group).includes('jev-hook.mjs');

function readSettings() {
  if (!existsSync(SETTINGS)) return {};
  try {
    return JSON.parse(readFileSync(SETTINGS, 'utf8'));
  } catch (e) {
    console.error(`Could not read ${SETTINGS} (${e.message}). Fix the JSON and run again.`);
    process.exit(1);
  }
}

function writeSettings(settings) {
  mkdirSync(dirname(SETTINGS), { recursive: true });
  if (existsSync(SETTINGS)) {
    const backup = `${SETTINGS}.claujev-backup`;
    copyFileSync(SETTINGS, backup);
    console.log(`  backup    ${backup}`);
  }
  writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
  console.log(`  hooks     ${SETTINGS}`);
}

function removeOurHooks(settings) {
  for (const event of Object.keys(settings.hooks || {})) {
    settings.hooks[event] = settings.hooks[event].filter((g) => !isOurs(g));
    if (!settings.hooks[event].length) delete settings.hooks[event];
  }
}

// The plugin registers its own hooks: installing both would run Jev twice per event.
function pluginInstalled() {
  try {
    const data = JSON.parse(readFileSync(join(homedir(), '.claude', 'plugins', 'installed_plugins.json'), 'utf8'));
    return Object.keys(data.plugins || {}).some((k) => k.startsWith('claujev@'));
  } catch { return false; }
}

function install() {
  if (pluginInstalled() && !args.has('--force')) {
    console.error('The ClauJev plugin is already installed and registers its own hooks.');
    console.error('Installing here too would run Jev twice per event. Use --force if you really want it.');
    process.exit(1);
  }
  console.log('Installing ClauJev\n');
  mkdirSync(HOME_DIR, { recursive: true });

  // Hook script: a copy (default) or a symlink (--link).
  const src = join(PLUGIN, 'hooks', 'claujev.mjs');
  try { if (lstatSync(SCRIPT)) rmSync(SCRIPT); } catch { /* did not exist */ }
  if (args.has('--link')) symlinkSync(src, SCRIPT);
  else copyFileSync(src, SCRIPT);
  console.log(`  script    ${SCRIPT}${args.has('--link') ? ' (symlink)' : ''}`);

  // Config and .env are only created when missing: updating never overwrites your changes.
  const cfg = join(HOME_DIR, 'config.json');
  if (!existsSync(cfg)) { copyFileSync(join(PLUGIN, 'config', 'config.example.json'), cfg); console.log(`  config    ${cfg}`); }
  else console.log(`  config    ${cfg} (kept)`);

  const env = join(HOME_DIR, '.env');
  if (!existsSync(env)) {
    copyFileSync(join(PLUGIN, 'config', '.env.example'), env);
    try { chmodSync(env, 0o600); } catch { /* Windows */ }
    console.log(`  key       ${env}  <- fill in TYPESAFE_API_KEY`);
  } else console.log(`  key       ${env} (kept)`);

  const settings = readSettings();
  settings.hooks ||= {};
  removeOurHooks(settings);
  for (const [event, groups] of Object.entries(HOOKS)) settings.hooks[event] = [...(settings.hooks[event] || []), ...groups];
  writeSettings(settings);

  const legacy = Object.values(settings.hooks).flat().some(isLegacy);
  if (legacy) {
    console.log('\nWarning: settings.json has hooks from an old install (jev-hook.mjs).');
    console.log('Remove those entries so Jev does not run twice per event.');
  }

  console.log(`
Done. Next steps:
  1. Put your TypeSafe AI key in ${env}
  2. Test:       node "${SCRIPT}" selftest
  3. Open a new Claude Code session so the hooks take effect.

Every hook starts in "observe" mode (it only logs). Messages are in English;
set "lang": "pt" in ${cfg} for Portuguese.
After a few days, check "node \\"${SCRIPT}\\" report" and switch to "enforce" in ${cfg}.`);
}

function uninstall() {
  const settings = readSettings();
  removeOurHooks(settings);
  writeSettings(settings);
  console.log(`\nHooks removed. Your files are still in ${HOME_DIR} (delete the folder if you want).`);
}

if (args.has('--uninstall')) uninstall();
else install();
