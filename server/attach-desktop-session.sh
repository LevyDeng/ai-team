#!/usr/bin/env bash
set -euo pipefail
project="${1:?Missing project or operation}"
session="${2:?Missing session ID}"
provider="${3:-claude}"
model="${4:-}"
effort="${5:-}"
[[ "$session" =~ ^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$ ]] || exit 2
[[ "$provider" == claude || "$provider" == codex ]] || exit 2
[[ -z "$model" || "$model" =~ ^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$ ]] || exit 2
[[ -z "$effort" || "$effort" =~ ^[a-z][a-z0-9_-]{0,31}$ ]] || exit 2
[[ -n "$model" || -z "$effort" ]] || exit 2
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/windows-mcp"
lock_dir="$state_dir/desktop-terminals"
mkdir -p -- "$lock_dir"
chmod 700 -- "$lock_dir"
socket="$lock_dir/tmux.sock"
terminal="relay-$provider-$session"
container="relay-$session"
[[ "$provider" == codex ]] && container="relay-codex-$session"
exec 8>"$lock_dir/$terminal.lock"
flock -w 10 8 || { printf 'This conversation is still connecting.\n' >&2; exit 75; }

fallback_connection() {
    flock -u 8 2>/dev/null || true
    exec 8>&-
    printf 'Persistent terminal unavailable. Restoring the original conversation connection.\n' >&2
    exec bash "$script_dir/start-desktop-session.sh" "$project" "$session" "$provider" "$model" "$effort"
}

if [[ "$project" == --end ]]; then
    docker_cmd=(docker)
    if ! docker info >/dev/null 2>&1; then docker_cmd=(sudo -n docker); fi
    if "${docker_cmd[@]}" inspect "$container" >/dev/null 2>&1; then
        "${docker_cmd[@]}" stop --time 3 "$container"
    fi
    if command -v tmux >/dev/null; then
        tmux -S "$socket" kill-session -t "=$terminal" 2>/dev/null || true
    fi
    exit
fi

case "$project" in
    '~') project="$HOME/claude-workspace" ;;
    '~/'*) project="$HOME/${project:2}" ;;
esac
[[ "$project" == /* && "$project" != / && "$project" != "$HOME" && "$project" != *$'\n'* && "$project" != *$'\r'* ]] || exit 2
command -v tmux >/dev/null || fallback_connection

if tmux -S "$socket" has-session -t "=$terminal" 2>/dev/null; then
    # Option commands resolve pane targets; the session-only '=' syntax is invalid here.
    settings_ready="$(tmux -S "$socket" show-options -qv -t "$terminal" @relay-settings-ready)" || fallback_connection
    if [[ "$settings_ready" != 1 ]]; then
        # Recover panes created before their settings could be recorded, using the live container.
        docker_cmd=(docker)
        if ! docker info >/dev/null 2>&1; then docker_cmd=(sudo -n docker); fi
        managed="$("${docker_cmd[@]}" inspect --format '{{index .Config.Labels "io.relaydesk.session"}}' "$container" 2>/dev/null)" || fallback_connection
        [[ "$managed" == true ]] || fallback_connection
        running_model="$("${docker_cmd[@]}" inspect --format '{{index .Config.Labels "io.relaydesk.model"}}' "$container")" || fallback_connection
        running_effort="$("${docker_cmd[@]}" inspect --format '{{index .Config.Labels "io.relaydesk.effort"}}' "$container")" || fallback_connection
        [[ "$running_model" == '<no value>' ]] && running_model=''
        [[ "$running_effort" == '<no value>' ]] && running_effort=''
        tmux -S "$socket" set-option -t "$terminal" @relay-model "$running_model" || fallback_connection
        tmux -S "$socket" set-option -t "$terminal" @relay-effort "$running_effort" || fallback_connection
        tmux -S "$socket" set-option -t "$terminal" @relay-settings-ready 1 || fallback_connection
    fi
    running_model="$(tmux -S "$socket" show-options -v -t "$terminal" @relay-model)" || fallback_connection
    running_effort="$(tmux -S "$socket" show-options -v -t "$terminal" @relay-effort)" || fallback_connection
    if [[ "$running_model" != "$model" || "$running_effort" != "$effort" ]]; then
        printf 'This conversation is running with different model settings. Apply the settings and reconnect.\n' >&2
        exit 78
    fi
else
    # Create only the pane under the per-conversation lock, never hold it while attached.
    read -r rows cols < <(stty size 2>/dev/null || printf '30 100\n')
    [[ "$cols" =~ ^[0-9]+$ ]] && (( cols >= 20 && cols <= 400 )) || cols=100
    [[ "$rows" =~ ^[0-9]+$ ]] && (( rows >= 5 && rows <= 200 )) || rows=30
    tmux -S "$socket" -f "$script_dir/relay-tmux.conf" new-session -d -s "$terminal" -x "$cols" -y "$rows" \
        bash "$script_dir/start-desktop-session.sh" "$project" "$session" "$provider" "$model" "$effort" 8>&- || fallback_connection
    tmux -S "$socket" set-option -t "$terminal" @relay-model "$model" || fallback_connection
    tmux -S "$socket" set-option -t "$terminal" @relay-effort "$effort" || fallback_connection
    tmux -S "$socket" set-option -t "$terminal" @relay-settings-ready 1 || fallback_connection
fi
flock -u 8
exec 8>&-
# Closing SSH detaches this client; the server keeps the pane and its screen.
if tmux -S "$socket" attach-session -d -t "=$terminal"; then
    exit 0
else
    attach_code=$?
    if ! tmux -S "$socket" has-session -t "=$terminal" 2>/dev/null; then fallback_connection; fi
    exit "$attach_code"
fi
