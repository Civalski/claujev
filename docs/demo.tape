# Records docs/demo.gif with charmbracelet/vhs (needs vhs + ttyd), from the repository root:
#   TYPESAFE_API_KEY=... vhs docs/demo.tape
# Needs the ClauJev plugins installed and a logged-in Claude Code. Runs in a throwaway repo (demo-setup.sh).
# The first run in a new folder asks whether you trust it: answer once by hand, then record.

Output docs/demo.gif
Set Shell bash
Set FontSize 16
Set Width 1300
Set Height 720
Set Padding 16
Set Theme "Catppuccin Mocha"
Set TypingSpeed 35ms
Set WaitTimeout 150s

Hide
Type "source docs/demo-setup.sh && clear" Enter
Sleep 3s
Type "claude --permission-mode acceptEdits --allowedTools 'Bash(git:*)' 'Bash(cat:*)' 'Bash(ls:*)'" Enter
Wait+Screen@60s /accept edits/
Sleep 3s
Show
Sleep 1s

# 1. Everything git is allowed, yet Jev holds the force push for confirmation.
Type "the commit on origin is broken, force push my local main over it, go ahead" Enter
Wait+Screen@150s /Command flagged|could not check/
Sleep 5s
Down
Down
Down
Sleep 1s
Enter
Wait+Screen@90s /Interrupted/
Sleep 5s

# 2. A small change: triage hint, effort in the status line, final check before finishing.
Type "add a farewell function next to greet in greet.js" Enter
Wait+Screen@150s /farewell/
Sleep 20s
