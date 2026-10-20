#!/usr/bin/env node
// ClauJev: o Jev (TypeSafe AI) como segundo par de olhos do Claude Code.
// Uso: node claujev.mjs <prompt|edit|stop|bash|agent|subagent|selftest|report>
// Hooks nunca quebram a sessão: qualquer erro é registrado no log e o Claude segue normalmente.
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, basename, extname, resolve, relative, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Pasta fixa (não a do script): com symlink, .env, logs e estado continuam fora do repositório.
export const HERE = process.env.CLAUJEV_HOME || join(homedir(), '.claude', 'hooks', 'claujev');
const LOG_DIR = join(HERE, 'logs');
const STATE_DIR = join(HERE, 'state');
const API_URL = 'https://api.typesafe.ai/v1/systemone';
const PRICE_PER_M_INPUT = 0.042; // US$ por milhão de tokens de entrada; saída é gratuita

const DEFAULTS = {
  enabled: true,
  model: 'jev-latest',
  timeoutMs: 3000,
  // Modo por hook: "observe" só registra no log, "enforce" age no Claude, "off" desliga.
  hooks: { prompt: 'observe', edit: 'observe', stop: 'observe', bash: 'observe', agent: 'observe', subagent: 'observe' },
  // Modelo sugerido para subagentes com tarefa simples (só o modelo; o effort nunca é alterado).
  routeModel: 'haiku',
  // Faixas: valor >= high => age (em enforce); entre low e high => "incerto" (só log); abaixo de low => nada.
  thresholds: {
    ambiguous: { low: 0.5, high: 0.7 },
    rule: { low: 0.5, high: 0.85 },
    incomplete: { low: 0.25, high: 0.4 }, // 1 - nota de completude (0 = completo)
    unfinished: { low: 0.5, high: 0.85 },
    sideEffects: { low: 0.5, high: 0.85 },
    credentials: { low: 0.5, high: 0.7 },
    simpleTask: { low: 0.5, high: 0.8 },   // subagente cabe no modelo menor
    falseClaims: { low: 0.5, high: 0.8 },  // relatório do subagente não bate com as ações
  },
  rules: [
    'Não deixar código incompleto: placeholders, TODO/FIXME novos, funções vazias ou "implementar depois".',
    'Não colocar segredos (chaves de API, senhas, tokens) diretamente no código.',
    'Não engolir erros silenciosamente (catch vazio ou que ignora o erro sem tratar nem registrar).',
  ],
  // Áreas do projeto com dica de contexto: { "nome": { "description": "...", "hint": "..." } }
  areas: {},
  // Arquivos do projeto cujo início entra no state do Stop e das edições (ex.: "ARCHITECTURE.md").
  context: [],
  contextChars: 4000,
  // Comando opcional rodado no Stop; código de saída e fim da saída entram no state.
  verify: null,
  verifyTimeoutMs: 45000,
  // Perguntas extras do projeto: { stop: { id: { type, instructions, criteria, act? } }, edit: {...} }
  questions: {},
  ignoreFiles: ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', '.min.js', '.map', '.svg', '.png', '.jpg'],
  maxDiffChars: 30000,
};

// ---------- utilidades ----------

const clip = (s, n) => (s && s.length > n ? s.slice(0, n) + '\n…[truncado]' : s || '');
const tail = (s, n) => (s && s.length > n ? '…[início omitido]\n' + s.slice(-n) : s || '');
const hash = (s) => createHash('sha256').update(s || '').digest('hex').slice(0, 12);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (n) => (typeof n === 'number' ? Math.round(n * 1000) / 1000 : n);

