# ClauJev mod

Install the core first, so Claude Code asks for your TypeSafe AI key:
`/plugin install claujev --marketplace Civalski/claujev`, then
`/plugin install claujev-mod --marketplace Civalski/claujev`.

Optional companion of the `claujev` plugin (installed with it as a dependency). It needs a Claude Code
version with mods.

- **Effort suggestion:** reads the effort Jev suggested for the current request, kept within
  `minEffort` … `maxEffort`. `effort: ask` (default) asks in Claude Code's question dialog when it differs
  from the effort in use, offering Jev's suggestion, the current effort and always low, medium and high;
  it applies the choice to the request's model calls (Esc keeps the current one); `observe` only shows it;
  `on` applies it without asking; `off` does nothing. It never touches subagents or a request that asks
  for effort itself ("ultrathink"). Each answer (accepted, kept, another level, dismissed) is recorded in `~/.claude/claujev/logs/effort-<day>-<session>.jsonl`, so `report` shows how
  often the suggestion is taken.
- **Status line:** `Jev ✓42 ⚑3 · effort high` — checks and actions of the day, and the effort.
- **Toasts** when Jev acts (command held, final check blocked).
- **Badge under each reviewed call:** `Jev ✓ reviewed` under a Bash or edit Jev let through, `Jev ⚠ flagged: …`
  under one it acted on (a card on mobile). Works in the terminal, the VS Code extension, the desktop app and mobile.
- **`/claujev-painel`:** a pane with Jev's activity in this session (requests, commands, edits, final checks).
- **`/claujev`:** today's calls, actions, cost and effort suggestions.

Settings: `/claujev:configure` (saved in `~/.claude/claujev/config.json` under `mod`). Full documentation: https://github.com/Civalski/claujev
