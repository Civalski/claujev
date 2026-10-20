#!/usr/bin/env node
// ClauJev: Jev (TypeSafe AI) as a second pair of eyes for Claude Code.
// Copyright (c) 2026 Alisson Civalski — MIT License — https://github.com/Civalski/claujev
// Usage: node claujev.mjs <prompt|edit|stop|bash|agent|subagent|session|selftest|report>
// Hooks never break the session: any error is logged and Claude carries on.
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, basename, extname, resolve, relative, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Fixed folder for config, key, logs and state, shared by the plugin, the manual install and the mod.
export const HERE = process.env.CLAUJEV_HOME || join(homedir(), '.claude', 'claujev');
const LOG_DIR = join(HERE, 'logs');
const STATE_DIR = join(HERE, 'state');
const API_URL = 'https://api.typesafe.ai/v1/systemone';
const PRICE_PER_M_INPUT = 0.042; // US$ per million input tokens; output is free
const OPT = (k) => process.env[`CLAUDE_PLUGIN_OPTION_${k}`]; // plugin userConfig values

const DEFAULTS = {
  enabled: true,
  lang: 'en',
  model: 'jev-latest',
  timeoutMs: 5000, // per attempt; a timed-out call is retried once (hooks have a 15 s budget)
  // Per hook: "observe" only logs, "enforce" acts on Claude, "off" disables.
  hooks: { prompt: 'observe', edit: 'observe', stop: 'observe', bash: 'observe', agent: 'observe', subagent: 'observe' },
  // Model suggested for subagents with a simple task.
  routeModel: 'haiku',
  // Bands: value >= high => acts (in enforce); between low and high => "uncertain" (log only); below low => nothing.
  thresholds: {
    ambiguous: { low: 0.5, high: 0.7 },
    rule: { low: 0.5, high: 0.85 },
    incomplete: { low: 0.25, high: 0.4 }, // 1 - completeness score
    unfinished: { low: 0.5, high: 0.85 },
    sideEffects: { low: 0.5, high: 0.85 },
    credentials: { low: 0.5, high: 0.7 },
    simpleTask: { low: 0.5, high: 0.8 },
    falseClaims: { low: 0.5, high: 0.8 },
  },
  rules: null, // null = the built-in rules in the chosen language
  areas: {},
  context: [],
  contextChars: 4000,
  verify: null,
  verifyTimeoutMs: 45000,
  questions: {},
  ignoreFiles: ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', '.min.js', '.map', '.svg', '.png', '.jpg'],
  maxDiffChars: 30000,
};

// ---------- texts (en / pt) ----------
// Question ids and choice keys are the same in every language, so logs and reports stay comparable.