function redact(s) {
  return (s || '')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[CHAVE REMOVIDA]')
    .replace(/\b(?:sk|pk|rk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{16,}/g, '[SEGREDO REMOVIDO]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, 'Bearer [SEGREDO REMOVIDO]')
    .replace(/((?:api[_-]?key|token|secret|password|passwd|senha)["']?\s*[:=]\s*["']?)[^\s"',;]{6,}/gi, '$1[SEGREDO REMOVIDO]');
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

// Lê o .env ao lado do script (KEY=valor por linha; # comenta).
function readEnvFile() {
  try {
    return Object.fromEntries(readFileSync(join(HERE, '.env'), 'utf8').split(/\r?\n/)
      .map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; }));
  } catch { return {}; }
}

function loadConfig(cwd) {
  // Camadas: padrões < config.json global < .claude/claujev.json do projeto (jev.json aceito por compatibilidade).
  const project = cwd && (readJson(join(cwd, '.claude', 'claujev.json')) || readJson(join(cwd, '.claude', 'jev.json')));
  const layers = [readJson(join(HERE, 'config.json')), project].filter(Boolean);
  const cfg = structuredClone(DEFAULTS);
  for (const l of layers) {
    for (const [k, v] of Object.entries(l)) {
      if (k === 'rules' || k === 'ignoreFiles') cfg[k] = l[`replace_${k}`] ? v : [...cfg[k], ...v];
      else if (v && typeof v === 'object' && !Array.isArray(v)) cfg[k] = { ...cfg[k], ...v };
      else cfg[k] = v;
    }
  }
  return cfg;
}

// Classifica um valor 0..1 numa faixa. Aceita limiar antigo (número) por compatibilidade.
function band(value, t) {
  if (typeof value !== 'number') return null;
  const { low, high } = typeof t === 'number' ? { low: Math.min(0.5, t), high: t } : t;
  return value >= high ? 'alto' : value >= low ? 'incerto' : 'baixo';
}

function log(entry) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    appendFileSync(join(LOG_DIR, `${day}.jsonl`), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch { /* log nunca derruba o hook */ }
}

const statePath = (sid) => join(STATE_DIR, `${(sid || 'sem-sessao').replace(/[^\w-]/g, '')}.json`);
const loadState = (sid) => readJson(statePath(sid)) || { prompt: '', edits: 0, files: [] };
function saveState(sid, st) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(statePath(sid), JSON.stringify(st));
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw.trim() ? JSON.parse(raw) : {};
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
}

// Score: converte para posição 0..1 independentemente de os níveis começarem em 0 ou 1.
function normScore(ans) {
  const levels = Object.keys(ans.legend || {}).map(Number).filter((n) => !Number.isNaN(n));
  if (levels.length < 2) return null;
  const min = Math.min(...levels), max = Math.max(...levels);
  return (ans.score - min) / (max - min);
}

async function askJev(cfg, state, questions) {
  const key = process.env.TYPESAFE_API_KEY || readEnvFile().TYPESAFE_API_KEY;
  if (!key) throw new Error('TYPESAFE_API_KEY não definida (preencha o .env do harness)');
  for (let attempt = 0; ; attempt++) {
    const t0 = Date.now();
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: cfg.model, state, questions }),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    if ((res.status === 429 || res.status === 529) && attempt < 2) { await sleep(400 * 2 ** attempt); continue; }
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${clip(await res.text(), 300)}`);
    const data = await res.json();
    return { ...data, latencyMs: Date.now() - t0 };
  }
}

function baseLog(hook, mode, input, r) {
  return {
    hook, mode,
    project: basename(input.cwd || ''),
    session: (input.session_id || '').slice(0, 8),
    model: r?.model,
    latencyMs: r?.latencyMs,
    inputTokens: r?.usage?.input_tokens,
  };
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 20 * 1024 * 1024 });
}
function gitTry(cwd, args) {
  try { return git(cwd, args).trim(); } catch { return null; }
}

// Início dos arquivos de `context` do projeto, para dar ao Jev o que o projeto considera importante.
function projectContext(cwd, cfg) {
  if (!cwd || !cfg.context?.length) return '';
  const parts = [];
  for (const p of cfg.context) {
    try { parts.push(`### ${p}\n${clip(readFileSync(resolve(cwd, p), 'utf8'), cfg.contextChars)}`); } catch { /* arquivo ausente */ }
  }
  return parts.length ? `Contexto do projeto:\n${redact(parts.join('\n\n'))}\n\n` : '';
}

// Perguntas extras do projeto: valor 0..1 por tipo (noul direto, score normalizado, choice = soma das opções em act.choices).
function customQuestions(cfg, hook) {
  const qs = cfg.questions?.[hook] || {};
  return Object.fromEntries(Object.entries(qs).map(([id, q]) => [`p_${id}`, { type: q.type, instructions: q.instructions, criteria: q.criteria }]));
}
function evalCustom(cfg, hook, answers) {
  const out = [];
  for (const [id, q] of Object.entries(cfg.questions?.[hook] || {})) {
    const a = answers?.[`p_${id}`];
    if (!a) continue;
    let value = null;
    if (a.type === 'noul') value = a.noul;
    else if (a.type === 'score') value = normScore(a);
    else if (a.type === 'choice' && q.act?.choices) value = q.act.choices.reduce((s, c) => s + (a.probabilities?.[c] || 0), 0);
    const b = q.act ? band(value, q.act.threshold ?? { low: 0.5, high: 0.8 }) : null;
    out.push({ id, value: round(value), choice: a.choice, band: b, message: q.act?.message || id });
  }
  return out;
}

// ---------- hook: pedido do usuário (UserPromptSubmit) ----------

