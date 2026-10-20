# Changelog

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
