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

test('hasLiteralSecret: flags secrets written in code, not code that handles them', () => {
  for (const c of ['const API_KEY = "abc123secretvalue";', "password: 'hunter2hunter2'", 'const k = "sk-ant-abcdefghijklmnopqrstu"', '-----BEGIN RSA PRIVATE KEY-----', 'TOKEN="ghp_abcdefghijklmnopqrstuvwxyz"'])
    assert.ok(m.hasLiteralSecret(c), c);
  for (const c of ['const token = getToken(user);', 'const key = process.env.API_KEY;', 'password: req.body.password', 'const secret = ""', 'if (!token) throw new Error("no token")'])
    assert.ok(!m.hasLiteralSecret(c), c);
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

test('isReadOnly: chains of plain reads skip Jev, anything else in the chain does not', () => {
  for (const c of ['cd repo && git status | head', 'S=/tmp/x; cd $S && ls', 'grep -rn foo src | wc -l', 'sed -n 1,20p a.ts', 'gh pr view 3 --json state']) assert.equal(m.isReadOnly(c), true, c);
  for (const c of ['cd repo && rm -rf build', 'X=1 rm -rf build', 'cat a > b', 'cat <<EOF', 'sed -i s/a/b/ f', 'ls & rm x', 'cat credenciais.ps1', 'cd repo && git push', 'gh pr merge 3', 'ls\nrm x']) assert.equal(m.isReadOnly(c), false, c);
});

test('isReadOnly: reads that can write, run commands or print secrets still go to Jev', () => {
  for (const c of ['tail -f app.log', 'ls -d */', 'cut -d, -f1 a.csv', 'grep -c x a | sort | uniq -c', 'git branch -a', "sed -n '10,20p' a.ts"]) assert.equal(m.isReadOnly(c), true, c);
  for (const c of [
    'git branch -D feature', 'git branch --delete feature', 'find . -execdir rm {} +', 'find . -fprint out', 'rg --pre=sh x',
    'uniq a b', 'sed -n w out f', 'sed -n --in-place 1p f', 'PATH=/tmp/x; ls', 'echo $SUPABASE_SERVICE_ROLE_KEY',
    'echo $env:OPENAI_API_KEY', 'cat ~/.netrc', 'cat ~/.config/gh/hosts.yml', 'jq -n env', 'cat /proc/self/environ',
  ]) assert.equal(m.isReadOnly(c), false, c);
});

test('isSystemMessage: messages Claude Code injects are not triaged', () => {
  for (const c of ['<task-notification> <task-id>b1</task-id>', '<local-command-stdout>ok</local-command-stdout>', 'claude --resume']) assert.ok(m.isSystemMessage(c), c);
  for (const c of ['fix the login bug', 'use <div> instead of <span> here', 'claude code is slow today', '<pasted_content id="1"> price table, fix the totals', '<div> should be a <span>']) assert.ok(!m.isSystemMessage(c), c);
  for (const c of ['<command-name>/effort</command-name>', '<bash-input> ls</bash-input>', '<system-reminder>x</system-reminder>']) assert.ok(m.isSystemMessage(c), c);
});

test('loadConfig: defaults < global < project, rules are added up', () => {
  mkdirSync(process.env.CLAUJEV_HOME, { recursive: true });
  writeFileSync(join(process.env.CLAUJEV_HOME, 'config.json'), JSON.stringify({ hooks: { bash: 'observe' }, rules: ['global'] }));
  const cfg = m.loadConfig(project('p1', { hooks: { edit: 'observe' }, rules: ['project'], verify: 'npm test' }));
  assert.equal(cfg.hooks.bash, 'observe');
  assert.equal(cfg.hooks.edit, 'observe');
  assert.equal(cfg.hooks.stop, 'enforce', 'untouched values keep the default');
  assert.equal(cfg.hooks.agent, 'observe', 'subagent routing only watches by default');
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

test('suggestEffort with depth: the larger of change size and investigation', () => {
  assert.equal(m.suggestEffort({ taskType: 'question', taskConf: 0.9, scope: 0, depth: 0 }), 'low', 'a direct question stays cheap');
  assert.equal(m.suggestEffort({ taskType: 'question', taskConf: 0.9, scope: 0, depth: 0.62 }), 'medium', 'reviewing logs is not a one-line answer');
  assert.equal(m.suggestEffort({ taskType: 'question', taskConf: 0.9, scope: 1, depth: 1 }), 'high', 'a question stops at high');
  assert.equal(m.suggestEffort({ taskType: 'feature', scope: 0, depth: 0.25 }), 'low', 'opening a card about a big feature is small');
  assert.equal(m.suggestEffort({ taskType: 'bug', scope: 0.25, depth: 0.85 }), 'high', 'a one-line fix that needs hard debugging');
  assert.equal(m.suggestEffort({ taskType: 'feature', scope: 1, depth: 0.25 }), 'xhigh', 'a large change, even if obvious');
  assert.equal(m.suggestEffort({ taskType: 'bug', scope: 0.5, depth: 0.25, ambiguous: 0.9 }), 'medium', 'depth replaces the ambiguity bump');
});

test('LOCAL_ASK: only critical, hard-to-undo commands ask without calling Jev', () => {
  for (const c of ['git push --force origin main', 'cd r && git push -f origin master 2>&1', 'git push origin +HEAD:main', 'git push --force-with-lease origin main', 'npm publish',
    'psql -c "DROP TABLE users"', 'terraform destroy', 'terraform apply -auto-approve -destroy', 'aws s3 rb s3://x --force', 'aws rds delete-db-instance --db-instance-identifier x', 'kubectl delete ns prod', 'gh repo delete o/r --yes', 'supabase db reset --linked'])
    assert.ok(m.LOCAL_ASK.test(c), c);
  // Routine work: Claude Code's own permissions handle these.
  for (const c of ['git push -u origin HEAD', 'cd repo && git push -q origin --delete feat', 'gh pr merge 246 --squash --delete-branch', 'git branch -D old', 'git reset --hard HEAD~1',
    'git push --force origin feat/x', 'git push origin "+abc123:refs/tags/publicado/via-api-cliente"', 'terraform apply plan.tfplan', 'git commit -m x', 'rm -rf /tmp/scratch', 'npm install', 'git checkout main && git push origin feat'])
    assert.ok(!m.LOCAL_ASK.test(c), c);
  const dir = mkdtempSync(join(tmpdir(), 'claujev-local-'));
  const out = JSON.parse(runHook('bash', { session_id: 'l', cwd: home, tool_name: 'Bash', tool_input: { command: 'git push --force origin main' } }, { CLAUJEV_HOME: dir }));
  assert.equal(out.hookSpecificOutput.permissionDecision, 'ask', 'asks even with no key: Jev is not needed');
  const day = new Date().toISOString().slice(0, 10);
  assert.match(readFileSync(join(dir, 'logs', `${day}.jsonl`), 'utf8'), /"local":true/);
});

test('sizeHints: off by default, can be turned back on', () => {
  assert.equal(m.DEFAULTS.sizeHints, false);
});

test('final check warns by default; only a failed verify command blocks', () => {
  assert.equal(m.DEFAULTS.stopBlocks, false);
  for (const lang of ['en', 'pt']) assert.match(m.TEXT[lang].stop.warn('x'), /^\[Jev\]/);
});

test('rule review: the user request can set a rule aside only when there is a request', () => {
  for (const lang of ['en', 'pt']) {
    const t = m.TEXT[lang].edit;
    assert.ok(t.rule('R', true).length > t.rule('R', false).length, lang);
    assert.ok(t.request, lang);
  }
});

test('stop follow-up: after a block, records whether Claude changed something or only explained', () => {
  const dir = mkdtempSync(join(tmpdir(), 'claujev-follow-'));
  const state = join(dir, 'state');
  mkdirSync(state, { recursive: true });
  const blockedAt = new Date(Date.now() - 60000).toISOString();
  const tr = join(dir, 't.jsonl');
  const at = (ms, content) => JSON.stringify({ type: 'assistant', timestamp: new Date(Date.parse(blockedAt) + ms).toISOString(), message: { content } });
  const run = (lines) => {
    writeFileSync(join(state, 'f.json'), JSON.stringify({ prompt: 'x', edits: 0, files: [], blocked: { ts: blockedAt, problems: 1 } }));
    writeFileSync(tr, lines.join('\n'));
    runHook('stop', { session_id: 'f', cwd: home, transcript_path: tr, stop_hook_active: true }, { CLAUJEV_HOME: dir });
    const day = new Date().toISOString().slice(0, 10);
    return JSON.parse(readFileSync(join(dir, 'logs', `${day}.jsonl`), 'utf8').trim().split('\n').pop()).followUp;
  };
  const before = JSON.stringify({ type: 'assistant', timestamp: new Date(Date.parse(blockedAt) - 5000).toISOString(), message: { content: [{ type: 'tool_use', name: 'Edit', input: {} }] } });
  assert.deepEqual(run([before, at(1000, [{ type: 'text', text: 'All done, nothing missing.' }])]), { tools: 0, changed: 0, problems: 1 }, 'only explained');
  assert.deepEqual(run([before, at(1000, [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }, { type: 'tool_use', name: 'Edit', input: {} }])]), { tools: 2, changed: 1, problems: 1 }, 'acted on the block');
  assert.equal(JSON.parse(readFileSync(join(state, 'f.json'), 'utf8')).blocked, null, 'recorded once');
});

test('report: shows the stop follow-ups and the effort answers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'claujev-report-'));
  mkdirSync(join(dir, 'logs'), { recursive: true });
  writeFileSync(join(dir, 'logs', '2026-11-04.jsonl'), [
    { hook: 'stop', acted: true }, { hook: 'stop', followUp: { tools: 2, changed: 1 } },
    { hook: 'stop', acted: true }, { hook: 'stop', followUp: { tools: 0, changed: 0 } },
    { hook: 'bash', local: true, acted: true },
  ].map((e) => JSON.stringify(e)).join('\n'));
  writeFileSync(join(dir, 'logs', 'effort-2026-11-04-s1.jsonl'), [{ hook: 'effort', answer: 'use' }, { hook: 'effort', answer: 'keep' }, { hook: 'effort', answer: 'use' }].map((e) => JSON.stringify(e)).join('\n'));
  const out = execFileSync('node', [SCRIPT, 'report'], { env: { ...process.env, CLAUJEV_HOME: dir }, encoding: 'utf8' });
  assert.match(out, /blocked 2x: Claude then changed something in 1, only explained in 1/);
  assert.match(out, /accepted 2 · kept current 1 · dismissed 0/);
  assert.match(out, /local rule \(Jev not called\): 1/);
});

test('isSystemMessage: the usage-limit resume continues the previous request', () => {
  assert.ok(m.isSystemMessage('Your claude.ai usage limit has reset. Continue the task you were working on when the limit was reached; do not repeat work.'));
  assert.ok(!m.isSystemMessage('my usage limit has reset, continue'));
});

test('FILE_WRITE: shell commands that write files wake the Stop check', () => {
  const writes = [
    "python3 - <<'EOF'\np='docs/a.md'; s=open(p).read()\nopen(p,'w').write(s)\nEOF",
    "cat > src/app.ts <<'EOF'\nexport {}\nEOF",
    'echo x >> notes.txt', "sed -i 's/a/b/' file.js", "sed -n -i.bak 's/a/b/' f", 'perl -pi -e s/a/b/ f',
    'printf x | tee out.txt', 'cp a.txt b.txt', 'git apply fix.patch', "node -e \"require('fs').writeFileSync('x','y')\"",
    "python3 -c \"import pathlib; pathlib.Path('x').write_text('y')\"",
  ];
  for (const c of writes) assert.ok(m.FILE_WRITE.test(c), c);
  const reads = ['git status 2>&1 | tail -5', 'ls -la > /dev/null', 'npm test 2>/dev/null', "sed -n '1,20p' file.js", 'grep -rn foo src', 'git log --oneline -5', 'cat a.txt | head'];
  for (const c of reads) assert.ok(!m.FILE_WRITE.test(c), c);
});

test('writeDirs and shellChanges: what the shell changed in each repo during the turn', () => {
  const repo = mkdtempSync(join(tmpdir(), 'claujev-shell-'));
  const other = mkdtempSync(join(tmpdir(), 'claujev-shell-other-'));
  const g = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'ignore' });
  for (const r of [repo, other]) {
    g(r, 'init', '-q'); g(r, 'config', 'user.email', 't@t'); g(r, 'config', 'user.name', 't');
    writeFileSync(join(r, 'a.txt'), 'one\n'); g(r, 'add', '.'); g(r, 'commit', '-qm', 'init');
  }
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  const st = { base, turnStart: new Date(Date.now() - 1000).toISOString(), files: [] };
  writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n');
  writeFileSync(join(repo, 'new.txt'), 'created by the shell\n');
  writeFileSync(join(other, 'a.txt'), 'changed elsewhere\n');
  const cmds = ["python3 -c \"open('a.txt','w')\"", `cd ${other}; echo x > a.txt`];
  assert.deepEqual(m.writeDirs(repo, cmds).sort(), [repo, other].sort());
  const t = m.TEXT.en.stop;
  const out = m.shellChanges(repo, cmds, st, 20000, t);
  assert.match(out, /\+two/, 'tracked change since the start of the turn');
  assert.match(out, /created by the shell/, 'new file written in the turn');
  assert.match(out, /\+changed elsewhere/, 'a repo the command cd-ed into');
  const seen = m.shellChanges(repo, cmds.slice(0, 1), { ...st, files: [join(repo, 'a.txt')] }, 20000, t);
  assert.doesNotMatch(seen, /\+two/, 'files the edit hook already saw are not repeated');
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

test('turnInfo: commands and the last thing Claude told the user, in this turn only', () => {
  const tr = join(home, 'transcript-reply.jsonl');
  const line = (o) => JSON.stringify(o);
  const text = (t) => line({ type: 'assistant', message: { content: [{ type: 'text', text: t }] } });
  writeFileSync(tr, [
    line({ type: 'user', message: { content: 'create the card' } }),
    text('Creating it now.'),
    line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'gh issue create' } }] } }),
    text('Created card #214.'),
  ].join('\n'));
  assert.deepEqual(m.turnInfo(tr), { commands: ['gh issue create'], reply: 'Created card #214.' });
  writeFileSync(tr, [
    line({ type: 'user', message: { content: 'first' } }),
    text('Old answer.'),
    line({ type: 'user', message: { content: 'push it' } }),
    line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'git push' } }] } }),
  ].join('\n'));
  assert.equal(m.turnInfo(tr).reply, '', 'a reply from an earlier turn is never used');
  assert.deepEqual(m.turnInfo(join(home, 'missing.jsonl')), { commands: [], reply: '' });
});