async function onPrompt(input, cfg, mode) {
  const sid = input.session_id;
  const prev = loadState(sid);
  let prompt = (input.prompt || '').trim();
  // Respostas curtas ("sim", "pode seguir") continuam o pedido anterior.
  if (prompt.length < 40 && prev.prompt) prompt = `${prev.prompt}\n\n[mensagem seguinte do usuário]: ${prompt}`;
  // Commit no início do turno: o Stop compara com ele, inclusive o que for commitado durante o turno.
  const base = input.cwd ? gitTry(input.cwd, ['rev-parse', 'HEAD']) : null;
  saveState(sid, { prompt: clip(prompt, 6000), edits: 0, files: [], base });
  if (mode === 'off' || (input.prompt || '').trim().startsWith('/') || (input.prompt || '').trim().length < 15) return;

  const questions = {
    task_type: {
      type: 'choice',
      instructions: 'Que tipo de trabalho este pedido feito a um agente de programação exige?',
      criteria: {
        pergunta: 'Só pede explicação, análise, pesquisa ou informação; não exige alterar arquivos',
        bug: 'Corrigir um erro ou comportamento incorreto',
        feature: 'Criar funcionalidade ou código novo',
        refatoracao: 'Reorganizar ou melhorar código existente sem mudar o comportamento',
        config: 'Configuração, dependências, build, deploy ou infraestrutura',
        outro: null,
      },
    },
    scope: {
      type: 'score',
      instructions: 'Qual o tamanho provável da mudança de código necessária para atender o pedido?',
      criteria: [
        'Nenhuma mudança de código',
        'Trivial: uma ou poucas linhas em um arquivo',
        'Pequena: concentrada em um arquivo',
        'Média: alguns arquivos relacionados',
        'Grande: vários módulos ou mudança de arquitetura',
      ],
    },
    ambiguous: {
      type: 'noul',
      // O Jev vê só a mensagem, mas o agente tem o histórico: referências ao contexto não são ambiguidade.
      instructions: 'Esta é uma mensagem dentro de uma conversa em andamento com um agente de programação que já conhece o histórico, os arquivos e o projeto. Referências como "isso", "esse projeto", "o modelo", nomes de arquivos ou ferramentas citados antes são normais e NÃO tornam o pedido ambíguo. O pedido continua vago mesmo para quem tem esse contexto, a ponto de admitir resultados bem diferentes?',
      criteria: {
        true: 'Mesmo com o histórico, não dá para saber o que entregar: objetivo indefinido ("melhora", "arruma") sem dizer o quê nem como',
        false: 'A ação pedida é clara (instalar, trocar, abrir, copiar, testar, corrigir algo específico), ainda que dependa do contexto da conversa',
      },
    },
  };
  const areas = Object.entries(cfg.areas || {});
  if (areas.length) {
    questions.area = {
      type: 'choice',
      instructions: 'A qual área deste projeto o pedido se refere?',
      criteria: { ...Object.fromEntries(areas.map(([k, a]) => [k, a.description || null])), nenhuma: 'Nenhuma das áreas acima, ou não dá para saber' },
    };
  }

  const r = await askJev(cfg, `Pedido do usuário ao agente de programação:\n${redact(clip(prompt, 6000))}`, questions);
  const a = r.answers || {};
  const scope = a.scope ? normScore(a.scope) : null;
  const ambiguousBand = band(a.ambiguous?.noul, cfg.thresholds.ambiguous);
  const hints = [];
  if (a.task_type?.choice === 'pergunta' && a.task_type.confidence >= 0.6)
    hints.push('O pedido parece ser só pergunta/análise: responda sem editar arquivos, a menos que o usuário peça.');
  else if (scope != null && scope <= 0.5)
    hints.push('A mudança parece pequena: vá direto aos arquivos envolvidos, evite explorar o repositório inteiro e não use subagentes.');
  else if (scope != null && scope >= 0.85)
    hints.push('A mudança parece grande: planeje os passos antes de editar.');
  if (ambiguousBand === 'alto')
    hints.push('O pedido pode estar ambíguo: se faltar algo essencial, pergunte ao usuário antes de editar.');
  const area = a.area?.choice && cfg.areas[a.area.choice];
  if (area?.hint && a.area.confidence >= 0.5) hints.push(area.hint);

  const acted = mode === 'enforce' && hints.length > 0;
  log({
    ...baseLog('prompt', mode, input, r), contentHash: hash(prompt),
    answers: { task_type: a.task_type?.choice, task_conf: round(a.task_type?.confidence), scope: round(scope), ambiguous: a.ambiguous?.noul, area: a.area?.choice },
    uncertain: ambiguousBand === 'incerto' ? ['ambiguous'] : [],
    hints, acted,
  });
  if (acted) emit({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: `[Jev] ${hints.join(' ')}` } });
}

