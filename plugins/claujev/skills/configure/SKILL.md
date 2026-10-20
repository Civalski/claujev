---
name: configure
description: Guided setup of ClauJev. Asks the user a few basic preferences (language, mode, which features to keep, automatic effort) and applies them to the plugin settings. Use when the user runs /claujev:configure, asks to configure or set up ClauJev or Jev preferences, or accepts the guided setup offered on ClauJev's first session.
---

# ClauJev guided setup

Goal: in one short exchange, learn the user's basic preferences and apply them. Speak the user's
language. Keep it light: one round of questions, then apply, then a two-line summary.

Never ask for, read, print or write the TypeSafe AI key. It is a sensitive setting the user enters
themselves in `/plugin configure claujev@claujev`, where it goes to the system's secure storage.

## 1. Read the current state

Run both, quietly:

- `claude plugin configure claujev@claujev --json` — current values and which are unset
  (`api_key` only shows whether it is set).
- `claude plugin list` — whether `claujev-mod@claujev` is installed.

## 2. Ask the basic preferences in one round

Use the AskUserQuestion tool with these questions (skip one whose answer you already know for sure).
Put the recommended option first and mark it "(Recommended)".

1. **Language** of the messages Claude gets from ClauJev and of the questions sent to Jev:
   English (`en`) or Português (`pt`). Recommend the language the user is writing in.
2. **Mode**: `observe` (Recommended for the first days: Jev only logs, nothing interrupts, then read
   the report) or `enforce` (Jev acts now: hints, confirmations before risky commands, final check).
3. **Features to turn off** (multiSelect; none selected keeps everything): Request triage, Command
   guard, Rule review, Final check, Subagent routing, Subagent report check. Describe each in a few
   words: triage = hint + effort suggestion per request; command guard = asks before destructive or
   credential commands; rule review = checks each edit against rules; final check = checks the work
   before Claude finishes; subagent routing = simple subagents on a smaller model; subagent report
   check = catches subagents claiming work they did not do.
4. **Automatic effort** — only if `claujev-mod` is installed: `observe` (Recommended: show Jev's
   suggestion in the status line), `on` (apply it to each request, between low and xhigh), `off`.
   If the mod is not installed, do not ask; mention at the end that
   `/plugin install claujev-mod --marketplace Civalski/claujev` adds the status line and this feature.

## 3. Apply

Build one JSON object of single-line strings and pipe it to the CLI. Only include what changes;
options left out keep their values. Feature keys: `triage`, `command_guard`, `rule_review`,
`final_check`, `subagent_routing`, `subagent_check`; a feature the user turned off gets `"off"`,
one they keep gets `"mode"` (follows the Mode setting).

```bash
echo '{"lang":"pt","mode":"observe","command_guard":"mode","subagent_routing":"off"}' | claude plugin configure claujev@claujev --values-stdin
```

For the mod (when installed and asked):

```bash
echo '{"effort":"observe","lang":"pt"}' | claude plugin configure claujev-mod@claujev --values-stdin
```

Run `claude plugin configure claujev@claujev` afterwards to confirm the values were saved.

## 4. Key and next steps

- If `api_key` is not set: tell the user ClauJev stays idle until they run
  `/plugin configure claujev@claujev` and paste their key from typesafe.ai there (not in the chat).
- Tell the user to restart Claude Code (open a new session) so the new settings apply; the CLI
  confirms with "Configuration saved. Restart Claude Code to apply it."
- Offer, in one line, the project setup: the `claujev-setup` skill reads the project's
  `CLAUDE.md`/`AGENTS.md` and proposes rules and areas in `.claude/claujev.json`.
- Mention where to change things later: `/config` (one row per feature) or `/claujev:configure`.

If the `claude plugin configure` command is missing (older Claude Code), give the user the values to
pick in `/plugin configure claujev@claujev` instead.
