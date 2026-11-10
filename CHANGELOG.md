# Changelog

## 2.9.0 — 2026-11-10

### Changed
- **The command guard only asks before critical changes in production.** In the week after 2.8.0 it
  asked 111 times, and nearly all were routine work already approved: pushing a feature branch, merging
  a PR, deleting a merged branch, running the deploy workflow, applying a schema migration, a commit or a
  build. Claude Code's own permissions already cover those. The fixed rule now covers only force push to
  `main`/`master`, `npm publish`, `terraform destroy`, `kubectl delete`, `gh repo delete`, `aws s3 rb`,
  `aws rds delete-db-instance/cluster`, `supabase db reset --linked` and `DROP`/`TRUNCATE`. Jev is asked
  whether the command is a critical, hard-to-undo change in production. Replayed on the 52 commands Jev
  flagged that week, 1 would still ask; 8 of 8 critical test cases ask.
- **The credentials question only flags leaks**: a secret committed, posted or sent to a third party, or
  printed in full. Copying an `.env` between local folders or reading a token for a local test no longer
  asks (threshold 0.65 → 0.80).
- The safety net used when Jev cannot answer follows the same line (`rm -rf build`, `reset --hard` and
  `branch -D` no longer ask; `DELETE FROM`, force push and `rm -rf ~` still do).
- **The final check warns instead of blocking.** It blocked 6 times that week and Claude changed something
  after only 1. Jev's judgement now shows as a message to you; only a failed `verify` command still blocks.
  `stopBlocks: true` brings the old behaviour back.
- **Rule review sees the user's request.** A project rule like "no deploy or authentication in this phase"
  fired 4 times while the user was asking for exactly that. When the request explicitly asks for what a
  rule forbids, it is no longer flagged (p 0.92 → 0.07 in the replay; an unrelated request still flags, 0.89).

## 2.8.0 (mod 2.3.0) — 2026-11-04

### Changed
- **Publishing, merging and history rewrites ask locally, without calling Jev.** `git push`, `gh pr merge`,
  `git branch -D`, `reset --hard`, `clean -f`, `npm publish`, `terraform apply/destroy`, `kubectl delete`
  and `DROP/TRUNCATE` always ask for confirmation by a fixed rule: the same outcome Jev gave them
  (p 0.87–0.96 in real use), at no cost or latency, and also without a key. Jev is kept for what a rule
  cannot tell. `rm -rf` still goes to Jev, since it is common and harmless in temporary folders.
- **Size hints in triage are off by default** (`sizeHints: false`). They showed up on 20 of 22 requests
  and the model tells a question from a change by itself. The "ambiguous" and area hints stay.

### Added
- **Did the final check help?** After a block, the next Stop records whether Claude changed something
  (the block helped) or only explained (likely a false alarm). `report` shows the count.
- **Effort answers are measured.** The mod records each answer to the effort question (accepted, kept
  the current one, dismissed) in `logs/effort-<day>-<session>.jsonl`, and `report` shows the totals.

## 2.7.0 — 2026-11-04

### Fixed
- **Edits made through the shell are checked again.** Claude Code's auto mode lets the model edit files
  with `sed`, `python` or heredocs in Bash, which never reach the edit hook: in the first two days of 2.6.1
  there were 117 Bash calls and 1 Edit, so the rule review ran 0 times and the final check 2 times in 22
  turns. Now each session asks Claude to edit through Edit/Write, and when a shell command still writes
  files, the final check reads what changed from git (the turn's diff and new files, also in a repo the
  command `cd`-ed into).
- **No "the change looks small" hint on chat replies.** Size hints now go only to bug, feature, refactor
  and config requests, not to an answer like "yes, it works on the laptop keyboard".
- **The usage-limit resume message is no longer triaged as a new request**: it keeps the effort of the
  request it resumes.

### Changed
- **Effort also weighs how much investigation the request needs.** A new triage question (`depth`) sits
  next to the size of the code change, and the larger one wins. Reviewing logs or flaky tests no longer
  gets `low` just because no code changes, and a question stops at `high`. On 40 real requests, the
  suggestion matched the expected effort in 35 against 25 before.
- Final-check turns skipped because nothing changed are now logged, so `report` shows them.

## 2.6.1 — 2026-11-02