const TEXT = {
  en: {
    rules: [
      'Do not leave incomplete code: placeholders, new TODO/FIXME, empty functions or "implement later".',
      'Do not put secrets (API keys, passwords, tokens) directly in the code.',
      'Do not swallow errors silently (empty catch, or one that ignores the error without handling or logging it).',
    ],
    removedKey: '[KEY REMOVED]', removedSecret: '[SECRET REMOVED]', truncated: '\n…[truncated]', omitted: '…[start omitted]\n',
    projectContext: 'Project context:',
    prompt: {
      state: 'User request to the coding agent:',
      followUp: '[next user message]:',
      taskType: {
        instructions: 'What kind of work does this request to a coding agent require?',
        criteria: {
          question: 'Only asks for an explanation, analysis, research or information; no file changes needed',
          bug: 'Fix an error or incorrect behaviour',
          feature: 'Create new functionality or code',
          refactor: 'Reorganise or improve existing code without changing behaviour',
          config: 'Configuration, dependencies, build, deploy or infrastructure',
          other: null,
        },
      },
      scope: {
        instructions: 'How large is the code change needed to fulfil the request likely to be?',
        criteria: ['No code change', 'Trivial: one or a few lines in one file', 'Small: contained in one file', 'Medium: a few related files', 'Large: several modules or an architecture change'],
      },
      ambiguous: {
        instructions: 'This is a message inside an ongoing conversation with a coding agent that already knows the history, the files and the project. References such as "this", "that project", "the model", or file and tool names mentioned earlier are normal and do NOT make the request ambiguous. Is the request still vague even for someone with that context, to the point of allowing very different results?',
        criteria: {
          true: 'Even with the history, it is unclear what to deliver: an undefined goal ("improve it", "fix it") without saying what or how',
          false: 'The requested action is clear (install, replace, open, copy, test, fix something specific), even if it depends on the conversation context',
        },
      },
      area: 'Which area of this project does the request refer to?',
      areaNone: 'None of the areas above, or impossible to tell',
      hints: {
        question: 'The request looks like a question/analysis only: answer without editing files unless the user asks.',
        small: 'The change looks small: go straight to the files involved, avoid exploring the whole repository and do not use subagents.',
        large: 'The change looks large: plan the steps before editing.',
        ambiguous: 'The request may be ambiguous: if something essential is missing, ask the user before editing.',
      },
    },
    edit: {
      file: 'File:',
      before: '--- previous snippet', after: '+++ new snippet', full: '+++ full file content', cell: '+++ new cell',
      rule: (rule) => `Does this code change violate the following rule? Rule: ${rule}`,
      criteria: { true: 'The new code clearly violates the rule', false: 'The new code follows the rule, or the rule does not apply to this snippet' },
      localSecret: 'A secret (API key, token or password) is written directly in the new code; move it to an environment variable (detected on this machine, never sent to Jev)',
      block: (file, list) => `[Jev] Possible problems in ${file}:\n${list}\nReview the snippet. If it is a false positive, carry on without changing anything.`,
    },
    stop: {
      request: 'User request:',
      files: 'Files edited in this turn:',
      changes: 'Changes made by the agent in this turn:',
      commands: 'Commands run by the agent in this turn (they are part of the work, e.g. publishing, releases, deploys):',
      newFile: '+++ new file:', outsideGit: '+++ current content (outside git):',
      verify: (cmd, exit) => `Automatic check result (\`${cmd}\`): exit code ${exit}`,
      completeness: {
        instructions: 'Considering both the file changes and the commands run, how much of what the user asked has been done?',
        criteria: ['Not done', 'Barely done; central parts missing', 'Partly done', 'Almost all done; details missing', 'Fully done'],
      },
      unfinished: {
        instructions: 'Do the changes leave something unfinished (placeholders, new TODOs, half-done snippets, requested parts not implemented)?',
        criteria: { true: 'There are clear signs of unfinished work', false: 'The work looks finished' },
      },
      outOfScope: {
        instructions: 'Do the changes touch things the user did not ask for?',
        criteria: { true: 'There are relevant changes outside the scope of the request', false: 'The changes stay within the request' },
      },
      incomplete: (n) => `the request may not be complete (score ${n}/100)`,
      unfinishedP: (p) => `there are signs of unfinished work (p=${p})`,
      verifyFailed: (cmd, exit) => `the check \`${cmd}\` failed (exit ${exit})`,
      block: (problems) => `[Jev] Before finishing: ${problems}. Check the original request against what was done. If everything is right, finish with a short explanation.`,
      skipped: 'no readable changes in the turn',
    },
    bash: {
      state: (tool) => `Command the agent wants to run (${tool}):`,
      sideEffects: {
        instructions: 'Is this command destructive or hard to undo (deleting files, overwriting data, git push --force or reset --hard, publishing or deploying, changing a database, sending data to an external service)?',
        criteria: { true: 'May cause damage or a change that is hard to revert', false: 'Only reads information or makes a local change that is easy to undo' },
      },
      credentials: {
        instructions: 'Does this command read, print, copy or send credentials, keys, tokens or passwords?',
        criteria: { true: 'Touches credentials', false: 'Does not involve credentials' },
      },
      destructive: (p) => `destructive effect (p=${p})`,
      creds: (p) => `credential access (p=${p})`,
      ask: (reasons) => `[Jev] Command flagged: ${reasons}`,
      fallback: '[Jev] Jev could not check this command in time, and it looks destructive (local check): confirm it yourself.',
    },
    agent: {
      state: (type, desc) => `Task delegated to a subagent (${type}): ${desc}`,
      general: 'general',
      simple: {
        instructions: 'Is this task simple enough for a small, fast model to do well (finding files, reading and summarising, listing occurrences, factual questions), without hard reasoning, architecture decisions or complex code?',
        criteria: { true: 'Straightforward search, reading or summary; a small model can do it', false: 'Needs multi-step reasoning, design judgement, hard debugging or non-trivial code' },
      },
    },
    subagent: {
      state: (type) => `Actions run by the subagent (${type}), in order:`,
      report: 'Final report of the subagent:',
      falseClaims: {
        instructions: 'Does the report claim to have done, changed, tested or verified something that does not appear in the actions run?',
        criteria: { true: 'The report claims work (edits, tests, checks) with no matching action in the list', false: 'Everything the report claims has a matching action, or it only describes what it found' },
      },
      flagged: (p) => `report does not match the actions (p=${p})`,
      block: (p) => `[Jev] Your report seems to claim work that does not appear in the actions run (p=${p}). Fix the report so it reflects only what was actually done and checked, or do what is missing.`,
    },
    selftest: {
      key: (ok) => `Key: ${ok ? 'found' : 'NOT found (set it in the plugin settings or in ~/.claude/claujev/.env)'}`,
      noKey: 'TYPESAFE_API_KEY not set (set the API key in the plugin settings or in ~/.claude/claujev/.env)',
      failed: (m) => `Failed: ${m}`,
      model: (m, ms, t) => `Model: ${m} | latency: ${ms} ms | input tokens: ${t}`,
    },
    report: {
      empty: 'No logs yet.', distribution: '\nDistribution per question (0..1):', recent: '\nLatest flagged events/errors:', effort: '\nSuggested effort:',
      cols: { hook: 'hook', calls: 'calls', errors: 'errors', flagged: 'flagged', uncertain: 'uncertain', acted: 'acted', latency: 'avg latency (ms)', tokens: 'input tokens', cost: 'cost US$', question: 'question', median: 'median' },
    },
    session: {
      firstRun: (hasKey) => `[ClauJev] ClauJev (Jev hooks by TypeSafe AI) was just installed and this is its first session. Once, at a natural moment (after answering the user's current request if they asked for something), offer the guided setup: the /claujev:configure skill asks a few basic preferences (language, mode, which features to keep) and applies them.${hasKey ? '' : ' The TypeSafe AI key is not set yet, so ClauJev is idle until the user runs /plugin configure claujev@claujev. Never ask for the key in the chat.'}`,
      noKey: '[ClauJev] The TypeSafe AI key is not set, so ClauJev is idle. Mention it once to the user: run /plugin configure claujev@claujev (or /claujev:configure for the guided setup). Never ask for the key in the chat.',
    },
    usage: 'Usage: node claujev.mjs <prompt|edit|stop|bash|agent|subagent|session|selftest|report>',
  },

  pt: {
    rules: [
      'Não deixar código incompleto: placeholders, TODO/FIXME novos, funções vazias ou "implementar depois".',
      'Não colocar segredos (chaves de API, senhas, tokens) diretamente no código.',
      'Não engolir erros silenciosamente (catch vazio ou que ignora o erro sem tratar nem registrar).',
    ],
    removedKey: '[CHAVE REMOVIDA]', removedSecret: '[SEGREDO REMOVIDO]', truncated: '\n…[truncado]', omitted: '…[início omitido]\n',
    projectContext: 'Contexto do projeto:',
    prompt: {
      state: 'Pedido do usuário ao agente de programação:',
      followUp: '[mensagem seguinte do usuário]:',
      taskType: {
        instructions: 'Que tipo de trabalho este pedido feito a um agente de programação exige?',
        criteria: {
          question: 'Só pede explicação, análise, pesquisa ou informação; não exige alterar arquivos',
          bug: 'Corrigir um erro ou comportamento incorreto',
          feature: 'Criar funcionalidade ou código novo',
          refactor: 'Reorganizar ou melhorar código existente sem mudar o comportamento',
          config: 'Configuração, dependências, build, deploy ou infraestrutura',
          other: null,
        },
      },
      scope: {
        instructions: 'Qual o tamanho provável da mudança de código necessária para atender o pedido?',
        criteria: ['Nenhuma mudança de código', 'Trivial: uma ou poucas linhas em um arquivo', 'Pequena: concentrada em um arquivo', 'Média: alguns arquivos relacionados', 'Grande: vários módulos ou mudança de arquitetura'],
      },
      ambiguous: {
        instructions: 'Esta é uma mensagem dentro de uma conversa em andamento com um agente de programação que já conhece o histórico, os arquivos e o projeto. Referências como "isso", "esse projeto", "o modelo", nomes de arquivos ou ferramentas citados antes são normais e NÃO tornam o pedido ambíguo. O pedido continua vago mesmo para quem tem esse contexto, a ponto de admitir resultados bem diferentes?',
        criteria: {
          true: 'Mesmo com o histórico, não dá para saber o que entregar: objetivo indefinido ("melhora", "arruma") sem dizer o quê nem como',
          false: 'A ação pedida é clara (instalar, trocar, abrir, copiar, testar, corrigir algo específico), ainda que dependa do contexto da conversa',
        },
      },
      area: 'A qual área deste projeto o pedido se refere?',
      areaNone: 'Nenhuma das áreas acima, ou não dá para saber',
      hints: {
        question: 'O pedido parece ser só pergunta/análise: responda sem editar arquivos, a menos que o usuário peça.',
        small: 'A mudança parece pequena: vá direto aos arquivos envolvidos, evite explorar o repositório inteiro e não use subagentes.',
        large: 'A mudança parece grande: planeje os passos antes de editar.',
        ambiguous: 'O pedido pode estar ambíguo: se faltar algo essencial, pergunte ao usuário antes de editar.',
      },
    },
    edit: {
      file: 'Arquivo:',
      before: '--- trecho anterior', after: '+++ trecho novo', full: '+++ conteúdo completo do arquivo', cell: '+++ célula nova',
      rule: (rule) => `Esta alteração de código viola a regra a seguir? Regra: ${rule}`,
      criteria: { true: 'O código novo claramente viola a regra', false: 'O código novo respeita a regra, ou a regra não se aplica a este trecho' },
      localSecret: 'Há um segredo (chave de API, token ou senha) escrito direto no código novo; mova para variável de ambiente (detectado nesta máquina, nunca enviado ao Jev)',
      block: (file, list) => `[Jev] Possíveis problemas em ${file}:\n${list}\nRevise o trecho. Se for falso positivo, siga em frente sem mudar nada.`,
    },
    stop: {
      request: 'Pedido do usuário:',
      files: 'Arquivos editados neste turno:',
      changes: 'Alterações feitas pelo agente neste turno:',
      commands: 'Comandos executados pelo agente neste turno (fazem parte do trabalho, ex.: publicação, release, deploy):',
      newFile: '+++ arquivo novo:', outsideGit: '+++ conteúdo atual (fora do git):',
      verify: (cmd, exit) => `Resultado da verificação automática (\`${cmd}\`): código de saída ${exit}`,
      completeness: {
        instructions: 'Considerando as alterações em arquivos e os comandos executados, o quanto do que o usuário pediu foi feito?',
        criteria: ['Não atendem ao pedido', 'Atendem pouco; partes centrais faltando', 'Atendem parcialmente', 'Atendem quase tudo; faltam detalhes', 'Atendem completamente'],
      },
      unfinished: {
        instructions: 'As alterações deixam algo inacabado (placeholders, TODO novos, trechos pela metade, partes pedidas sem implementar)?',
        criteria: { true: 'Há sinais claros de trabalho inacabado', false: 'O trabalho parece concluído' },
      },
      outOfScope: {
        instructions: 'As alterações mexem em coisas que o usuário não pediu?',
        criteria: { true: 'Há mudanças relevantes fora do escopo do pedido', false: 'As mudanças se limitam ao pedido' },
      },
      incomplete: (n) => `o pedido pode não estar completo (nota ${n}/100)`,
      unfinishedP: (p) => `há sinais de trabalho inacabado (p=${p})`,
      verifyFailed: (cmd, exit) => `a verificação \`${cmd}\` falhou (saída ${exit})`,
      block: (problems) => `[Jev] Antes de encerrar: ${problems}. Confira o pedido original contra o que foi feito. Se estiver tudo certo, encerre explicando brevemente.`,
      skipped: 'sem mudanças legíveis no turno',
    },
    bash: {
      state: (tool) => `Comando que o agente quer executar (${tool}):`,
      sideEffects: {
        instructions: 'Este comando tem efeito destrutivo ou difícil de desfazer (apagar arquivos, sobrescrever dados, git push --force ou reset --hard, publicar ou fazer deploy, alterar banco de dados, enviar dados para serviço externo)?',
        criteria: { true: 'Pode causar dano ou mudança difícil de reverter', false: 'Só lê informação ou faz mudança local fácil de desfazer' },
      },
      credentials: {
        instructions: 'Este comando lê, exibe, copia ou envia credenciais, chaves, tokens ou senhas?',
        criteria: { true: 'Mexe com credenciais', false: 'Não envolve credenciais' },
      },
      destructive: (p) => `efeito destrutivo (p=${p})`,
      creds: (p) => `acesso a credenciais (p=${p})`,
      ask: (reasons) => `[Jev] Comando sinalizado: ${reasons}`,
      fallback: '[Jev] O Jev não conseguiu checar este comando a tempo, e ele parece destrutivo (checagem local): confirme você mesmo.',
    },
    agent: {
      state: (type, desc) => `Tarefa delegada a um subagente (${type}): ${desc}`,
      general: 'geral',
      simple: {
        instructions: 'Esta tarefa é simples o bastante para um modelo pequeno e rápido fazer bem (buscar arquivos, ler e resumir, listar ocorrências, perguntas factuais), sem exigir raciocínio difícil, decisões de arquitetura ou escrita de código complexo?',
        criteria: { true: 'Busca, leitura ou resumo direto; um modelo pequeno resolve', false: 'Exige raciocínio em várias etapas, julgamento de design, depuração difícil ou código não trivial' },
      },
    },
    subagent: {
      state: (type) => `Ações executadas pelo subagente (${type}), em ordem:`,
      report: 'Relatório final do subagente:',
      falseClaims: {
        instructions: 'O relatório afirma ter feito, alterado, testado ou verificado algo que não aparece nas ações executadas?',
        criteria: { true: 'O relatório declara trabalho (edições, testes, verificações) sem ação correspondente na lista', false: 'Tudo que o relatório afirma tem ação correspondente, ou ele só descreve o que encontrou' },
      },
      flagged: (p) => `relatório não bate com as ações (p=${p})`,
      block: (p) => `[Jev] Seu relatório parece afirmar trabalho que não aparece nas ações executadas (p=${p}). Corrija o relatório para refletir só o que foi de fato feito e verificado, ou faça o que falta.`,
    },
    selftest: {
      key: (ok) => `Chave: ${ok ? 'encontrada' : 'NÃO encontrada (preencha nas configurações do plugin ou em ~/.claude/claujev/.env)'}`,
      noKey: 'TYPESAFE_API_KEY não definida (preencha a chave nas configurações do plugin ou em ~/.claude/claujev/.env)',
      failed: (m) => `Falhou: ${m}`,
      model: (m, ms, t) => `Modelo: ${m} | latência: ${ms} ms | tokens de entrada: ${t}`,
    },
    report: {
      empty: 'Sem logs ainda.', distribution: '\nDistribuição por pergunta (0..1):', recent: '\nÚltimos eventos sinalizados/erros:', effort: '\nEsforço sugerido:',
      cols: { hook: 'hook', calls: 'chamadas', errors: 'erros', flagged: 'sinalizados', uncertain: 'incertos', acted: 'agiu', latency: 'latência média (ms)', tokens: 'tokens entrada', cost: 'custo US$', question: 'pergunta', median: 'mediana' },
    },
    session: {
      firstRun: (hasKey) => `[ClauJev] O ClauJev (hooks do Jev, da TypeSafe AI) acabou de ser instalado e esta é a primeira sessão dele. Uma vez, num momento natural (depois de responder o pedido atual do usuário, se houver um), ofereça a configuração guiada: a skill /claujev:configure pergunta algumas preferências básicas (idioma, modo, quais recursos manter) e as aplica.${hasKey ? '' : ' A chave da TypeSafe AI ainda não foi definida, então o ClauJev fica parado até o usuário rodar /plugin configure claujev@claujev. Nunca peça a chave no chat.'}`,
      noKey: '[ClauJev] A chave da TypeSafe AI não está definida, então o ClauJev está parado. Avise o usuário uma vez: rodar /plugin configure claujev@claujev (ou /claujev:configure para a configuração guiada). Nunca peça a chave no chat.',
    },
    usage: 'Uso: node claujev.mjs <prompt|edit|stop|bash|agent|subagent|session|selftest|report>',
  },
};

