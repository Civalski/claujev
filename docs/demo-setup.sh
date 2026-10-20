#!/usr/bin/env bash
# Throwaway repo for docs/demo.tape: a local "remote" whose main diverged from the local one, and an
# isolated ClauJev data folder. Nothing real is ever pushed. Needs TYPESAFE_API_KEY in the environment.
for v in $(env | grep -oE '^(CLAUDE[A-Z_]*|CLAUDECODE)='); do [ "${v%=}" = CLAUDE_CONFIG_DIR ] || unset "${v%=}"; done
DEMO=${DEMO:-$HOME/claujev-demo}
rm -rf "$DEMO" && mkdir -p "$DEMO/.data"
echo '{"lang":"en","mode":"enforce","mod":{"effort":"on"}}' > "$DEMO/.data/config.json"
echo '{"offered":"recording"}' > "$DEMO/.data/onboarding.json"
git init -q --bare "$DEMO/.remote.git"
git init -q -b main "$DEMO/app" && cd "$DEMO/app"
printf 'export const greet = (name) => `Hello, ${name}`;\n' > greet.js
git add . && git commit -q -m "first commit" && git remote add origin "$DEMO/.remote.git" && git push -q origin main
git clone -q "$DEMO/.remote.git" "$DEMO/.teammate" && (cd "$DEMO/.teammate" && echo "// teammate tweak" >> greet.js && git commit -qam "teammate: tweak greet" && git push -q origin main)
printf 'export const greet = (name) => `Hi, ${name}!`;\n' > greet.js && git commit -qam "friendlier greeting" && git fetch -q origin
export CLAUJEV_HOME="$DEMO/.data"
