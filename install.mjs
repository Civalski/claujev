#!/usr/bin/env node
// Instalador do ClauJev. Funciona em Linux, macOS e Windows (Node 20+).
//
//   node install.mjs              instala ou atualiza
//   node install.mjs --link       instala com symlink (para quem vai editar o código)
//   node install.mjs --uninstall  remove os hooks do settings.json (mantém .env, config e logs)
//
// Pasta de instalação: $CLAUJEV_HOME ou ~/.claude/hooks/claujev
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, symlinkSync, rmSync, chmodSync, lstatSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO = dirname(fileURLToPath(import.meta.url));
const HOME_DIR = process.env.CLAUJEV_HOME || join(homedir(), '.claude', 'hooks', 'claujev');
const SETTINGS = join(homedir(), '.claude', 'settings.json');
const SCRIPT = join(HOME_DIR, 'claujev.mjs');
const args = new Set(process.argv.slice(2));

const [major] = process.versions.node.split('.').map(Number);
if (major < 20) {
  console.error(`ClauJev precisa de Node.js 20 ou mais novo (encontrado ${process.versions.node}).`);
  process.exit(1);
}

// Comando de cada hook. Barras normais funcionam em todos os sistemas.
const cmd = (hook) => `node "${SCRIPT.replace(/\\/g, '/')}" ${hook}`;
const entry = (hook, timeout) => ({ type: 'command', command: cmd(hook), timeout });
const HOOKS = {
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
    console.error(`Não consegui ler ${SETTINGS} (${e.message}). Corrija o JSON e rode de novo.`);
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

function install() {
  console.log('Instalando ClauJev\n');
  mkdirSync(HOME_DIR, { recursive: true });

  // Script do hook: cópia (padrão) ou symlink (--link).
  const src = join(REPO, 'hooks', 'claujev.mjs');
  try { if (lstatSync(SCRIPT)) rmSync(SCRIPT); } catch { /* não existia */ }
  if (args.has('--link')) symlinkSync(src, SCRIPT);
  else copyFileSync(src, SCRIPT);
  console.log(`  script    ${SCRIPT}${args.has('--link') ? ' (symlink)' : ''}`);

  // Config e .env só são criados se não existirem: atualizar nunca apaga o que você ajustou.
  const cfg = join(HOME_DIR, 'config.json');
  if (!existsSync(cfg)) { copyFileSync(join(REPO, 'config', 'config.example.json'), cfg); console.log(`  config    ${cfg}`); }
  else console.log(`  config    ${cfg} (mantido)`);

  const env = join(HOME_DIR, '.env');
  if (!existsSync(env)) {
    copyFileSync(join(REPO, 'config', '.env.example'), env);
    try { chmodSync(env, 0o600); } catch { /* Windows */ }
    console.log(`  chave     ${env}  <- preencha TYPESAFE_API_KEY`);
  } else console.log(`  chave     ${env} (mantido)`);

  const settings = readSettings();
  settings.hooks ||= {};
  removeOurHooks(settings);
  for (const [event, groups] of Object.entries(HOOKS)) settings.hooks[event] = [...(settings.hooks[event] || []), ...groups];
  writeSettings(settings);

  const legacy = Object.values(settings.hooks).flat().some(isLegacy);
  if (legacy) {
    console.log('\nAtenção: encontrei hooks de uma instalação antiga (jev-hook.mjs) no settings.json.');
    console.log('Remova essas entradas para o Jev não rodar duas vezes em cada evento.');
  }

  console.log(`
Pronto. Próximos passos:
  1. Coloque sua chave da TypeSafe em ${env}
  2. Teste:      node "${SCRIPT}" selftest
  3. Abra uma conversa nova no Claude Code para os hooks valerem.

Todos os hooks começam em modo "observe" (só registram no log).
Depois de alguns dias, veja "node \\"${SCRIPT}\\" report" e mude para "enforce" em ${cfg}.`);
}

function uninstall() {
  const settings = readSettings();
  removeOurHooks(settings);
  writeSettings(settings);
  console.log(`\nHooks removidos. Seus arquivos continuam em ${HOME_DIR} (apague a pasta se quiser).`);
}

if (args.has('--uninstall')) uninstall();
else install();