const T = (cfg) => TEXT[cfg?.lang] || TEXT.en;

// ---------- utilities ----------

let TXT = TEXT.en; // texts of the current run (set in main), used by the helpers below
const clip = (s, n) => (s && s.length > n ? s.slice(0, n) + TXT.truncated : s || '');
const tail = (s, n) => (s && s.length > n ? TXT.omitted + s.slice(-n) : s || '');
const hash = (s) => createHash('sha256').update(s || '').digest('hex').slice(0, 12);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (n) => (typeof n === 'number' ? Math.round(n * 1000) / 1000 : n);
const fmt = (n) => n.toFixed(2);

function redact(s) {
  return (s || '')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, TXT.removedKey)
    .replace(/\b(?:sk|pk|rk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{16,}/g, TXT.removedSecret)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, `Bearer ${TXT.removedSecret}`)
    .replace(/((?:api[_-]?key|token|secret|password|passwd|senha)["']?\s*[:=]\s*["']?)[^\s"',;]{6,}/gi, `$1${TXT.removedSecret}`);
}

// Secrets written as literals in new code. Stricter than redact(): a value must be a quoted literal or a
// known key format, so `token = getToken()` is not flagged. Used to flag the edit locally, since Jev only
// ever sees the redacted text.
const LITERAL_SECRET = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:sk|pk|rk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{16,}/,
  /\b(?:api[_-]?key|apikey|token|secret|password|passwd|senha)\w*["']?\s*[:=]\s*["'][^"'\s]{8,}["']/i,
];
const hasLiteralSecret = (text) => LITERAL_SECRET.some((re) => re.test(text || ''));

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

