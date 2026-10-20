# ClauJev mod

Optional companion of the `claujev` plugin (installed with it as a dependency). It needs a Claude Code
version with mods.

- **Automatic effort:** reads the effort Jev suggested for the current request and, with `effort: on`,
  applies it to each model request of the main loop, within `min_effort` … `max_effort`. It never
  touches subagents or a request that asks for effort itself ("ultrathink"). Default: `observe`, which
  only shows the suggestion.
- **Status line:** `Jev ✓42 ⚑3 · effort high` — checks and actions of the day, and the effort.
- **Toasts** when Jev acts (command held, final check blocked).
- **`/claujev`:** today's calls, actions, cost and effort suggestions.

Settings: `/plugin configure claujev-mod@claujev`. Full documentation: https://github.com/Civalski/claujev
