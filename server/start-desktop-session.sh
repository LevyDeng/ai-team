#!/usr/bin/env bash
set -euo pipefail
project="${1:?Missing project directory}"
session="${2:?Missing session ID}"
provider="${3:-claude}"
model="${4:-}"
effort="${5:-}"
[[ "$session" =~ ^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$ ]] || exit 2
[[ "$provider" == claude || "$provider" == codex ]] || exit 2
[[ -z "$model" || "$model" =~ ^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$ ]] || exit 2
[[ -z "$effort" || "$effort" =~ ^[a-z][a-z0-9_-]{0,31}$ ]] || exit 2
[[ -n "$model" || -z "$effort" ]] || exit 2
case "$project" in
    '~') project="$HOME/claude-workspace" ;;
    '~/'*) project="$HOME/${project:2}" ;;
esac
[[ "$project" == /* && "$project" != / && "$project" != "$HOME" ]] || {
    printf 'Choose a project directory below your home folder.\n' >&2
    exit 2
}
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
docker_cmd=(docker)
if ! docker info >/dev/null 2>&1; then docker_cmd=(sudo -n docker); fi
container="relay-$session"
if [[ "$provider" == codex ]]; then container="relay-codex-$session"; fi
attach_session() {
    [[ "$("${docker_cmd[@]}" inspect --format '{{index .Config.Labels "io.relaydesk.session"}}' "$container")" == true ]] || exit 2
    running_model="$("${docker_cmd[@]}" inspect --format '{{index .Config.Labels "io.relaydesk.model"}}' "$container")"
    running_effort="$("${docker_cmd[@]}" inspect --format '{{index .Config.Labels "io.relaydesk.effort"}}' "$container")"
    [[ "$running_model" == '<no value>' ]] && running_model=''
    [[ "$running_effort" == '<no value>' ]] && running_effort=''
    if [[ "$running_model" != "$model" || "$running_effort" != "$effort" ]]; then
        printf 'This conversation is running with different model settings. Apply the settings and reconnect.\n' >&2
        exit 78
    fi
    exec "${docker_cmd[@]}" attach --sig-proxy=false "$container"
}
if [[ "$("${docker_cmd[@]}" inspect --format '{{.State.Running}}' "$container" 2>/dev/null || true)" == true ]]; then
    attach_session
fi
lock_dir="${XDG_STATE_HOME:-$HOME/.local/state}/windows-mcp"
reservation_dir="$lock_dir/desktop-sessions"
mkdir -p -- "$reservation_dir"
chmod 700 -- "$reservation_dir"
exec 9>"$lock_dir/desktop-startup-v2.lock"
if ! flock -w 10 9; then
    printf 'The server is busy starting another session. Try again shortly.\n' >&2
    exit 75
fi

# Remove reservations left behind by interrupted SSH connections.
for marker in "$reservation_dir"/relay-*; do
    [[ -f "$marker" ]] || continue
    marker_pid=''
    read -r marker_pid < "$marker" || true
    if [[ ! "$marker_pid" =~ ^[0-9]+$ ]] || ! kill -0 "$marker_pid" 2>/dev/null; then
        rm -f -- "$marker"
    fi
done

if [[ "$("${docker_cmd[@]}" inspect --format '{{.State.Running}}' "$container" 2>/dev/null || true)" == true ]]; then
    flock -u 9
    exec 9>&-
    attach_session
fi
reservation="$reservation_dir/$container"
if [[ -e "$reservation" ]]; then
    printf 'This conversation is still starting. Try reconnecting shortly.\n' >&2
    exit 75
fi
running_names="$("${docker_cmd[@]}" ps --filter label=io.relaydesk.session=true --format '{{.Names}}')"
reserved_names="$(find "$reservation_dir" -maxdepth 1 -type f -name 'relay-*' -printf '%f\n')"
active_count="$(printf '%s\n%s\n' "$running_names" "$reserved_names" | sed '/^$/d' | sort -u | wc -l)"
read -r max_sessions session_memory session_memory_swap required_memory < <(python3 "$script_dir/desktop-sessions.py" limits)
if (( active_count >= max_sessions )); then
    printf 'RELAY_CAPACITY_LIMIT\nThis VPS allows %s simultaneous desktop conversations. End one before opening another.\n' "$max_sessions" >&2
    exit 75
fi
available_kib="$(awk '/^MemAvailable:/ { print $2; exit }' /proc/meminfo)"
if [[ "$available_kib" =~ ^[0-9]+$ ]] && (( available_kib < required_memory * 1024 )); then
    printf 'RELAY_CAPACITY_MEMORY\nThe VPS has too little available memory for another desktop conversation.\n' >&2
    exit 75
fi
printf '%s\n' "$$" > "$reservation"
flock -u 9
exec 9>&-
trap 'rm -f -- "$reservation"' EXIT
mkdir -p -- "$project"
cd -- "$project"
export RELAY_CONTAINER_NAME="$container"
export RELAY_MODEL="$model"
export RELAY_EFFORT="$effort"
export RELAY_MEMORY_MIB="$session_memory"
export RELAY_MEMORY_SWAP_MIB="$session_memory_swap"
model_args=()
if [[ -n "$model" ]]; then model_args+=(--model "$model"); fi
if [[ "$provider" == codex ]]; then
    export RELAY_CODEX_SESSION_ID="$session"
    if [[ -n "$effort" ]]; then model_args+=(-c "model_reasoning_effort=\"$effort\""); fi
    bash "$script_dir/start-codex-container.sh" "${model_args[@]}"
    exit
fi
if [[ -n "$effort" ]]; then model_args+=(--effort "$effort"); fi
state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/windows-mcp/claude"
session_file=''
if [[ -d "$state_dir/projects" ]]; then
    session_file="$(find "$state_dir/projects" -name "$session.jsonl" -type f -print -quit)"
fi
if [[ -n "$session_file" ]]; then
    bash "$script_dir/start-claude-container.sh" --resume "$session" "${model_args[@]}"
    exit
fi
bash "$script_dir/start-claude-container.sh" --session-id "$session" "${model_args[@]}"
