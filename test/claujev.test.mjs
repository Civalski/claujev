import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(REPO, 'plugins', 'claujev', 'hooks', 'claujev.mjs');

// Isolated folder: the tests never read the real config of whoever runs them.
const home = mkdtempSync(join(tmpdir(), 'claujev-'));
process.env.CLAUJEV_HOME = join(home, 'claujev');
for (const k of Object.keys(process.env)) if (k.startsWith('CLAUDE_PLUGIN_OPTION_')) delete process.env[k];
const m = await import('../plugins/claujev/hooks/claujev.mjs');

const project = (name, cfg) => {
  const dir = join(home, name);
  mkdirSync(join(dir, '.claude'), { recursive: true });
  if (cfg) writeFileSync(join(dir, '.claude', 'claujev.json'), JSON.stringify(cfg));
  return dir;
};

test('band: low / uncertain / high', () => {
  const t = { low: 0.5, high: 0.8 };
  assert.equal(m.band(0.1, t), 'low');
  assert.equal(m.band(0.6, t), 'uncertain');
  assert.equal(m.band(0.8, t), 'high');
  assert.equal(m.band(undefined, t), null);
  assert.equal(m.band(0.7, 0.7), 'high', 'old single-number threshold still works');
});

test('normScore: maps any scale to 0..1', () => {
  assert.equal(m.normScore({ score: 0, legend: { 0: 'a', 1: 'b', 2: 'c', 3: 'd', 4: 'e' } }), 0);
  assert.equal(m.normScore({ score: 4, legend: { 0: 'a', 1: 'b', 2: 'c', 3: 'd', 4: 'e' } }), 1);
  assert.equal(m.normScore({ score: 3, legend: { 1: 'a', 2: 'b', 3: 'c' } }), 1);
  assert.equal(m.normScore({ score: 1, legend: { 1: 'only one level' } }), null);
});

test('redact: removes secrets before anything is sent to Jev', () => {
  const out = m.redact([
    'const key = "sk-ant-abcdefghijklmnopqrstuvwxyz"',
    'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456',
    'password=hunter2hunter2',
    '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----',
  ].join('\n'));
  assert.ok(!out.includes('abcdefghijklmnopqrstuvwxyz'));
  assert.ok(!out.includes('hunter2'));
  assert.ok(!out.includes('MIIabc'));
  assert.match(out, /SECRET REMOVED/);
  assert.match(out, /KEY REMOVED/);
});

test('isReadOnly: the shortcut only applies to plain reads', () => {
  assert.equal(m.isReadOnly('git status'), true);
  assert.equal(m.isReadOnly('ls -la src'), true);
  assert.equal(m.isReadOnly('git status && rm -rf /'), false, 'chaining disqualifies');
  assert.equal(m.isReadOnly('cat .env'), false, 'sensitive files always go through Jev');
  assert.equal(m.isReadOnly('find . -delete'), false);
  assert.equal(m.isReadOnly('rm -rf build'), false);
  assert.equal(m.isReadOnly('echo $(whoami)'), false);
});

test('loadConfig: defaults < global < project, rules are added up', () => {
  mkdirSync(process.env.CLAUJEV_HOME, { recursive: true });
  writeFileSync(join(process.env.CLAUJEV_HOME, 'config.json'), JSON.stringify({ hooks: { bash: 'enforce' }, rules: ['global'] }));
  const cfg = m.loadConfig(project('p1', { hooks: { edit: 'enforce' }, rules: ['project'], verify: 'npm test' }));
  assert.equal(cfg.hooks.bash, 'enforce');
  assert.equal(cfg.hooks.edit, 'enforce');
  assert.equal(cfg.hooks.stop, 'observe', 'untouched values keep the default');
  assert.equal(cfg.verify, 'npm test');
  assert.equal(cfg.lang, 'en', 'English is the default');
  assert.deepEqual(cfg.rules.slice(-2), ['global', 'project']);
  assert.equal(cfg.rules.length, m.TEXT.en.rules.length + 2);
});

test('loadConfig: replace_rules replaces the built-in rules', () => {
  assert.deepEqual(m.loadConfig(project('p2', { rules: ['only this'], replace_rules: true })).rules, ['only this']);
});

test('loadConfig: lang "pt" switches the built-in rules too', () => {
  const cfg = m.loadConfig(project('p3', { lang: 'pt' }));
  assert.equal(cfg.lang, 'pt');
  assert.ok(cfg.rules.includes(m.TEXT.pt.rules[0]));
  assert.ok(!cfg.rules.includes(m.TEXT.en.rules[0]));
});

