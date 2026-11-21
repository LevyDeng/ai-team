#!/usr/bin/env bash
# Emit only task phase metadata; never retain prompt text or tool arguments.
set -euo pipefail
export LC_ALL=C
phase="${1:-unknown}"
case "$phase" in running|waiting|completed|failed|stopped) ;; *) exit 0 ;; esac
input="$(head -c 131072)"
session="$(printf '%s' "$input" | awk '
    { document = document $0 }
    END {
        if (match(document, /"agent_id"[[:space:]]*:[[:space:]]*"[^"]+"/)) exit
        if (match(document, /"session_id"[[:space:]]*:[[:space:]]*"[a-f0-9-]+"/)) {
            value = substr(document, RSTART, RLENGTH)
            sub(/^.*:[[:space:]]*"/, "", value); sub(/"$/, "", value)
            print value
        }
    }')"
[[ "$session" =~ ^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$ ]] || exit 0
directory="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/relay-task-state"
umask 077
mkdir -p -- "$directory"
temporary="$(mktemp "$directory/.state.XXXXXX")"
trap 'rm -f -- "$temporary"' EXIT
printf '{"state":"%s","updatedAt":%s}\n' "$phase" "$(date +%s%3N)" > "$temporary"
mv -f -- "$temporary" "$directory/$session.json"