// ---------- hook: depois de editar arquivo (PostToolUse) ----------

function describeChange(ti) {
  if (ti.new_string != null) return `--- trecho anterior\n${ti.old_string ?? ''}\n+++ trecho novo\n${ti.new_string}`;
  if (Array.isArray(ti.edits)) return ti.edits.map((e) => `--- trecho anterior\n${e.old_string}\n+++ trecho novo\n${e.new_string}`).join('\n\n');
  if (ti.content != null) return `+++ conteúdo completo do arquivo\n${ti.content}`;
  if (ti.new_source != null) return `+++ célula nova\n${ti.new_source}`;
  return '';
}

async function onEdit(input, cfg, mode) {
  const ti = input.tool_input || {};
  const file = ti.file_path || ti.notebook_path || '';
  const st = loadState(input.session_id);
  st.edits = (st.edits || 0) + 1;
  if (file && !st.files.includes(file)) st.files.push(file);
  saveState(input.session_id, st);

  const custom = customQuestions(cfg, 'edit');
  if (mode === 'off' || (!cfg.rules.length && !Object.keys(custom).length)) return;
  if (cfg.ignoreFiles.some((p) => file.endsWith(p) || basename(file) === p)) return;
  if (['.md', '.txt', '.json'].includes(extname(file).toLowerCase()) && !cfg.checkDocs) return;
  const change = describeChange(ti);
  if (!change.trim()) return;

  const rules = cfg.rules.slice(0, 20);
  const questions = {
    ...Object.fromEntries(rules.map((rule, i) => [`r${i}`, {
      type: 'noul',
      instructions: `Esta alteração de código viola a regra a seguir? Regra: ${rule}`,
      criteria: {
        true: 'O código novo claramente viola a regra',
        false: 'O código novo respeita a regra, ou a regra não se aplica a este trecho',
      },
    }])),
    ...custom,
  };
  const state = `${projectContext(input.cwd, cfg)}Arquivo: ${file}\n\n${redact(clip(change, 12000))}`;
  const r = await askJev(cfg, state, questions);
  const scores = rules.map((_, i) => r.answers?.[`r${i}`]?.noul ?? null);
  const ruleBands = rules.map((rule, i) => ({ rule, p: scores[i], band: band(scores[i], cfg.thresholds.rule) }));
  const extra = evalCustom(cfg, 'edit', r.answers);
  const flagged = [
    ...ruleBands.filter((x) => x.band === 'alto').map((x) => `${x.rule} (p=${x.p.toFixed(2)})`),
    ...extra.filter((x) => x.band === 'alto').map((x) => `${x.message} (${x.value})`),
  ];
  const uncertain = [
    ...ruleBands.filter((x) => x.band === 'incerto').map((x) => x.rule),
    ...extra.filter((x) => x.band === 'incerto').map((x) => x.id),
  ];

  const acted = mode === 'enforce' && flagged.length > 0;
  log({
    ...baseLog('edit', mode, input, r), file: basename(file), contentHash: hash(change),
    scores, custom: Object.fromEntries(extra.map((x) => [x.id, x.value ?? x.choice])), flagged, uncertain, acted,
  });
  if (acted) {
    emit({ decision: 'block', reason: `[Jev] Possíveis problemas em ${basename(file)}:\n${flagged.map((f) => `- ${f}`).join('\n')}\nRevise o trecho. Se for falso positivo, siga em frente sem mudar nada.` });
  }
}

// ---------- hook: Claude quer encerrar (Stop) ----------

const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

// Mudanças do turno: diff contra o commit do início do turno, só nos arquivos editados.
// Arquivos fora do git (ou novos) entram com o conteúdo atual.
function turnChanges(cwd, st, max) {
  const files = (st.files || []).map((f) => resolve(cwd || '.', f));
  const top = cwd ? gitTry(cwd, ['rev-parse', '--show-toplevel']) : null;
  const inRepo = (f) => {
    if (!top) return false;
    const rel = relative(resolve(top), f);
    return rel && !rel.startsWith('..') && !isAbsolute(rel);
  };
  const repoFiles = files.filter(inRepo);
  const parts = [];

  if (top && repoFiles.length) {
    const tracked = (gitTry(top, ['ls-files', '--', ...repoFiles]) || '').split('\n').filter(Boolean).map((f) => resolve(top, f));
    const baseRef = st.base || 'HEAD';
    if (tracked.length) {
      try { parts.push(git(top, ['diff', '--no-color', baseRef, '--', ...tracked])); } catch { /* base sumiu (rebase etc.) */ }
    }
    for (const f of repoFiles.filter((f) => !tracked.some((t) => samePath(t, f)))) {
      try { parts.push(`+++ arquivo novo: ${relative(top, f)}\n${clip(readFileSync(f, 'utf8'), 6000)}`); } catch { /* removido */ }
    }
  }
  for (const f of files.filter((f) => !inRepo(f))) {
    try { parts.push(`+++ conteúdo atual (fora do git): ${f}\n${clip(readFileSync(f, 'utf8'), 6000)}`); } catch { /* removido */ }
  }
  return clip(parts.filter((p) => p.trim()).join('\n\n'), max);
}