test('loadConfig: plugin options set lang and mode, project config still wins', () => {
  process.env.CLAUDE_PLUGIN_OPTION_LANG = 'pt';
  process.env.CLAUDE_PLUGIN_OPTION_MODE = 'enforce';
  try {
    const cfg = m.loadConfig(project('p4', { hooks: { stop: 'off' } }));
    assert.equal(cfg.lang, 'pt');
    assert.equal(cfg.hooks.prompt, 'enforce');
    assert.equal(cfg.hooks.stop, 'off');
  } finally {
    delete process.env.CLAUDE_PLUGIN_OPTION_LANG;
    delete process.env.CLAUDE_PLUGIN_OPTION_MODE;
  }
});

test('feature menu: each feature follows the mode, can be set alone, and "off" always wins', () => {
  const env = { CLAUDE_PLUGIN_OPTION_MODE: 'enforce', CLAUDE_PLUGIN_OPTION_TRIAGE: 'mode', CLAUDE_PLUGIN_OPTION_RULE_REVIEW: 'observe', CLAUDE_PLUGIN_OPTION_COMMAND_GUARD: 'off' };
  Object.assign(process.env, env);
  try {
    // The project tries to turn the command guard on: the user's "off" still wins.
    const cfg = m.loadConfig(project('p5', { hooks: { bash: 'enforce', stop: 'observe' } }));
    assert.equal(cfg.hooks.prompt, 'enforce', '"mode" follows the Mode setting');
    assert.equal(cfg.hooks.edit, 'observe', 'a feature can have its own mode');
    assert.equal(cfg.hooks.bash, 'off', 'off in the menu beats the project config');
    assert.equal(cfg.hooks.stop, 'observe', 'the project config still tunes features left on');
  } finally {
    for (const k of Object.keys(env)) delete process.env[k];
  }
});