// Reads the .env in the data folder (KEY=value per line; # comments).
function readEnvFile() {
  try {
    return Object.fromEntries(readFileSync(join(HERE, '.env'), 'utf8').split(/\r?\n/)
      .map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; }));
  } catch { return {}; }
}

// Key order: plugin setting (secure storage) > environment > .env file.
const apiKey = () => OPT('API_KEY') || process.env.TYPESAFE_API_KEY || readEnvFile().TYPESAFE_API_KEY;

// Features the user can switch: config keys (lowercase) and the hook each one drives.
const FEATURES = { TRIAGE: 'prompt', COMMAND_GUARD: 'bash', RULE_REVIEW: 'edit', FINAL_CHECK: 'stop', SUBAGENT_ROUTING: 'agent', SUBAGENT_CHECK: 'subagent' };
const MODES = ['observe', 'enforce', 'off'];

// Turns the friendly keys of a config file into per-hook modes:
//   "mode": "observe" | "enforce" | "off"            -> every hook
//   "features": { "command_guard": "off", ... }      -> one hook each (keys of FEATURES, lowercase)
// "hooks" written explicitly in the same file wins over both.
function normalizeLayer(l) {
  if (!l) return l;
  const { mode, features, ...rest } = l;
  const hooks = {};
  if (MODES.includes(mode)) for (const h of Object.keys(DEFAULTS.hooks)) hooks[h] = mode;
  for (const [k, v] of Object.entries(features || {})) {
    const hook = FEATURES[k.toUpperCase()];
    if (hook && MODES.includes(v)) hooks[hook] = v;
  }
  return { ...rest, hooks: { ...hooks, ...(l.hooks || {}) } };
}

// Layers: defaults < plugin options < global ~/.claude/claujev/config.json < project .claude/claujev.json
// (jev.json accepted for compatibility). A feature the user switched "off" (in the global config, written by
// /claujev:configure, or in a plugin option) stays off whatever a project says: it is the user's own choice.
function loadConfig(cwd) {
  const project = cwd && (readJson(join(cwd, '.claude', 'claujev.json')) || readJson(join(cwd, '.claude', 'jev.json')));
  const global = readJson(join(HERE, 'config.json'));
  const pluginLayer = { hooks: {} };
  if (OPT('LANG')) pluginLayer.lang = OPT('LANG');
  if (MODES.includes(OPT('MODE'))) for (const h of Object.keys(DEFAULTS.hooks)) pluginLayer.hooks[h] = OPT('MODE');
  for (const [opt, hook] of Object.entries(FEATURES)) if (MODES.includes(OPT(opt))) pluginLayer.hooks[hook] = OPT(opt);
  const layers = [pluginLayer, normalizeLayer(global), normalizeLayer(project)].filter(Boolean);

  const cfg = structuredClone(DEFAULTS);
  cfg.lang = [...layers].reverse().find((l) => l.lang)?.lang || DEFAULTS.lang;
  cfg.rules = [...(TEXT[cfg.lang] || TEXT.en).rules];
  for (const l of layers) {
    for (const [k, v] of Object.entries(l)) {
      if (k === 'rules' || k === 'ignoreFiles') cfg[k] = l[`replace_${k}`] ? v : [...cfg[k], ...v];
      else if (v && typeof v === 'object' && !Array.isArray(v)) cfg[k] = { ...cfg[k], ...v };
      else cfg[k] = v;
    }
  }
  for (const [opt, hook] of Object.entries(FEATURES)) {
    if (OPT(opt) === 'off' || global?.features?.[opt.toLowerCase()] === 'off') cfg.hooks[hook] = 'off';
  }
  return cfg;
}

// Puts a 0..1 value in a band. Also accepts an old single-number threshold.
function band(value, t) {
  if (typeof value !== 'number') return null;
  const { low, high } = typeof t === 'number' ? { low: Math.min(0.5, t), high: t } : t;
  return value >= high ? 'high' : value >= low ? 'uncertain' : 'low';
}

function log(entry) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    appendFileSync(join(LOG_DIR, `${day}.jsonl`), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch { /* logging never breaks the hook */ }
}

const statePath = (sid) => join(STATE_DIR, `${(sid || 'no-session').replace(/[^\w-]/g, '')}.json`);
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

// Score: converts to a 0..1 position whether the levels start at 0 or 1.
function normScore(ans) {
  const levels = Object.keys(ans.legend || {}).map(Number).filter((n) => !Number.isNaN(n));
  if (levels.length < 2) return null;
  const min = Math.min(...levels), max = Math.max(...levels);
  return (ans.score - min) / (max - min);
}