test('buildStopState: final reply, previous request and the commands that matter', () => {
  const t = m.TEXT.en.stop;
  const noise = Array.from({ length: 200 }, (_, i) => `cat file${i}.txt ${'x'.repeat(200)}`);
  const state = m.buildStopState(t, {
    prompt: 'ok, go ahead', previous: 'create a card for the cancel reason',
    commands: [...noise, `gh issue create --title "Cancel reason" --body "${'y'.repeat(300)}"`],
    reply: `Created card #214. token=abcdef1234567890 ${'z'.repeat(5000)}`,
  });
  assert.match(state, /create a card for the cancel reason/);
  assert.match(state, /Final reply of the agent/);
  assert.match(state, /Created card #214/);
  assert.ok(!state.includes('abcdef1234567890'), 'secrets in the reply are removed');
  assert.ok(state.includes('y'.repeat(300)), 'a command with effects keeps its detail');
  assert.ok(!state.includes('file0.txt'), 'a long turn keeps its end, not its start');
  assert.ok(!state.includes('x'.repeat(150)), 'plain commands are shortened');
  assert.ok(!state.includes('z'.repeat(3100)), 'the reply is capped');
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

test('LOCAL_DANGER: the safety net catches plainly critical commands only', () => {
  for (const c of ['git push --force origin main', 'git push -f', 'psql -c "DELETE FROM users"', 'rm -rf ~', 'rm -rf /', 'psql -c "DROP TABLE users"', 'npm publish'])
    assert.ok(m.LOCAL_DANGER.test(c), c);
  for (const c of ['git push origin main', 'git status', 'npm test', 'rm notes.txt', 'rm -rf build', 'rm -rf /tmp/x', 'git reset --hard HEAD~3', 'git commit -m "fix"'])
    assert.ok(!m.LOCAL_DANGER.test(c), c);
});

test('when Jev cannot answer, a destructive command still asks; a normal one passes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'claujev-fallback-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ mode: 'enforce' }));
  const run = (command) => runHook('bash', { session_id: 'f', cwd: home, tool_name: 'Bash', tool_input: { command } }, { CLAUJEV_HOME: dir });
  const out = JSON.parse(run('psql -c "DELETE FROM users"')); // not in LOCAL_ASK, so it goes to Jev and Jev fails
  assert.equal(out.hookSpecificOutput.permissionDecision, 'ask');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /could not check/);
  assert.equal(run('npm install'), '', 'without an answer from Jev, an ordinary command is not held');
  assert.equal(run('rm -rf build'), '', 'deleting a build folder is routine');
});