### Fixed
- **Loading an `.env` to run a local script is no longer half-flagged as destructive.** The command guard
  now judges by what the command shows: loading variables and running a script whose name does not say
  it deletes, deploys, migrates, seeds or writes remotely is not destructive by itself. On 15 replayed
  commands, `set -a; . .env; node scripts/sync.mjs` went from 0.68 to 0.46 and other safe ones to
  0.05–0.22, while every destructive one scored the same or higher (migration script 0.89 → 0.92,
  deploy 0.93 → 0.95, `git push` 0.87 → 0.90).

## 2.6.0 (mod 2.2.0) — 2026-11-02

### Changed
- **Opinionated defaults: ClauJev acts out of the box.** Every feature now defaults to `enforce`
  (triage hints, command guard, rule review, final check, subagent report check), except subagent
  routing, which stays in `observe` since moving a subagent to a smaller model unasked can cost
  quality. Users who chose a mode in `/claujev:configure` keep it; the guided setup now offers
  `default` (recommended), `observe` or `enforce`.
- **The mod asks before changing the effort.** New default `effort: ask`: when Jev's suggestion
  differs from the effort in use, Claude Code's question dialog asks *"Jev thinks this request is
  simple. Use low effort instead of high?"*, and the request runs with the effort chosen; Esc keeps the
  current one, as does a session with nobody to ask (`claude -p`). `observe`, `on` and `off` stay.
- Docs no longer imply the effort changes by itself: "automatic effort" is now "effort suggestion".

## 2.5.0 — 2026-11-02

Tuned against 18 days of real use (7,643 logged events, each matched back to the command or request it
judged, then the old and new questions replayed on the same cases).

### Added
- **Website** at <https://civalski.github.io/claujev/> (English and Portuguese), with an interactive
  demo of real Jev answers, the terminal recording and [patch notes](https://civalski.github.io/claujev/patch-notes.html).
  Served by GitHub Pages from `docs/`; nothing in it ships with the plugin.

### Changed
- **Final check sees Claude's final reply.** Jev now reads what Claude tells the user it did (up to
  3,000 characters, secrets removed), the previous request as context, and the turn's commands with
  the ones that have effects in more detail and the end of the turn kept. On 40 past turns that had
  been flagged, the "may not be complete" alert went from 24 to 4; on 40 clean turns, from 10 to 0.
  The ones still flagged were turns that really stopped midway.
- **Credentials: exposure, not use.** The question now asks whether a command *shows, copies or sends*
  a credential. Loading an `.env` so a local script can run no longer counts. On 100 past commands
  flagged before, 6 still are; `cat .env`, `echo $KEY`, `gh auth token` and sending a key out still
  score 0.81–0.99.
- **Destructive commands:** local `git add`/`commit` and temporary files are described as easy to undo;
  push, merge, deploys and migrations as not.
- **Thresholds:** `incomplete` 0.30 / 0.50 (was 0.25 / 0.40), `credentials` 0.45 / 0.65 (was 0.50 / 0.70).

### Fixed
- **Read-only shortcut works on real commands.** 65% of commands start with `cd … &&`, which used to
  send every one of them to Jev. Each part of a chain is now checked, so `cd repo && git status | head`
  skips Jev (about 12% fewer calls, no alert lost). Redirection, substitution, `sed -i`, background `&`
  and sensitive files (now including `credenciais`) still go to Jev.
- **Read-only shortcut no longer waves through commands that only look like reads.** `git branch -D`,
  `find -execdir`/`-ok`/`-fprint`, `rg --pre`, `uniq a b`, sed scripts other than `sed -n '10,20p'`,
  `PATH=…` before a command, `echo $API_KEY`, `jq -n env` and files such as `.netrc`, `.pgpass` or
  `gh`'s `hosts.yml` now go to Jev.
- **Triage ignores system messages.** `<task-notification>` and other messages Claude Code injects are
  no longer triaged as requests, and they no longer replace the request the final check compares against.
- **Conversation replies are less "ambiguous".** Triage now gets the previous request as context.

## 2.4.3 — 2026-10-20

### Fixed
- **Fewer skipped checks on slow answers.** Jev calls now wait up to 5 s (was 3 s) and a timed-out
  call is retried once, still well inside Claude Code's 15 s hook budget. Two checks were skipped by
  timeouts during today's recordings.

## 2.4.2 — 2026-10-20

### Fixed
- **Command guard safety net.** When Jev cannot answer in time (a 3 s timeout during a recording let a
  `git push --force-with-lease` through unchecked), plainly destructive commands (`push --force`,
  `reset --hard`, `rm -rf`, `DROP TABLE`, `npm publish`…) now still ask for confirmation, from a local
  check. Ordinary commands keep passing, so the session never blocks on an error.