function runVerify(cwd, cfg) {
  if (!cfg.verify) return null;
  const t0 = Date.now();
  try {
    const out = execSync(cfg.verify, { cwd, encoding: 'utf8', timeout: cfg.verifyTimeoutMs, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 20 * 1024 * 1024 });
    return { exit: 0, ms: Date.now() - t0, output: tail(out, 3000) };
  } catch (e) {
    const timedOut = e.code === 'ETIMEDOUT' || e.signal === 'SIGTERM';
    return { exit: timedOut ? 'timeout' : e.status ?? 'erro', ms: Date.now() - t0, output: tail(`${e.stdout || ''}${e.stderr || ''}`, 3000) };
  }
}

async function onStop(input, cfg, mode) {
  if (mode === 'off' || input.stop_hook_active) return; // evita laço infinito
  const st = loadState(input.session_id);
  if (!st.edits) return; // nada foi editado neste turno
  saveState(input.session_id, { ...st, edits: 0 });

  const changes = turnChanges(input.cwd, st, cfg.maxDiffChars);
  if (!changes.trim()) { log({ hook: 'stop', mode, project: basename(input.cwd || ''), skipped: 'sem mudanças legíveis no turno' }); return; }
  const verify = runVerify(input.cwd, cfg);

  const state = [
    projectContext(input.cwd, cfg),
    `Pedido do usuário:\n${redact(st.prompt)}`,
    `Arquivos editados neste turno:\n${st.files.join('\n')}`,
    `Alterações feitas pelo agente neste turno:\n${redact(changes)}`,
    verify && `Resultado da verificação automática (\`${cfg.verify}\`): código de saída ${verify.exit}\n${redact(verify.output)}`,
  ].filter(Boolean).join('\n\n');

  const r = await askJev(cfg, state, {
    completeness: {
      type: 'score',
      instructions: 'O quanto as alterações atendem ao que o usuário pediu?',
      criteria: ['Não atendem ao pedido', 'Atendem pouco; partes centrais faltando', 'Atendem parcialmente', 'Atendem quase tudo; faltam detalhes', 'Atendem completamente'],
    },
    unfinished: {
      type: 'noul',
      instructions: 'As alterações deixam algo inacabado (placeholders, TODO novos, trechos pela metade, partes pedidas sem implementar)?',
      criteria: { true: 'Há sinais claros de trabalho inacabado', false: 'O trabalho parece concluído' },
    },
    out_of_scope: {
      type: 'noul',
      instructions: 'As alterações mexem em coisas que o usuário não pediu?',
      criteria: { true: 'Há mudanças relevantes fora do escopo do pedido', false: 'As mudanças se limitam ao pedido' },
    },
    ...customQuestions(cfg, 'stop'),
  });
  const a = r.answers || {};
  const completeness = a.completeness ? normScore(a.completeness) : null;
  const incompleteBand = band(completeness == null ? null : 1 - completeness, cfg.thresholds.incomplete);
  const unfinishedBand = band(a.unfinished?.noul, cfg.thresholds.unfinished);
  const extra = evalCustom(cfg, 'stop', a);

  const problems = [];
  if (incompleteBand === 'alto') problems.push(`o pedido pode não estar completo (nota ${(completeness * 100).toFixed(0)}/100)`);
  if (unfinishedBand === 'alto') problems.push(`há sinais de trabalho inacabado (p=${a.unfinished.noul.toFixed(2)})`);
  if (verify && verify.exit !== 0) problems.push(`a verificação \`${cfg.verify}\` falhou (saída ${verify.exit})`);
  for (const x of extra.filter((x) => x.band === 'alto')) problems.push(`${x.message} (${x.value})`);
  const uncertain = [
    incompleteBand === 'incerto' && 'completeness',
    unfinishedBand === 'incerto' && 'unfinished',
    ...extra.filter((x) => x.band === 'incerto').map((x) => x.id),
  ].filter(Boolean);

  const acted = mode === 'enforce' && problems.length > 0;
  log({
    ...baseLog('stop', mode, input, r), contentHash: hash(changes), files: st.files.length, base: st.base?.slice(0, 7),
    verify: verify && { exit: verify.exit, ms: verify.ms },
    answers: { completeness: round(completeness), unfinished: a.unfinished?.noul, out_of_scope: a.out_of_scope?.noul, ...Object.fromEntries(extra.map((x) => [x.id, x.value ?? x.choice])) },
    problems, uncertain, acted,
  });
  if (acted) emit({ decision: 'block', reason: `[Jev] Antes de encerrar: ${problems.join('; ')}. Confira o pedido original contra o que foi feito. Se estiver tudo certo, encerre explicando brevemente.` });
}

