#!/usr/bin/env bash
# Read the documented status-line payload without retaining conversation or account metadata.
set -euo pipefail
export LC_ALL=C
input="$(head -c 131073)"
(( ${#input} <= 131072 )) || exit 0
limits="$(printf '%s' "$input" | awk '
    { document = document $0 "\n" }
    END {
        if (!match(document, /"rate_limits"[[:space:]]*:[[:space:]]*\{/)) exit
        start = RSTART + RLENGTH - 1
        depth = 0; quoted = 0; escaped = 0
        for (position = start; position <= length(document); position++) {
            character = substr(document, position, 1)
            if (quoted) {
                if (escaped) escaped = 0
                else if (character == "\\") escaped = 1
                else if (character == "\"") quoted = 0
            } else {
                if (character == "\"") quoted = 1
                else if (character == "{") depth++
                else if (character == "}") {
                    depth--
                    if (depth == 0) { print substr(document, start, position - start + 1); exit }
                }
            }
        }
    }')"
[[ -n "$limits" ]] && (( ${#limits} <= 16384 )) || exit 0
state_dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
umask 077
temporary="$(mktemp "$state_dir/.relay-usage.XXXXXX")"
trap 'rm -f -- "$temporary"' EXIT
printf '{"rate_limits":%s,"reportedAt":%s}\n' "$limits" "$(date +%s)" > "$temporary"
mv -f -- "$temporary" "$state_dir/relay-usage.json"
