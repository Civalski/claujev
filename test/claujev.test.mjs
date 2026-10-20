import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

// Pasta isolada: os testes nunca leem a configuração real de quem roda.
const home = mkdtempSync(join(tmpdir(), 'claujev-'));
process.env.CLAUJEV_HOME = join(home, 'claujev');
const m = await import('../hooks/claujev.mjs');

test('band: classifica nas faixas baixo / incerto / alto', () => {
  const t = { low: 0.5, high: 0.8 };
  assert.equal(m.band(0.1, t), 'baixo');
  assert.equal(m.band(0.6, t), 'incerto');
  assert.equal(m.band(0.8, t), 'alto');
  assert.equal(m.band(undefined, t), null);
  assert.equal(m.band(0.7, 0.7), 'alto', 'limiar antigo (número) continua aceito');
});

test('normScore: leva o score para 0..1 qualquer que seja a escala', () => {
  assert.equal(m.normScore({ score: 0, legend: { 0: 'a', 1: 'b', 2: 'c', 3: 'd', 4: 'e' } }), 0);
  assert.equal(m.normScore({ score: 4, legend: { 0: 'a', 1: 'b', 2: 'c', 3: 'd', 4: 'e' } }), 1);
  assert.equal(m.normScore({ score: 3, legend: { 1: 'a', 2: 'b', 3: 'c' } }), 1);
  assert.equal(m.normScore({ score: 1, legend: { 1: 'só um nível' } }), null);
});

test('redact: remove segredos antes de enviar ao Jev', () => {
  const out = m.redact([
    'const key = "sk-ant-abcdefghijklmnopqrstuvwxyz"',
    'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456',
    'password=hunter2hunter2',
    '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----',
  ].join('\n'));
  assert.ok(!out.includes('abcdefghijklmnopqrstuvwxyz'));
  assert.ok(!out.includes('hunter2'));
  assert.ok(!out.includes('MIIabc'));
  assert.match(out, /SEGREDO REMOVIDO/);
  assert.match(out, /CHAVE REMOVIDA/);
});

test('isReadOnly: atalho só vale para leitura pura', () => {
  assert.equal(m.isReadOnly('git status'), true);
  assert.equal(m.isReadOnly('ls -la src'), true);
  assert.equal(m.isReadOnly('git status && rm -rf /'), false, 'encadeamento desqualifica');
  assert.equal(m.isReadOnly('cat .env'), false, 'arquivo sensível sempre passa pelo Jev');
  assert.equal(m.isReadOnly('find . -delete'), false);
  assert.equal(m.isReadOnly('rm -rf build'), false);
  assert.equal(m.isReadOnly('echo $(whoami)'), false);
});

test('loadConfig: padrões < global < projeto, com regras somadas', () => {
  mkdirSync(process.env.CLAUJEV_HOME, { recursive: true });
  writeFileSync(join(process.env.CLAUJEV_HOME, 'config.json'), JSON.stringify({ hooks: { bash: 'enforce' }, rules: ['global'] }));
  const proj = join(home, 'projeto');
  mkdirSync(join(proj, '.claude'), { recursive: true });
  writeFileSync(join(proj, '.claude', 'claujev.json'), JSON.stringify({ hooks: { edit: 'enforce' }, rules: ['do projeto'], verify: 'npm test' }));

  const cfg = m.loadConfig(proj);
  assert.equal(cfg.hooks.bash, 'enforce');
  assert.equal(cfg.hooks.edit, 'enforce');
  assert.equal(cfg.hooks.stop, 'observe', 'o que ninguém mudou fica no padrão');
  assert.equal(cfg.verify, 'npm test');
  assert.deepEqual(cfg.rules.slice(-2), ['global', 'do projeto']);
  assert.equal(cfg.rules.length, m.DEFAULTS.rules.length + 2);
});

test('loadConfig: replace_rules troca as regras padrão em vez de somar', () => {
  const proj = join(home, 'projeto2');
  mkdirSync(join(proj, '.claude'), { recursive: true });
  writeFileSync(join(proj, '.claude', 'claujev.json'), JSON.stringify({ rules: ['só esta'], replace_rules: true }));
  assert.deepEqual(m.loadConfig(proj).rules, ['só esta']);
});

