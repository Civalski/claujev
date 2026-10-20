---
name: configure
description: ClauJev preferences menu and guided setup. Asks the user, in their own language, the basic preferences (language, mode, which features to keep, automatic effort, status line) and saves them. Use when the user runs /claujev:configure, asks to configure ClauJev or Jev, change its language or mode, turn a ClauJev feature on or off, or accepts the guided setup offered on ClauJev's first session.
---

# ClauJev preferences

Goal: one short exchange in the user's language, then save, then a two-line summary. This is the
only place where preferences are chosen: the plugin install screen only asks for the API key.

Never ask for, read, print or write the TypeSafe AI key. The user enters it in
`/plugin configure claujev@claujev` (system secure storage) or in `~/.claude/claujev/.env`.

## 1. Read the current state

- Preferences file: `~/.claude/claujev/config.json` (may not exist yet). Read it if it exists.
- `claude plugin list` tells whether `claujev-mod@claujev` is installed.
- `claude plugin configure claujev@claujev` tells whether `api_key` is set (it never shows the value).

## 2. Ask, in one round

Use the AskUserQuestion tool, in the language the user writes in. Put the recommended option first,
marked as recommended. Skip a question whose answer you already know.

1. **Language** of ClauJev's messages and of the questions sent to Jev: Português (`pt`) or English
   (`en`). Recommend the user's language.
2. **Mode**: `observe` (recommended at first: Jev only takes notes, nothing interrupts; check the
   report after a few days) or `enforce` (Jev acts now: hints, confirmation before risky commands,
   check before finishing).
3. **Features to turn off** (multiSelect; selecting none keeps all). Explain each in a few plain words:
   - Request triage (`triage`): a hint per request and the effort suggestion
   - Command guard (`command_guard`): asks before destructive or credential commands
   - Rule review (`rule_review`): checks each code edit against rules
   - Final check (`final_check`): checks the work before Claude says it is done
   - Subagent routing (`subagent_routing`): simple subagents on a smaller, cheaper model
   - Subagent report check (`subagent_check`): catches subagents claiming work they did not do
4. **Automatic effort**, only if `claujev-mod` is installed: `observe` (recommended: show Jev's
   suggestion in the status line), `on` (apply it to each request, between `low` and `xhigh`), `off`.
   If the mod is not installed, do not ask; at the end mention that
   `/plugin install claujev-mod --marketplace Civalski/claujev` adds it.

## 3. Save

Merge the answers into `~/.claude/claujev/config.json`, keeping every other key already there
(rules, areas, thresholds…). Shape:

```json
{
  "lang": "pt",
  "mode": "observe",
  "features": { "command_guard": "off" },
  "mod": { "effort": "observe", "minEffort": "low", "maxEffort": "xhigh", "status": true }
}
```

- `features`: list only the ones turned off, as `"off"`. A feature turned back on is removed from
  `features`. "off" here wins over any project's `.claude/claujev.json`.
- `mod`: only when the mod is installed.

A safe way to merge (replace the JSON in `NEW` with the answers):

```bash
node -e '
const fs=require("fs"),p=require("os").homedir()+"/.claude/claujev/config.json";
const cur=fs.existsSync(p)?JSON.parse(fs.readFileSync(p,"utf8")):{};
const NEW={"lang":"pt","mode":"observe","features":{"command_guard":"off"}};
const out={...cur,...NEW,mod:{...(cur.mod||{}),...(NEW.mod||{})}};
if(!Object.keys(out.mod).length) delete out.mod;
fs.mkdirSync(require("path").dirname(p),{recursive:true});
fs.writeFileSync(p,JSON.stringify(out,null,2)+"\n"); console.log(JSON.stringify(out))'
```

Changes apply on the next request: no restart needed.

## 4. Finish

- If `api_key` is not set: say ClauJev stays idle until they run `/plugin configure claujev@claujev`
  and paste the key from typesafe.ai there, never in the chat.
- One line on what was saved, and that `/claujev:configure` changes it again any time.
- Offer, in one line, the project setup: `/claujev:claujev-setup` reads the project's
  `CLAUDE.md`/`AGENTS.md` and proposes rules and areas in `.claude/claujev.json`.