test('plugin manifest: the install screen only asks for the API key', () => {
  const opts = JSON.parse(readFileSync(join(REPO, 'plugins', 'claujev', '.claude-plugin', 'plugin.json'), 'utf8')).userConfig;
  assert.deepEqual(Object.keys(opts), ['api_key']);
  assert.equal(opts.api_key.sensitive, true);
  const mod = JSON.parse(readFileSync(join(REPO, 'plugins', 'claujev-mod', '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(mod.userConfig, undefined, 'the mod has no install screen');
});

test('global config from /claujev:configure: mode, features, and "off" beats the project', () => {
  writeFileSync(join(process.env.CLAUJEV_HOME, 'config.json'), JSON.stringify({ lang: 'pt', mode: 'enforce', features: { rule_review: 'observe', command_guard: 'off' } }));
  try {
    const cfg = m.loadConfig(project('p6', { hooks: { bash: 'enforce', stop: 'observe' } }));
    assert.equal(cfg.lang, 'pt');
    assert.equal(cfg.hooks.prompt, 'enforce', 'mode sets every hook');
    assert.equal(cfg.hooks.edit, 'observe', 'a feature can have its own mode');
    assert.equal(cfg.hooks.bash, 'off', 'off chosen by the user beats the project');
    assert.equal(cfg.hooks.stop, 'observe', 'the project still tunes features left on');
    const proj = m.loadConfig(project('p7', { mode: 'off' }));
    assert.equal(proj.hooks.final_check, undefined);
    assert.equal(proj.hooks.stop, 'off', 'a project can use "mode" too');
  } finally {
    writeFileSync(join(process.env.CLAUJEV_HOME, 'config.json'), JSON.stringify({ hooks: { bash: 'enforce' }, rules: ['global'] }));
  }
});

test('TEXT: en and pt have the same keys', () => {
  const keys = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? keys(v, `${p}${k}.`) : [`${p}${k}`])).sort();
  assert.deepEqual(keys(m.TEXT.pt), keys(m.TEXT.en));
});

test('suggestEffort: request size and type become an effort level', () => {
  assert.equal(m.suggestEffort({ taskType: 'question', taskConf: 0.9, scope: 1 }), 'low', 'questions are cheap');
  assert.equal(m.suggestEffort({ taskType: 'bug', scope: 0.25 }), 'low');
  assert.equal(m.suggestEffort({ taskType: 'feature', scope: 0.5 }), 'medium');
  assert.equal(m.suggestEffort({ taskType: 'feature', scope: 0.75 }), 'high');
  assert.equal(m.suggestEffort({ taskType: 'refactor', scope: 1 }), 'xhigh');
  assert.equal(m.suggestEffort({ taskType: 'bug', scope: 0.5, ambiguous: 0.8 }), 'high', 'an ambiguous bug goes one level up');
  assert.equal(m.suggestEffort({ taskType: 'bug', scope: 1, ambiguous: 0.9 }), 'xhigh', 'never above xhigh');
  assert.equal(m.suggestEffort({ taskType: 'feature' }), null, 'no scope, no suggestion');
});

test('EXPLICIT_EFFORT: spots requests that ask for effort themselves', () => {
  assert.ok(m.EXPLICIT_EFFORT.test('ultrathink: why is this slow?'));
  assert.ok(m.EXPLICIT_EFFORT.test('pense bem antes de mudar'));
  assert.ok(!m.EXPLICIT_EFFORT.test('fix the login bug'));
});

test('turnCommands: reads only the commands of the current turn', () => {
  const tr = join(home, 'transcript.jsonl');
  const line = (o) => JSON.stringify(o);
  const tool = (name, input) => line({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
  writeFileSync(tr, [
    line({ type: 'user', message: { content: 'first request' } }),
    tool('Bash', { command: 'npm publish' }),
    line({ type: 'user', message: { content: 'publish the release' } }),
    tool('Bash', { command: 'git push' }),
    line({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } }),
    tool('Read', { file_path: '/x' }),
    tool('Bash', { command: 'gh release create v1.0.0' }),
  ].join('\n'));
  assert.deepEqual(m.turnCommands(tr), ['git push', 'gh release create v1.0.0']);
  assert.deepEqual(m.turnCommands(join(home, 'missing.jsonl')), []);
});

test('EFFECTFUL: commands that change the world wake the Stop check', () => {
  for (const c of ['git push origin main', 'gh release create v2', 'npm publish', 'git commit -m x', 'curl -X POST https://api']) assert.ok(m.EFFECTFUL.test(c), c);
  for (const c of ['git status', 'ls -la', 'npm test', 'gh release view v1']) assert.ok(!m.EFFECTFUL.test(c), c);
});

test('evalCustom: project questions become a 0..1 value and a band', () => {
  const cfg = { questions: { stop: {
    risk: { type: 'score', act: { threshold: { low: 0.5, high: 0.75 }, message: 'high risk' } },
    test: { type: 'noul', act: { message: 'missing test' } },
    kind: { type: 'choice', act: { choices: ['a', 'b'], threshold: { low: 0.3, high: 0.6 } } },
  } } };
  const out = m.evalCustom(cfg, 'stop', {
    p_risk: { type: 'score', score: 4, legend: { 0: '', 1: '', 2: '', 3: '', 4: '' } },
    p_test: { type: 'noul', noul: 0.2 },
    p_kind: { type: 'choice', choice: 'a', probabilities: { a: 0.4, b: 0.3, c: 0.3 } },
  });
  const by = Object.fromEntries(out.map((x) => [x.id, x]));
  assert.equal(by.risk.band, 'high');
  assert.equal(by.test.band, 'low');
  assert.equal(by.kind.value, 0.7);
  assert.equal(by.kind.band, 'high');
});

test('describeChange: understands Edit, MultiEdit and Write', () => {
  assert.match(m.describeChange({ old_string: 'a', new_string: 'b' }), /new snippet\nb/);
  assert.match(m.describeChange({ edits: [{ old_string: 'x', new_string: 'y' }] }), /new snippet\ny/);
  assert.match(m.describeChange({ content: 'all' }, m.TEXT.pt.edit), /conteúdo completo do arquivo\nall/);
  assert.equal(m.describeChange({}), '');
});

const runHook = (hook, input, env = {}) => execFileSync(process.execPath, [SCRIPT, hook], {
  input: JSON.stringify(input), encoding: 'utf8',
  env: { ...process.env, TYPESAFE_API_KEY: '', ...env },
});

test('a hook without a key never breaks the session: no output, error in the log', () => {
  const out = runHook('prompt', { session_id: 'nokey', cwd: home, prompt: 'Create a new customer sign-up route in the API' });
  assert.equal(out, '', 'without a key nothing is sent to Claude');
  const day = new Date().toISOString().slice(0, 10);
  assert.match(readFileSync(join(process.env.CLAUJEV_HOME, 'logs', `${day}.jsonl`), 'utf8'), /TYPESAFE_API_KEY/);
});

test('the key from the plugin settings is used before the .env file', () => {
  // A wrong key makes the API answer an HTTP error, which proves the plugin key was sent.
  runHook('prompt', { session_id: 'optkey', cwd: home, prompt: 'Create a new customer sign-up route in the API' }, { CLAUDE_PLUGIN_OPTION_API_KEY: 'invalid-test-key' });
  const day = new Date().toISOString().slice(0, 10);
  const last = readFileSync(join(process.env.CLAUJEV_HOME, 'logs', `${day}.jsonl`), 'utf8').trim().split('\n').pop();
  assert.doesNotMatch(last, /TYPESAFE_API_KEY not set/);
});

test('first session: offers the guided setup once, then only reminds about a missing key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'claujev-session-'));
  const run = (env) => runHook('session', { session_id: 's', cwd: home, source: 'startup' }, { CLAUJEV_HOME: dir, ...env });
  const first = JSON.parse(run({ TYPESAFE_API_KEY: 'k' }));
  assert.equal(first.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(first.hookSpecificOutput.additionalContext, /\/claujev:configure/);
  assert.doesNotMatch(first.hookSpecificOutput.additionalContext, /not set/, 'with a key, no key warning');
  assert.equal(run({ TYPESAFE_API_KEY: 'k' }), '', 'second session with a key: silent');
  assert.match(JSON.parse(run({})).hookSpecificOutput.additionalContext, /key is not set/, 'without a key: reminder');
  assert.equal(runHook('session', { session_id: 's', cwd: home, source: 'resume' }, { CLAUJEV_HOME: dir }), '', 'resume/compact: silent');
  const pt = mkdtempSync(join(tmpdir(), 'claujev-session-'));
  assert.match(runHook('session', { session_id: 's', cwd: home, source: 'startup' }, { CLAUJEV_HOME: pt, CLAUDE_PLUGIN_OPTION_LANG: 'pt' }), /configuração guiada/);
});

test('installer: creates files, keeps third-party hooks, uninstalls cleanly', () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'claujev-home-'));
  const env = { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome };
  delete env.CLAUJEV_HOME;
  const settingsPath = join(fakeHome, '.claude', 'settings.json');
  mkdirSync(dirname(settingsPath), { recursive: true });
  const other = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo other' }] };
  writeFileSync(settingsPath, JSON.stringify({ model: 'opus', hooks: { PreToolUse: [other] } }));

  const run = (...a) => execFileSync(process.execPath, [join(REPO, 'install.mjs'), ...a], { env, encoding: 'utf8' });
  run();
  run(); // running again does not duplicate anything

  const dir = join(fakeHome, '.claude', 'claujev');
  assert.ok(existsSync(join(dir, 'claujev.mjs')));
  assert.ok(existsSync(join(dir, 'config.json')));
  assert.ok(existsSync(join(dir, '.env')));

  let s = JSON.parse(readFileSync(settingsPath, 'utf8'));
  assert.equal(s.model, 'opus', 'other settings stay untouched');
  assert.equal(s.hooks.PreToolUse.length, 3, 'third-party hook + bash + agent');
  assert.equal(s.hooks.UserPromptSubmit.length, 1);
  assert.deepEqual(Object.keys(s.hooks).sort(), ['PostToolUse', 'PreToolUse', 'SessionStart', 'Stop', 'SubagentStop', 'UserPromptSubmit']);

  run('--uninstall');
  s = JSON.parse(readFileSync(settingsPath, 'utf8'));
  assert.deepEqual(s.hooks, { PreToolUse: [other] });
});

test('installer: refuses to double up when the plugin is installed', () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'claujev-home-'));
  mkdirSync(join(fakeHome, '.claude', 'plugins'), { recursive: true });
  writeFileSync(join(fakeHome, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'claujev@claujev': [{}] } }));
  const env = { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome };
  delete env.CLAUJEV_HOME;
  assert.throws(() => execFileSync(process.execPath, [join(REPO, 'install.mjs')], { env, encoding: 'utf8', stdio: 'pipe' }), (e) => /--force/.test(e.stderr));
  assert.ok(!existsSync(join(fakeHome, '.claude', 'settings.json')));
});

test('plugin hooks.json points every hook at the script', () => {
  const hooks = JSON.parse(readFileSync(join(REPO, 'plugins', 'claujev', 'hooks', 'hooks.json'), 'utf8')).hooks;
  const cmds = Object.values(hooks).flat().flatMap((g) => g.hooks.map((h) => h.command));
  assert.equal(cmds.length, 7);
  for (const c of cmds) assert.match(c, /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/claujev\.mjs" (session|prompt|bash|agent|edit|stop|subagent)$/);
});