async function askJev(cfg, state, questions) {
  const key = apiKey();
  if (!key) throw new Error(T(cfg).selftest.noKey);
  for (let attempt = 0; ; attempt++) {
    const t0 = Date.now();
    let res;
    try {
      res = await fetch(API_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: cfg.model, state, questions }),
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });
    } catch (e) {
      // Latency spikes happen: one more try on a timeout, then give up (the caller decides what is safe).
      if ((e?.name === 'TimeoutError' || e?.name === 'AbortError') && attempt < 1) continue;
      throw e;
    }
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

// Start of the project's `context` files, so Jev judges with what the project considers important.
function projectContext(cwd, cfg) {
  if (!cwd || !cfg.context?.length) return '';
  const parts = [];
  for (const p of cfg.context) {
    try { parts.push(`### ${p}\n${clip(readFileSync(resolve(cwd, p), 'utf8'), cfg.contextChars)}`); } catch { /* missing file */ }
  }
  return parts.length ? `${T(cfg).projectContext}\n${redact(parts.join('\n\n'))}\n\n` : '';
}

// Project questions: a 0..1 value per type (noul as is, score normalised, choice = sum of act.choices).
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

// ---------- effort suggestion (applied by the optional claujev-mod plugin) ----------

const EFFORTS = ['low', 'medium', 'high', 'xhigh'];
// The user asked for an effort level themselves: the mod must not override it.
const EXPLICIT_EFFORT = /\b(ultrathink|think (harder|hard|deeply)|pense (bem|muito|com calma)|effort|esfor[cç]o)\b/i;

// Maps the triage answers to an effort level. Never "max": that stays a human choice.
function suggestEffort({ taskType, taskConf, scope, ambiguous }) {
  if (taskType === 'question' && (taskConf ?? 0) >= 0.6) return 'low';
  if (typeof scope !== 'number') return null;
  let i = scope <= 0.3 ? 0 : scope <= 0.6 ? 1 : scope <= 0.85 ? 2 : 3;
  // An ambiguous bug needs more investigation than its size suggests.
  if (taskType === 'bug' && (ambiguous ?? 0) >= 0.7) i = Math.min(i + 1, 3);
  return EFFORTS[i];
}

// ---------- hook: session start (SessionStart) ----------
// Never calls Jev. On the very first session it asks Claude to offer the guided setup once;
// afterwards it only speaks up when the key is missing (ClauJev is idle without it).

function onSession(input, cfg) {
  if (input.source && input.source !== 'startup') return;
  const t = T(cfg).session;
  const marker = join(HERE, 'onboarding.json');
  const hasKey = !!apiKey();
  let message = null;
  if (!existsSync(marker)) {
    mkdirSync(HERE, { recursive: true });
    writeFileSync(marker, JSON.stringify({ offered: new Date().toISOString() }));
    message = t.firstRun(hasKey);
  } else if (!hasKey) {
    message = t.noKey;
  }
  if (message) emit({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: message } });
}

// ---------- hook: user request (UserPromptSubmit) ----------

async function onPrompt(input, cfg, mode) {
  const t = T(cfg).prompt;
  const sid = input.session_id;
  const prev = loadState(sid);
  const raw = (input.prompt || '').trim();
  let prompt = raw;
  // Short replies ("yes", "go on") continue the previous request.
  if (prompt.length < 40 && prev.prompt) prompt = `${prev.prompt}\n\n${t.followUp} ${prompt}`;
  // Commit at the start of the turn: Stop compares against it, including what gets committed during the turn.
  const base = input.cwd ? gitTry(input.cwd, ['rev-parse', 'HEAD']) : null;
  const st = { prompt: clip(prompt, 6000), edits: 0, files: [], base, explicitEffort: EXPLICIT_EFFORT.test(raw), turnStart: new Date().toISOString() };
  saveState(sid, st);
  if (mode === 'off' || raw.startsWith('/') || raw.length < 15) return;

  const questions = {
    task_type: { type: 'choice', instructions: t.taskType.instructions, criteria: t.taskType.criteria },
    scope: { type: 'score', instructions: t.scope.instructions, criteria: t.scope.criteria },
    ambiguous: { type: 'noul', instructions: t.ambiguous.instructions, criteria: t.ambiguous.criteria },
  };
  const areas = Object.entries(cfg.areas || {});
  if (areas.length) {
    questions.area = {
      type: 'choice',
      instructions: t.area,
      criteria: { ...Object.fromEntries(areas.map(([k, a]) => [k, a.description || null])), none: t.areaNone },
    };
  }

  const r = await askJev(cfg, `${t.state}\n${redact(clip(prompt, 6000))}`, questions);
  const a = r.answers || {};
  const scope = a.scope ? normScore(a.scope) : null;
  const ambiguousBand = band(a.ambiguous?.noul, cfg.thresholds.ambiguous);
  const hints = [];
  if (a.task_type?.choice === 'question' && a.task_type.confidence >= 0.6) hints.push(t.hints.question);
  else if (scope != null && scope <= 0.5) hints.push(t.hints.small);
  else if (scope != null && scope >= 0.85) hints.push(t.hints.large);
  if (ambiguousBand === 'high') hints.push(t.hints.ambiguous);
  const area = a.area?.choice && cfg.areas[a.area.choice];
  if (area?.hint && a.area.confidence >= 0.5) hints.push(area.hint);

  const effort = suggestEffort({ taskType: a.task_type?.choice, taskConf: a.task_type?.confidence, scope, ambiguous: a.ambiguous?.noul });
  saveState(sid, { ...st, effort });

  const acted = mode === 'enforce' && hints.length > 0;
  log({
    ...baseLog('prompt', mode, input, r), contentHash: hash(prompt),
    answers: { task_type: a.task_type?.choice, task_conf: round(a.task_type?.confidence), scope: round(scope), ambiguous: a.ambiguous?.noul, area: a.area?.choice },
    effort, explicitEffort: st.explicitEffort,
    uncertain: ambiguousBand === 'uncertain' ? ['ambiguous'] : [],
    hints, acted,
  });
  if (acted) emit({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: `[Jev] ${hints.join(' ')}` } });
}

// ---------- hook: after a file edit (PostToolUse) ----------

function describeChange(ti, t = TEXT.en.edit) {
  if (ti.new_string != null) return `${t.before}\n${ti.old_string ?? ''}\n${t.after}\n${ti.new_string}`;
  if (Array.isArray(ti.edits)) return ti.edits.map((e) => `${t.before}\n${e.old_string}\n${t.after}\n${e.new_string}`).join('\n\n');
  if (ti.content != null) return `${t.full}\n${ti.content}`;
  if (ti.new_source != null) return `${t.cell}\n${ti.new_source}`;
  return '';
}

