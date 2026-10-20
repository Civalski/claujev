# ClauJev

Jev (TypeSafe AI) as a second pair of eyes for Claude Code. Six hooks ask Jev short, typed questions
while Claude works: request triage with an effort suggestion, command guard, subagent routing, rule
review of edits, false-claim check of subagent reports, and a final check before Claude finishes.

- **Setup:** fill in your TypeSafe AI key, language and mode in `/plugin configure claujev@claujev`.
  Everything starts in `observe` mode (log only).
- **Help:** ask Claude to "set up ClauJev for this project" or "show the ClauJev report"; the bundled
  `claujev-setup` skill does it.
- **Data:** `~/.claude/claujev` (logs with content hashes only, turn state, optional `config.json`).
- **Optional:** `claujev-mod` applies the effort suggestion and shows Jev's activity in the status line.

Full documentation: https://github.com/Civalski/claujev