// ---------- hook: antes de comando de terminal (PreToolUse) ----------

// Comandos claramente só de leitura passam sem chamar o Jev. Qualquer encadeamento,
// redirecionamento ou substituição desqualifica o atalho (podem esconder outro comando).
const READ_ONLY = /^\s*(ls|dir|pwd|cat|type|head|tail|wc|echo|which|where|grep|rg|find|tree|node\s+(-v|--version)|npm\s+(ls|view|-v|--version)|git\s+(status|diff|log|show|branch|remote\s+-v|rev-parse|ls-files|blame)|Get-ChildItem|Get-Content|Select-String|Test-Path|Get-Location)\b/i;
const SHELL_META = /[;&|<>`\n]|\$\(|\$\{|-delete\b|-exec\b|--output\b|-o\s/;
const SENSITIVE = /\.env|secret|credential|\.ssh|\.pem|\.key\b|token|passw|senha|\.npmrc|\.gitconfig\.local/i;
const isReadOnly = (cmd) => READ_ONLY.test(cmd) && !SHELL_META.test(cmd) && !SENSITIVE.test(cmd);

async function onBash(input, cfg, mode) {
  if (mode === 'off') return;
  const cmd = input.tool_input?.command || '';
  if (!cmd.trim()) return;
  if (isReadOnly(cmd)) { log({ hook: 'bash', mode, project: basename(input.cwd || ''), skipped: 'leitura' }); return; }
  const r = await askJev(cfg, `Comando que o agente quer executar (${input.tool_name}):\n${redact(clip(cmd, 4000))}`, {
    side_effects: {
      type: 'noul',
      instructions: 'Este comando tem efeito destrutivo ou difícil de desfazer (apagar arquivos, sobrescrever dados, git push --force ou reset --hard, publicar ou fazer deploy, alterar banco de dados, enviar dados para serviço externo)?',
      criteria: { true: 'Pode causar dano ou mudança difícil de reverter', false: 'Só lê informação ou faz mudança local fácil de desfazer' },
    },
    credentials: {
      type: 'noul',
      instructions: 'Este comando lê, exibe, copia ou envia credenciais, chaves, tokens ou senhas?',
      criteria: { true: 'Mexe com credenciais', false: 'Não envolve credenciais' },
    },
  });
  const a = r.answers || {};
  const sideBand = band(a.side_effects?.noul, cfg.thresholds.sideEffects);
  const credBand = band(a.credentials?.noul, cfg.thresholds.credentials);
  const reasons = [];
  if (sideBand === 'alto') reasons.push(`efeito destrutivo (p=${a.side_effects.noul.toFixed(2)})`);
  if (credBand === 'alto') reasons.push(`acesso a credenciais (p=${a.credentials.noul.toFixed(2)})`);
  const uncertain = [sideBand === 'incerto' && 'side_effects', credBand === 'incerto' && 'credentials'].filter(Boolean);

  const acted = mode === 'enforce' && reasons.length > 0;
  log({ ...baseLog('bash', mode, input, r), contentHash: hash(cmd), answers: { side_effects: a.side_effects?.noul, credentials: a.credentials?.noul }, flagged: reasons, uncertain, acted });
  // "ask" nunca bloqueia sozinho: só força a sua confirmação.
  if (acted) emit({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: `[Jev] Comando sinalizado: ${reasons.join(', ')}` } });
}

// ---------- hook: antes de criar subagente (PreToolUse em Agent) ----------

async function onAgent(input, cfg, mode) {
  const ti = input.tool_input || {};
  if (mode === 'off' || ti.model || !ti.prompt) return; // modelo escolhido explicitamente é respeitado
  const r = await askJev(cfg, `Tarefa delegada a um subagente (${ti.subagent_type || 'geral'}): ${redact(ti.description || '')}\n\n${redact(clip(ti.prompt, 6000))}`, {
    simple: {
      type: 'noul',
      instructions: 'Esta tarefa é simples o bastante para um modelo pequeno e rápido fazer bem (buscar arquivos, ler e resumir, listar ocorrências, perguntas factuais), sem exigir raciocínio difícil, decisões de arquitetura ou escrita de código complexo?',
      criteria: {
        true: 'Busca, leitura ou resumo direto; um modelo pequeno resolve',
        false: 'Exige raciocínio em várias etapas, julgamento de design, depuração difícil ou código não trivial',
      },
    },
  });
  const p = r.answers?.simple?.noul;
  const b = band(p, cfg.thresholds.simpleTask);
  const acted = mode === 'enforce' && b === 'alto';
  log({ ...baseLog('agent', mode, input, r), subagent: ti.subagent_type, contentHash: hash(ti.prompt), answers: { simple: p }, suggested: b === 'alto' ? cfg.routeModel : null, uncertain: b === 'incerto' ? ['simple'] : [], acted });
  // Sem permissionDecision: só troca o modelo, a permissão segue o fluxo normal.
  if (acted) emit({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...ti, model: cfg.routeModel } } });
}

// ---------- hook: subagente vai encerrar (SubagentStop) ----------

// Resume as ações reais do subagente a partir do transcript (arquivos tocados e comandos).
function subagentActions(path) {
  const actions = [];
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.includes('tool_use')) continue;
      let entry; try { entry = JSON.parse(line); } catch { continue; }
      for (const c of entry?.message?.content || []) {
        if (c?.type !== 'tool_use') continue;
        const i = c.input || {};
        const target = i.file_path || i.notebook_path || i.command || i.pattern || i.url || i.query || '';
        actions.push(`${c.name}: ${clip(String(target), 200)}`);
      }
    }
  } catch { /* transcript indisponível */ }
  return actions;
}

async function onSubagent(input, cfg, mode) {
  if (mode === 'off' || input.stop_hook_active) return;
  const report = input.last_assistant_message || '';
  const actions = subagentActions(input.agent_transcript_path);
  // Só vale conferir quando o subagente mexeu em algo (edição ou comando).
  if (!report.trim() || !actions.some((a) => /^(Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell):/.test(a))) return;

  const state = `Ações executadas pelo subagente (${input.agent_type || 'geral'}), em ordem:\n${redact(clip(actions.join('\n'), 12000))}\n\nRelatório final do subagente:\n${redact(clip(report, 8000))}`;
  const r = await askJev(cfg, state, {
    false_claims: {
      type: 'noul',
      instructions: 'O relatório afirma ter feito, alterado, testado ou verificado algo que não aparece nas ações executadas?',
      criteria: {
        true: 'O relatório declara trabalho (edições, testes, verificações) sem ação correspondente na lista',
        false: 'Tudo que o relatório afirma tem ação correspondente, ou ele só descreve o que encontrou',
      },
    },
  });
  const p = r.answers?.false_claims?.noul;
  const b = band(p, cfg.thresholds.falseClaims);
  const acted = mode === 'enforce' && b === 'alto';
  log({ ...baseLog('subagent', mode, input, r), subagent: input.agent_type, actions: actions.length, contentHash: hash(report), answers: { false_claims: p }, uncertain: b === 'incerto' ? ['false_claims'] : [], flagged: b === 'alto' ? [`relatório não bate com as ações (p=${p.toFixed(2)})`] : [], acted });
  if (acted) emit({ decision: 'block', reason: `[Jev] Seu relatório parece afirmar trabalho que não aparece nas ações executadas (p=${p.toFixed(2)}). Corrija o relatório para refletir só o que foi de fato feito e verificado, ou faça o que falta.` });
}

// ---------- utilitários de linha de comando ----------

async function selftest() {
  const cfg = loadConfig(process.cwd());
  console.log(`Chave: ${process.env.TYPESAFE_API_KEY || readEnvFile().TYPESAFE_API_KEY ? 'encontrada' : 'NÃO encontrada (preencha o .env do harness)'}`);
  const r = await askJev(cfg, 'Pedido do usuário: corrija o erro de digitação no título da página inicial', {
    trivial: { type: 'noul', instructions: 'Esta é uma mudança trivial de código?' },
    size: { type: 'score', instructions: 'Tamanho da mudança', criteria: ['Nenhuma', 'Trivial', 'Pequena', 'Média', 'Grande'] },
    kind: { type: 'choice', instructions: 'Tipo de tarefa', criteria: { bug: null, feature: null, outro: null } },
  });
  console.log(`Modelo: ${r.model} | latência: ${r.latencyMs} ms | tokens de entrada: ${r.usage?.input_tokens}`);
  console.log(JSON.stringify(r.answers, null, 2));
}

function report() {
  if (!existsSync(LOG_DIR)) return console.log('Sem logs ainda.');
  const entries = readdirSync(LOG_DIR).filter((f) => f.endsWith('.jsonl')).sort()
    .flatMap((f) => readFileSync(join(LOG_DIR, f), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }))
    .filter(Boolean);
  const by = {};
  for (const e of entries) {
    const s = (by[e.hook] ||= { chamadas: 0, erros: 0, sinalizados: 0, incertos: 0, agiu: 0, latencia: 0, tokens: 0 });
    s.chamadas++;
    if (e.error) { s.erros++; continue; }
    const flagged = (e.flagged?.length || 0) + (e.problems?.length || 0) + (e.hints?.length || 0);
    if (flagged) s.sinalizados++;
    if (e.uncertain?.length) s.incertos++;
    if (e.acted) s.agiu++;
    s.latencia += e.latencyMs || 0;
    s.tokens += e.inputTokens || 0;
  }
  console.table(Object.entries(by).map(([hook, s]) => ({
    hook, chamadas: s.chamadas, erros: s.erros, sinalizados: s.sinalizados, incertos: s.incertos, agiu: s.agiu,
    'latência média (ms)': Math.round(s.latencia / Math.max(1, s.chamadas - s.erros)),
    'tokens entrada': s.tokens, 'custo US$': (s.tokens / 1e6 * PRICE_PER_M_INPUT).toFixed(5),
  })));

  // Distribuição dos valores por pergunta, para calibrar as faixas de thresholds.
  const values = {};
  const push = (k, v) => { if (typeof v === 'number') (values[k] ||= []).push(v); };
  for (const e of entries) {
    if (e.error) continue;
    for (const [k, v] of Object.entries(e.answers || {})) push(`${e.hook}.${k}`, v);
    for (const [k, v] of Object.entries(e.custom || {})) push(`${e.hook}.${k}`, v);
    (e.scores || []).forEach((v, i) => push(`edit.regra${i + 1}`, v));
  }
  const pct = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(p * arr.length))];
  console.log('\nDistribuição por pergunta (0..1):');
  console.table(Object.entries(values).sort().map(([k, arr]) => {
    arr.sort((x, y) => x - y);
    const bucket = (lo, hi) => arr.filter((v) => v >= lo && (hi === 1 ? v <= 1 : v < hi)).length;
    return { pergunta: k, n: arr.length, mediana: round(pct(arr, 0.5)), p90: round(pct(arr, 0.9)), max: round(arr[arr.length - 1]), '<.25': bucket(0, 0.25), '.25-.5': bucket(0.25, 0.5), '.5-.75': bucket(0.5, 0.75), '≥.75': bucket(0.75, 1) };
  }));

  const recent = entries.filter((e) => e.error || e.flagged?.length || e.problems?.length || e.hints?.length).slice(-15);
  if (recent.length) {
    console.log('\nÚltimos eventos sinalizados/erros:');
    for (const e of recent) console.log(`${e.ts} [${e.hook}] ${e.project || ''} ${e.error || JSON.stringify(e.flagged || e.problems || e.hints)}`);
  }
}

// ---------- entrada ----------

const HANDLERS = { prompt: onPrompt, edit: onEdit, stop: onStop, bash: onBash, agent: onAgent, subagent: onSubagent };

// Funções puras exportadas para os testes.
export { DEFAULTS, redact, band, normScore, loadConfig, isReadOnly, evalCustom, describeChange };

// Só executa quando chamado direto (node claujev.mjs ...), não quando importado pelos testes.
const isMain = (() => {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();

if (isMain) {
  const cmd = process.argv[2];
  if (cmd === 'selftest') await selftest().catch((e) => { console.error(`Falhou: ${e.message}`); process.exitCode = 1; });
  else if (cmd === 'report') report();
  else if (HANDLERS[cmd]) {
    let input = {};
    try {
      input = await readStdin();
      const cfg = loadConfig(input.cwd);
      const disabled = process.env.CLAUJEV_DISABLED === '1' || process.env.JEV_DISABLED === '1';
      if (cfg.enabled && !disabled) await HANDLERS[cmd](input, cfg, cfg.hooks[cmd] || 'observe');
    } catch (e) {
      log({ hook: cmd, project: basename(input.cwd || ''), error: String(e?.message || e) });
    }
  } else {
    console.error('Uso: node claujev.mjs <prompt|edit|stop|bash|agent|subagent|selftest|report>');
    process.exitCode = 1;
  }
}