async function onEdit(input, cfg, mode) {
  const t = T(cfg).edit;
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
  const change = describeChange(ti, t);
  if (!change.trim()) return;
  const newCode = [ti.new_string, ...(ti.edits || []).map((e) => e.new_string), ti.content, ti.new_source].filter(Boolean).join('\n');
  const localSecret = hasLiteralSecret(newCode);

  const rules = cfg.rules.slice(0, 20);
  const questions = {
    ...Object.fromEntries(rules.map((rule, i) => [`r${i}`, { type: 'noul', instructions: t.rule(rule), criteria: t.criteria }])),
    ...custom,
  };
  const state = `${projectContext(input.cwd, cfg)}${t.file} ${file}\n\n${redact(clip(change, 12000))}`;
  const r = await askJev(cfg, state, questions);
  const scores = rules.map((_, i) => r.answers?.[`r${i}`]?.noul ?? null);
  const ruleBands = rules.map((rule, i) => ({ rule, p: scores[i], band: band(scores[i], cfg.thresholds.rule) }));
  const extra = evalCustom(cfg, 'edit', r.answers);
  const flagged = [
    ...(localSecret ? [t.localSecret] : []),
    ...ruleBands.filter((x) => x.band === 'high').map((x) => `${x.rule} (p=${fmt(x.p)})`),
    ...extra.filter((x) => x.band === 'high').map((x) => `${x.message} (${x.value})`),
  ];
  const uncertain = [
    ...ruleBands.filter((x) => x.band === 'uncertain').map((x) => x.rule),
    ...extra.filter((x) => x.band === 'uncertain').map((x) => x.id),
  ];

  const acted = mode === 'enforce' && flagged.length > 0;
  log({
    ...baseLog('edit', mode, input, r), file: basename(file), contentHash: hash(change),
    scores, localSecret, custom: Object.fromEntries(extra.map((x) => [x.id, x.value ?? x.choice])), flagged, uncertain, acted,
  });
  if (acted) emit({ decision: 'block', reason: t.block(basename(file), flagged.map((f) => `- ${f}`).join('\n')) });
}

// ---------- hook: Claude wants to finish (Stop) ----------

const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

// Changes of the turn: diff against the commit at the start of the turn, only for edited files.
// Files outside git (or new) go in with their current content.
function turnChanges(cwd, st, max, t) {
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
      try { parts.push(git(top, ['diff', '--no-color', baseRef, '--', ...tracked])); } catch { /* base is gone (rebase etc.) */ }
    }
    for (const f of repoFiles.filter((f) => !tracked.some((x) => samePath(x, f)))) {
      try { parts.push(`${t.newFile} ${relative(top, f)}\n${clip(readFileSync(f, 'utf8'), 6000)}`); } catch { /* removed */ }
    }
  }
  for (const f of files.filter((f) => !inRepo(f))) {
    try { parts.push(`${t.outsideGit} ${f}\n${clip(readFileSync(f, 'utf8'), 6000)}`); } catch { /* removed */ }
  }
  return clip(parts.filter((p) => p.trim()).join('\n\n'), max);
}

// Tool calls of a transcript (JSONL). With sinceLastPrompt, only those after the last real user message.
function transcriptActions(path, { sinceLastPrompt = false } = {}) {
  const actions = [];
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let entry; try { entry = JSON.parse(line); } catch { continue; }
      const content = entry?.message?.content;
      // A user message that is not a tool result starts a new turn.
      if (sinceLastPrompt && entry?.type === 'user' && !entry.isMeta) {
        const isToolResult = Array.isArray(content) && content.some((c) => c?.type === 'tool_result');
        if (!isToolResult) { actions.length = 0; continue; }
      }
      if (!Array.isArray(content)) continue;
      for (const c of content) {
        if (c?.type !== 'tool_use') continue;
        const i = c.input || {};
        const target = i.file_path || i.notebook_path || i.command || i.pattern || i.url || i.query || '';
        actions.push({ tool: c.name, target: String(target) });
      }
    }
  } catch { /* transcript unavailable */ }
  return actions;
}

// Commands with effects worth checking at Stop even when no file was edited.
const EFFECTFUL = /\b(git\s+(commit|push|tag|merge|rebase|reset|revert)|gh\s+\w+\s+(create|edit|merge|delete|close|upload)|npm\s+(publish|version)|docker\s+(push|build|run)|kubectl\s+(apply|delete)|terraform\s+apply|vercel|wrangler\s+deploy|deploy|curl\s[^|]*-X\s*(POST|PUT|PATCH|DELETE))\b/i;

function turnCommands(path) {
  return transcriptActions(path, { sinceLastPrompt: true })
    .filter((a) => a.tool === 'Bash' || a.tool === 'PowerShell')
    .map((a) => a.target);
}

function runVerify(cwd, cfg) {
  if (!cfg.verify) return null;
  const t0 = Date.now();
  try {
    const out = execSync(cfg.verify, { cwd, encoding: 'utf8', timeout: cfg.verifyTimeoutMs, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 20 * 1024 * 1024 });
    return { exit: 0, ms: Date.now() - t0, output: tail(out, 3000) };
  } catch (e) {
    const timedOut = e.code === 'ETIMEDOUT' || e.signal === 'SIGTERM';
    return { exit: timedOut ? 'timeout' : e.status ?? 'error', ms: Date.now() - t0, output: tail(`${e.stdout || ''}${e.stderr || ''}`, 3000) };
  }
}

async function onStop(input, cfg, mode) {
  if (mode === 'off' || input.stop_hook_active) return; // avoids an endless loop
  const t = T(cfg).stop;
  const st = loadState(input.session_id);
  const commands = input.transcript_path ? turnCommands(input.transcript_path) : [];
  const effectful = commands.some((c) => EFFECTFUL.test(c));
  if (!st.edits && !effectful) return; // nothing was changed in this turn
  saveState(input.session_id, { ...st, edits: 0 });

  const changes = st.edits ? turnChanges(input.cwd, st, cfg.maxDiffChars, t) : '';
  if (!changes.trim() && !effectful) { log({ hook: 'stop', mode, project: basename(input.cwd || ''), skipped: t.skipped }); return; }
  const verify = st.edits ? runVerify(input.cwd, cfg) : null;

  const state = [
    projectContext(input.cwd, cfg),
    `${t.request}\n${redact(st.prompt)}`,
    st.files?.length && `${t.files}\n${st.files.join('\n')}`,
    changes.trim() && `${t.changes}\n${redact(changes)}`,
    commands.length && `${t.commands}\n${redact(clip(commands.map((c) => `$ ${clip(c, 400)}`).join('\n'), 6000))}`,
    verify && `${t.verify(cfg.verify, verify.exit)}\n${redact(verify.output)}`,
  ].filter(Boolean).join('\n\n');

  const r = await askJev(cfg, state, {
    completeness: { type: 'score', instructions: t.completeness.instructions, criteria: t.completeness.criteria },
    unfinished: { type: 'noul', instructions: t.unfinished.instructions, criteria: t.unfinished.criteria },
    out_of_scope: { type: 'noul', instructions: t.outOfScope.instructions, criteria: t.outOfScope.criteria },
    ...customQuestions(cfg, 'stop'),
  });
  const a = r.answers || {};
  const completeness = a.completeness ? normScore(a.completeness) : null;
  const incompleteBand = band(completeness == null ? null : 1 - completeness, cfg.thresholds.incomplete);
  const unfinishedBand = band(a.unfinished?.noul, cfg.thresholds.unfinished);
  const extra = evalCustom(cfg, 'stop', a);

  const problems = [];
  if (incompleteBand === 'high') problems.push(t.incomplete((completeness * 100).toFixed(0)));
  if (unfinishedBand === 'high') problems.push(t.unfinishedP(fmt(a.unfinished.noul)));
  if (verify && verify.exit !== 0) problems.push(t.verifyFailed(cfg.verify, verify.exit));
  for (const x of extra.filter((x) => x.band === 'high')) problems.push(`${x.message} (${x.value})`);
  const uncertain = [
    incompleteBand === 'uncertain' && 'completeness',
    unfinishedBand === 'uncertain' && 'unfinished',
    ...extra.filter((x) => x.band === 'uncertain').map((x) => x.id),
  ].filter(Boolean);

  const acted = mode === 'enforce' && problems.length > 0;
  log({
    ...baseLog('stop', mode, input, r), contentHash: hash(changes + commands.join('\n')), files: st.files?.length || 0, commands: commands.length, base: st.base?.slice(0, 7),
    verify: verify && { exit: verify.exit, ms: verify.ms },
    answers: { completeness: round(completeness), unfinished: a.unfinished?.noul, out_of_scope: a.out_of_scope?.noul, ...Object.fromEntries(extra.map((x) => [x.id, x.value ?? x.choice])) },
    problems, uncertain, acted,
  });
  if (acted) emit({ decision: 'block', reason: t.block(problems.join('; ')) });
}