## 2.4.1 — 2026-10-20

### Fixed
- **Secrets written in code are now caught for sure.** Jev only sees code after secrets are redacted,
  so the "no secrets in code" rule scored ~0.65 (uncertain) on a hardcoded API key. Rule review now
  also detects literal secrets in the new code on the user's machine (quoted values for
  `api_key`/`token`/`password`…, `sk-…`, `ghp_…`, private keys) and flags them directly; the secret
  still never leaves the machine. Code that only handles secrets (`process.env.API_KEY`,
  `token = getToken()`) is not flagged.

## 2.4.0 — 2026-10-20

### Changed
- **The install screen only asks for the API key.** Claude Code shows plugin settings exactly as
  written and cannot translate them, so language, mode, features on/off and the mod's automatic
  effort moved to `/claujev:configure`, which asks in the user's own language.
- Preferences live in `~/.claude/claujev/config.json`: `lang`, `mode`, `features` (e.g.
  `{"command_guard": "off"}`) and `mod` (`effort`, `minEffort`, `maxEffort`, `status`). They apply on
  the next request, with no restart. "off" there beats any project config.
- The mod has no settings screen any more; it reads the same file. The `/config` rows are gone.

## 2.3.1 — 2026-10-20

### Fixed
- Settings screen: short texts in English and Portuguese (English first), so both fit on screen.
  Claude Code shows these texts as written; they cannot switch language with the Language option.
- Install order documented: install `claujev` before `claujev-mod`. Installing the mod first pulls
  ClauJev in as a dependency without showing its settings, so the API key is not asked.
- Shorter install section; the guided setup replaces the long copy-paste prompt.

## 2.3.0 — 2026-10-20

### Changed
- **License: MIT** (was MIT-0). Still free to use, modify and redistribute, but copies must keep the
  copyright notice crediting the author, Alisson Civalski.
- **Settings screen in Portuguese and English**: every option title and description shows both
  languages in plain words, since Claude Code shows them as written in the manifest.

## 2.2.0 — 2026-10-20

### Added
- **Guided setup** (`/claujev:configure`): Claude asks a few multiple-choice questions (language, mode,
  features to turn off, automatic effort) and applies them with `claude plugin configure --values-stdin`.
  The API key is never asked in the chat.
- **First-run offer**: a light `SessionStart` hook (it never calls Jev) asks Claude to offer the guided
  setup once on ClauJev's first session, and reminds about a missing API key on later sessions.

## 2.1.0 — 2026-10-20

### Added
- **Feature menu**: one setting per feature in `/config` and `/plugin configure` (Request triage,
  Command guard, Rule review, Final check, Subagent routing, Subagent report check), each `mode`,
  `observe`, `enforce` or `off`. `off` there wins over any config file.
- One-step install: `/plugin install claujev --marketplace Civalski/claujev`.

## 2.0.0 — 2026-10-20

**ClauJev is now a Claude Code plugin.** Install with
`/plugin marketplace add Civalski/claujev` and `/plugin install claujev@claujev`.

### Added
- **Plugin `claujev`**: the six hooks, with the API key stored in the system's secure storage and
  the language and mode chosen in `/plugin`.
- **Automatic effort**: triage now suggests an effort level per request (`low` … `xhigh`, never
  `max`). Logged by the core, applied by the mod.
- **Mod `claujev-mod`** (optional): applies the effort suggestion (`effort: on`), shows Jev's activity
  and the suggested effort in the status line, toasts when Jev acts, and adds `/claujev`.
- **Skill `claujev-setup`**: Claude can run the self-test, write `.claude/claujev.json` from your
  `CLAUDE.md`, and read the report to tune thresholds.
- **English and Portuguese** (`lang`): messages to Claude and questions to Jev. English is the default.
- The final check now **reads the commands Claude ran** in the turn (commits, pushes, releases,
  deploys) and also runs on turns with no file edits but with such commands. This removes false
  "incomplete" alarms on work done through the terminal.

### Changed
- Data folder is now `~/.claude/claujev` (config, `.env`, logs, state) for both the plugin and the
  manual install.
- Project config file is `.claude/claujev.json` (`.claude/jev.json` is still read).
- Bands are logged as `low` / `uncertain` / `high`; `task_type` choices are `question`, `bug`,
  `feature`, `refactor`, `config`, `other` in every language.
- `install.mjs` refuses to install when the plugin is installed, so hooks never run twice.

## 1.0.0 — 2026-10-20

First public release: six Claude Code hooks backed by Jev, manual installer, report and tests.