test('triage skips system messages without calling Jev', () => {
  const dir = mkdtempSync(join(tmpdir(), 'claujev-sys-'));
  const out = runHook('prompt', { session_id: 'sys', cwd: home, prompt: '<task-notification> <task-id>b1</task-id> <status>completed</status></task-notification>' }, { CLAUJEV_HOME: dir });
  assert.equal(out, '');
  assert.ok(!existsSync(join(dir, 'logs')), 'nothing was sent, so nothing failed for lack of a key');
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
  const second = JSON.parse(run({ TYPESAFE_API_KEY: 'k' })).hookSpecificOutput.additionalContext;
  assert.doesNotMatch(second, /\/claujev:configure/, 'the setup is offered only once');
  assert.match(second, /Edit\/Write/, 'with a key: asks for edits through the tools the review sees');
  assert.match(JSON.parse(run({})).hookSpecificOutput.additionalContext, /key is not set/, 'without a key: reminder');
  assert.doesNotMatch(JSON.parse(run({})).hookSpecificOutput.additionalContext, /Edit\/Write/, 'without a key ClauJev is idle: no edit advice');
  assert.equal(runHook('session', { session_id: 's', cwd: home, source: 'resume' }, { CLAUJEV_HOME: dir }), '', 'resume without a key: silent');
  const compact = JSON.parse(runHook('session', { session_id: 's', cwd: home, source: 'compact' }, { CLAUJEV_HOME: dir, TYPESAFE_API_KEY: 'k' }));
  assert.match(compact.hookSpecificOutput.additionalContext, /Edit\/Write/, 'after compaction the edit advice comes back');
  assert.equal(run({ TYPESAFE_API_KEY: 'k', CLAUDE_PLUGIN_OPTION_RULE_REVIEW: 'off', CLAUDE_PLUGIN_OPTION_FINAL_CHECK: 'off' }), '', 'review and final check off: no edit advice');
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