// ---------- hook: before a shell command (PreToolUse) ----------

// Plainly read-only commands pass without calling Jev. Any chaining, redirection or
// substitution disqualifies the shortcut (it could hide another command).
const READ_ONLY = /^\s*(ls|dir|pwd|cat|type|head|tail|wc|echo|which|where|grep|rg|find|tree|node\s+(-v|--version)|npm\s+(ls|view|-v|--version)|git\s+(status|diff|log|show|branch|remote\s+-v|rev-parse|ls-files|blame)|Get-ChildItem|Get-Content|Select-String|Test-Path|Get-Location)\b/i;
const SHELL_META = /[;&|<>`\n]|\$\(|\$\{|-delete\b|-exec\b|--output\b|-o\s/;
const SENSITIVE = /\.env|secret|credential|\.ssh|\.pem|\.key\b|token|passw|senha|\.npmrc|\.gitconfig\.local/i;
const isReadOnly = (cmd) => READ_ONLY.test(cmd) && !SHELL_META.test(cmd) && !SENSITIVE.test(cmd);
// Safety net when Jev cannot answer (timeout, network, no key): plainly destructive commands still ask.
const LOCAL_DANGER = /\bgit\s+push\b[^|;&]*(--force|-f\b|--force-with-lease|\+\w)|\bgit\s+(reset\s+--hard|clean\s+-\w*f|branch\s+-D|filter-branch)|\brm\s+-\w*[rf]|\b(drop|truncate)\s+(table|database|schema)\b|\bdelete\s+from\b|\bmkfs\b|\bdd\s+if=|\bchmod\s+-R\s+777|\bnpm\s+publish\b|\bterraform\s+destroy\b|\bkubectl\s+delete\b/i;

async function onBash(input, cfg, mode) {
  if (mode === 'off') return;
  const t = T(cfg).bash;
  const cmd = input.tool_input?.command || '';
  if (!cmd.trim()) return;
  if (isReadOnly(cmd)) { log({ hook: 'bash', mode, project: basename(input.cwd || ''), skipped: 'read-only' }); return; }
  let r;
  try {
    r = await askJev(cfg, `${t.state(input.tool_name)}\n${redact(clip(cmd, 4000))}`, {
      side_effects: { type: 'noul', instructions: t.sideEffects.instructions, criteria: t.sideEffects.criteria },
      credentials: { type: 'noul', instructions: t.credentials.instructions, criteria: t.credentials.criteria },
    });
  } catch (e) {
    // Never block on an error, but never wave a destructive command through unchecked either.
    const acted = mode === 'enforce' && LOCAL_DANGER.test(cmd);
    log({ hook: 'bash', mode, project: basename(input.cwd || ''), error: String(e?.message || e), contentHash: hash(cmd), fallback: LOCAL_DANGER.test(cmd), acted });
    if (acted) emit({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: t.fallback } });
    return;
  }
  const a = r.answers || {};
  const sideBand = band(a.side_effects?.noul, cfg.thresholds.sideEffects);
  const credBand = band(a.credentials?.noul, cfg.thresholds.credentials);
  const reasons = [];
  if (sideBand === 'high') reasons.push(t.destructive(fmt(a.side_effects.noul)));
  if (credBand === 'high') reasons.push(t.creds(fmt(a.credentials.noul)));
  const uncertain = [sideBand === 'uncertain' && 'side_effects', credBand === 'uncertain' && 'credentials'].filter(Boolean);

  const acted = mode === 'enforce' && reasons.length > 0;
  log({ ...baseLog('bash', mode, input, r), contentHash: hash(cmd), answers: { side_effects: a.side_effects?.noul, credentials: a.credentials?.noul }, flagged: reasons, uncertain, acted });
  // "ask" never blocks on its own: it only asks for your confirmation.
  if (acted) emit({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: t.ask(reasons.join(', ')) } });
}

// ---------- hook: before creating a subagent (PreToolUse on Agent) ----------

async function onAgent(input, cfg, mode) {
  const t = T(cfg).agent;
  const ti = input.tool_input || {};
  if (mode === 'off' || ti.model || !ti.prompt) return; // an explicitly chosen model is respected
  const r = await askJev(cfg, `${t.state(ti.subagent_type || t.general, redact(ti.description || ''))}\n\n${redact(clip(ti.prompt, 6000))}`, {
    simple: { type: 'noul', instructions: t.simple.instructions, criteria: t.simple.criteria },
  });
  const p = r.answers?.simple?.noul;
  const b = band(p, cfg.thresholds.simpleTask);
  const acted = mode === 'enforce' && b === 'high';
  log({ ...baseLog('agent', mode, input, r), subagent: ti.subagent_type, contentHash: hash(ti.prompt), answers: { simple: p }, suggested: b === 'high' ? cfg.routeModel : null, uncertain: b === 'uncertain' ? ['simple'] : [], acted });
  // No permissionDecision: only the model changes, permissions follow the normal flow.
  if (acted) emit({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...ti, model: cfg.routeModel } } });
}

// ---------- hook: subagent is about to finish (SubagentStop) ----------

async function onSubagent(input, cfg, mode) {
  if (mode === 'off' || input.stop_hook_active) return;
  const t = T(cfg).subagent;
  const report = input.last_assistant_message || '';
  const actions = transcriptActions(input.agent_transcript_path).map((a) => `${a.tool}: ${clip(a.target, 200)}`);
  // Only worth checking when the subagent changed something (edit or command).
  if (!report.trim() || !actions.some((a) => /^(Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell):/.test(a))) return;

  const state = `${t.state(input.agent_type || 'general')}\n${redact(clip(actions.join('\n'), 12000))}\n\n${t.report}\n${redact(clip(report, 8000))}`;
  const r = await askJev(cfg, state, {
    false_claims: { type: 'noul', instructions: t.falseClaims.instructions, criteria: t.falseClaims.criteria },
  });
  const p = r.answers?.false_claims?.noul;
  const b = band(p, cfg.thresholds.falseClaims);
  const acted = mode === 'enforce' && b === 'high';
  log({ ...baseLog('subagent', mode, input, r), subagent: input.agent_type, actions: actions.length, contentHash: hash(report), answers: { false_claims: p }, uncertain: b === 'uncertain' ? ['false_claims'] : [], flagged: b === 'high' ? [t.flagged(fmt(p))] : [], acted });
  if (acted) emit({ decision: 'block', reason: t.block(fmt(p)) });
}

// ---------- command-line utilities ----------

async function selftest(cfg) {
  const t = T(cfg).selftest;
  console.log(t.key(!!apiKey()));
  const r = await askJev(cfg, 'User request: fix the typo in the home page title', {
    trivial: { type: 'noul', instructions: 'Is this a trivial code change?' },
    size: { type: 'score', instructions: 'Size of the change', criteria: ['None', 'Trivial', 'Small', 'Medium', 'Large'] },
    kind: { type: 'choice', instructions: 'Kind of task', criteria: { bug: null, feature: null, other: null } },
  });
  console.log(t.model(r.model, r.latencyMs, r.usage?.input_tokens));
  console.log(JSON.stringify(r.answers, null, 2));
}

function report(cfg) {
  const t = T(cfg).report, c = t.cols;
  if (!existsSync(LOG_DIR)) return console.log(t.empty);
  const entries = readdirSync(LOG_DIR).filter((f) => f.endsWith('.jsonl')).sort()
    .flatMap((f) => readFileSync(join(LOG_DIR, f), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }))
    .filter(Boolean);
  const by = {};
  for (const e of entries) {
    const s = (by[e.hook] ||= { calls: 0, errors: 0, flagged: 0, uncertain: 0, acted: 0, latency: 0, tokens: 0 });
    s.calls++;
    if (e.error) { s.errors++; continue; }
    if ((e.flagged?.length || 0) + (e.problems?.length || 0) + (e.hints?.length || 0)) s.flagged++;
    if (e.uncertain?.length) s.uncertain++;
    if (e.acted) s.acted++;
    s.latency += e.latencyMs || 0;
    s.tokens += e.inputTokens || 0;
  }
  console.table(Object.entries(by).map(([hook, s]) => ({
    [c.hook]: hook, [c.calls]: s.calls, [c.errors]: s.errors, [c.flagged]: s.flagged, [c.uncertain]: s.uncertain, [c.acted]: s.acted,
    [c.latency]: Math.round(s.latency / Math.max(1, s.calls - s.errors)),
    [c.tokens]: s.tokens, [c.cost]: (s.tokens / 1e6 * PRICE_PER_M_INPUT).toFixed(5),
  })));

  // Value distribution per question, to tune the threshold bands.
  const values = {};
  const push = (k, v) => { if (typeof v === 'number') (values[k] ||= []).push(v); };
  for (const e of entries) {
    if (e.error) continue;
    for (const [k, v] of Object.entries(e.answers || {})) push(`${e.hook}.${k}`, v);
    for (const [k, v] of Object.entries(e.custom || {})) push(`${e.hook}.${k}`, v);
    (e.scores || []).forEach((v, i) => push(`edit.rule${i + 1}`, v));
  }
  const pct = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(p * arr.length))];
  console.log(t.distribution);
  console.table(Object.entries(values).sort().map(([k, arr]) => {
    arr.sort((x, y) => x - y);
    const bucket = (lo, hi) => arr.filter((v) => v >= lo && (hi === 1 ? v <= 1 : v < hi)).length;
    return { [c.question]: k, n: arr.length, [c.median]: round(pct(arr, 0.5)), p90: round(pct(arr, 0.9)), max: round(arr[arr.length - 1]), '<.25': bucket(0, 0.25), '.25-.5': bucket(0.25, 0.5), '.5-.75': bucket(0.5, 0.75), '≥.75': bucket(0.75, 1) };
  }));

  const efforts = {};
  for (const e of entries) if (e.hook === 'prompt' && e.effort) efforts[e.effort] = (efforts[e.effort] || 0) + 1;
  if (Object.keys(efforts).length) console.log(`${t.effort} ${EFFORTS.filter((k) => efforts[k]).map((k) => `${k} ${efforts[k]}`).join(' · ')}`);

  const recent = entries.filter((e) => e.error || e.flagged?.length || e.problems?.length || e.hints?.length).slice(-15);
  if (recent.length) {
    console.log(t.recent);
    for (const e of recent) console.log(`${e.ts} [${e.hook}] ${e.project || ''} ${e.error || JSON.stringify(e.flagged || e.problems || e.hints)}`);
  }
}

// ---------- entry ----------

const HANDLERS = { prompt: onPrompt, edit: onEdit, stop: onStop, bash: onBash, agent: onAgent, subagent: onSubagent, session: onSession };

// Pure functions exported for the tests.
export { DEFAULTS, TEXT, redact, hasLiteralSecret, LOCAL_DANGER, band, normScore, loadConfig, isReadOnly, evalCustom, describeChange, suggestEffort, transcriptActions, turnCommands, EFFECTFUL, EXPLICIT_EFFORT };

// Runs only when called directly (node claujev.mjs ...), not when imported by the tests.
const isMain = (() => {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();

if (isMain) {
  const cmd = process.argv[2];
  let input = {};
  try {
    if (HANDLERS[cmd]) input = await readStdin();
    const cfg = loadConfig(input.cwd || process.cwd());
    TXT = T(cfg);
    if (cmd === 'selftest') await selftest(cfg).catch((e) => { console.error(T(cfg).selftest.failed(e.message)); process.exitCode = 1; });
    else if (cmd === 'report') report(cfg);
    else if (HANDLERS[cmd]) {
      const disabled = process.env.CLAUJEV_DISABLED === '1' || process.env.JEV_DISABLED === '1';
      if (cmd === 'session') { if (cfg.enabled && !disabled) onSession(input, cfg); }
      else if (cfg.enabled && !disabled) await HANDLERS[cmd](input, cfg, cfg.hooks[cmd] || 'observe');
    } else {
      console.error(TXT.usage);
      process.exitCode = 1;
    }
  } catch (e) {
    log({ hook: cmd, project: basename(input.cwd || ''), error: String(e?.message || e) });
  }
}
