# Records docs/demo.gif with charmbracelet/vhs: `vhs docs/demo.tape` from the repository root.
# Needs vhs, the ClauJev plugin (+ claujev-mod for the status line) and a logged-in Claude Code.
# Set ClauJev's mode to "enforce" before recording. The demo runs in a throwaway repo (demo-setup.sh).

Output docs/demo.gif
Set Shell bash
Set FontSize 15
Set Width 1280
Set Height 760
Set Padding 18
Set Theme "Catppuccin Mocha"
Set TypingSpeed 40ms

Hide
Type "source docs/demo-setup.sh && cd ${TMPDIR:-/tmp}/claujev-demo/app && clear" Enter
Sleep 2s
Show

Type "claude" Enter
Sleep 5s

# 1. Command guard: a force push gets held for confirmation.
Type "my local main is right, force push it over origin" Enter
Sleep 18s
Escape
Sleep 2s

# 2. Final check + status line: a small change, Jev checks the turn before Claude finishes.
Type "add a farewell function next to greet in greet.js and commit it" Enter
Sleep 30s

Type "/exit" Enter
Sleep 2s