test('evalCustom: perguntas do projeto viram valor 0..1 e faixa', () => {
  const cfg = { questions: { stop: {
    risco: { type: 'score', act: { threshold: { low: 0.5, high: 0.75 }, message: 'risco alto' } },
    teste: { type: 'noul', act: { message: 'falta teste' } },
    tipo: { type: 'choice', act: { choices: ['a', 'b'], threshold: { low: 0.3, high: 0.6 } } },
  } } };
  const out = m.evalCustom(cfg, 'stop', {
    p_risco: { type: 'score', score: 4, legend: { 0: '', 1: '', 2: '', 3: '', 4: '' } },
    p_teste: { type: 'noul', noul: 0.2 },
    p_tipo: { type: 'choice', choice: 'a', probabilities: { a: 0.4, b: 0.3, c: 0.3 } },
  });
  const by = Object.fromEntries(out.map((x) => [x.id, x]));
  assert.equal(by.risco.band, 'alto');
  assert.equal(by.teste.band, 'baixo');
  assert.equal(by.tipo.value, 0.7);
  assert.equal(by.tipo.band, 'alto');
});

test('describeChange: entende Edit, MultiEdit e Write', () => {
  assert.match(m.describeChange({ old_string: 'a', new_string: 'b' }), /trecho novo\nb/);
  assert.match(m.describeChange({ edits: [{ old_string: 'x', new_string: 'y' }] }), /trecho novo\ny/);
  assert.match(m.describeChange({ content: 'tudo' }), /conteúdo completo do arquivo\ntudo/);
  assert.equal(m.describeChange({}), '');
});

test('hook sem chave nunca quebra a sessão: sai sem erro e registra no log', () => {
  const env = { ...process.env, TYPESAFE_API_KEY: '' };
  const input = JSON.stringify({ session_id: 'teste', cwd: home, prompt: 'Crie uma rota nova de cadastro de clientes na API' });
  const out = execFileSync(process.execPath, [join(REPO, 'hooks', 'claujev.mjs'), 'prompt'], { input, env, encoding: 'utf8' });
  assert.equal(out, '', 'sem chave, nada é enviado ao Claude');
  const day = new Date().toISOString().slice(0, 10);
  assert.match(readFileSync(join(process.env.CLAUJEV_HOME, 'logs', `${day}.jsonl`), 'utf8'), /TYPESAFE_API_KEY/);
});

test('instalador: cria arquivos, mantém hooks de terceiros e desinstala limpo', () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'claujev-home-'));
  const env = { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome, CLAUJEV_HOME: '' };
  delete env.CLAUJEV_HOME;
  const settingsPath = join(fakeHome, '.claude', 'settings.json');
  mkdirSync(dirname(settingsPath), { recursive: true });
  const other = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo outro' }] };
  writeFileSync(settingsPath, JSON.stringify({ model: 'opus', hooks: { PreToolUse: [other] } }));

  const run = (...a) => execFileSync(process.execPath, [join(REPO, 'install.mjs'), ...a], { env, encoding: 'utf8' });
  run();
  run(); // rodar de novo não duplica nada

  const dir = join(fakeHome, '.claude', 'hooks', 'claujev');
  assert.ok(existsSync(join(dir, 'claujev.mjs')));
  assert.ok(existsSync(join(dir, 'config.json')));
  assert.ok(existsSync(join(dir, '.env')));

  let s = JSON.parse(readFileSync(settingsPath, 'utf8'));
  assert.equal(s.model, 'opus', 'outras configurações ficam intactas');
  assert.equal(s.hooks.PreToolUse.length, 3, 'hook de terceiro + bash + agent');
  assert.equal(s.hooks.UserPromptSubmit.length, 1);
  assert.deepEqual(Object.keys(s.hooks).sort(), ['PostToolUse', 'PreToolUse', 'Stop', 'SubagentStop', 'UserPromptSubmit']);

  run('--uninstall');
  s = JSON.parse(readFileSync(settingsPath, 'utf8'));
  assert.deepEqual(s.hooks, { PreToolUse: [other] });
});
