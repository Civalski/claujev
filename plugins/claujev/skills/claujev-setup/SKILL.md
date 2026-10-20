---
name: claujev-setup
description: Set up, check and tune ClauJev (Jev hooks) for the current project. Use when the user asks to configure ClauJev or Jev, write project rules for Jev, see the ClauJev report, calibrate thresholds, switch hooks between observe and enforce, or check that the Jev key works.
---

# ClauJev setup and tuning

ClauJev runs Jev (TypeSafe AI) on six Claude Code hooks: request triage (`prompt`), command guard
(`bash`), subagent routing (`agent`), rule review of edits (`edit`), false-claim check of subagent
reports (`subagent`) and final check before finishing (`stop`). It also suggests an effort level
per request, which the optional `claujev-mod` plugin can apply.

Paths:
- Script: `${CLAUDE_PLUGIN_ROOT}/hooks/claujev.mjs`
- Data folder (logs, state, optional global `config.json` and `.env`): `~/.claude/claujev/`
- Project config: `<project>/.claude/claujev.json` (overrides the global one; commit it with the project)

Never print or read the API key. It lives in the plugin settings (secure storage), in the
`TYPESAFE_API_KEY` environment variable or in `~/.claude/claujev/.env`.

## 1. Check that it works

Run `node "${CLAUDE_PLUGIN_ROOT}/hooks/claujev.mjs" selftest` and show the result.
- "Key: NOT found": tell the user to open `/plugin`, pick ClauJev and fill in the API key (or put
  `TYPESAFE_API_KEY=...` in `~/.claude/claujev/.env`). Do not ask them to paste the key in the chat.
- HTTP 401/403: the key is wrong or expired. HTTP 429: rate limit, try again later.

## 2. Write the project config

Read the project's `CLAUDE.md`/`AGENTS.md`, README and main config files (package.json,
pyproject.toml, etc.). Then propose `.claude/claujev.json` and show it to the user before writing:

- `rules`: 3 to 8 short, checkable rules taken from what the project already states (conventions,
  forbidden patterns, security rules). One rule per sentence, written as "Do not…" or "Always…".
  Each rule becomes a yes/no question on every edit, so vague rules ("write clean code") only
  create noise. The three built-in rules (no unfinished code, no secrets in code, no swallowed
  errors) are always added unless `"replace_rules": true`.
- `areas`: only if the project has clearly separate parts (backend, frontend, infra…). Each needs a
  `description` Jev can match a request against and a `hint` Claude receives.
- `context`: 1 or 2 files that explain the project (e.g. `CLAUDE.md`). Their start is sent with
  edits and with the final check.
- `verify`: a fast command that exits non-zero on failure (`npm test --silent`, `pytest -q`,
  `cargo check`). It runs at the end of every turn with edits, with a 45 s timeout, so skip slow
  suites.
- `hooks`: leave everything in `observe` for a new project.
- `lang`: `"en"` or `"pt"`, the language of the messages Claude gets and of the questions to Jev.

Example:

```json
{
  "rules": ["Do not query the database inside a loop; fetch everything at once."],
  "areas": { "frontend": { "description": "UI, components, CSS", "hint": "Check the result in the browser before finishing." } },
  "context": ["CLAUDE.md"],
  "verify": "npm test --silent"
}
```

Custom questions go in `questions.stop` or `questions.edit`, with `type` `noul` (yes/no),
`score` (scale in `criteria`) or `choice` (options in `criteria`, and `act.choices` to say which ones
count). Add `act: { "threshold": { "low": 0.5, "high": 0.8 }, "message": "..." }` to make one act;
without `act` it is only logged.

## 3. Read the report and tune

Run `node "${CLAUDE_PLUGIN_ROOT}/hooks/claujev.mjs" report` and explain it in plain words:
- Per hook: calls, errors, how often it flagged, was uncertain or acted, latency and cost.
- Per question: the distribution of values in 0..1. A value at or above `high` acts (in `enforce`),
  between `low` and `high` is "uncertain" (logged only).
- Suggested effort: how many requests got `low`, `medium`, `high` and `xhigh`.

Then suggest changes, one at a time, with the reason:
- A hook that rarely flags, and whose recent flags look right, is ready for `enforce`.
- A question with many values just below `high` and right flags: lower `high` a little.
- A question that flags things that were fine: raise `high`, or rewrite the rule more precisely.
- A rule whose values stay near 0: it may never apply; keep it or drop it.

Write threshold changes in `.claude/claujev.json` under `thresholds` (keys: `ambiguous`, `rule`,
`incomplete`, `unfinished`, `sideEffects`, `credentials`, `simpleTask`, `falseClaims`, each
`{ "low": …, "high": … }`). A new session is needed for hook changes in settings, but config file
changes apply on the next event.

## 4. Effort suggestion

Each request gets an effort suggestion: questions and trivial changes → `low`, small → `medium`,
medium → `high`, large or ambiguous bugs → `xhigh` (never `max`). Without the `claujev-mod` plugin
it is only logged. With it, the mod setting `effort` decides: `observe` shows the suggestion in the
status line, `on` applies it within `minEffort`…`maxEffort`. A request that asks for effort itself
("ultrathink", "think hard") is never overridden.
