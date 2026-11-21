#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
env_file="$script_dir/.env"
[[ -f "$env_file" ]] || { printf 'Missing %s.\n' "$env_file" >&2; exit 1; }

trim() {
    local value="$1"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    REPLY="$value"
}
declare -A seen=()
secret=''
remote_port=''
line_number=0
while IFS= read -r line || [[ -n "$line" ]]; do
    line_number=$((line_number + 1))
    trim "$line"
    line="$REPLY"
    [[ -z "$line" || "$line" == \#* ]] && continue
    if [[ ! "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=(.*)$ ]]; then
        printf 'Invalid .env syntax at line %s.\n' "$line_number" >&2
        exit 1
    fi
    key="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"
    if [[ -n "${seen[$key]:-}" ]]; then
        printf 'Duplicate .env key: %s\n' "$key" >&2
        exit 1
    fi
    seen[$key]=1
    trim "$value"
    value="$REPLY"
    if [[ "$value" == \"*\" || "$value" == \'*\' ]]; then
        value="${value:1:${#value}-2}"
    fi
    case "$key" in
        WINDOWS_MCP_SECRET) secret="$value" ;;
        REMOTE_MCP_PORT) remote_port="$value" ;;
    esac
done < "$env_file"
[[ "$secret" =~ ^[a-f0-9]{64}$ ]] || {
    printf 'WINDOWS_MCP_SECRET must be 64 hexadecimal characters.\n' >&2
    exit 1
}
if [[ ! "$remote_port" =~ ^[0-9]{4,5}$ ]] || (( 10#$remote_port < 1024 || 10#$remote_port > 65535 )); then
    printf 'REMOTE_MCP_PORT must be between 1024 and 65535.\n' >&2
    exit 1
fi
export WINDOWS_MCP_SECRET="$secret"
export WINDOWS_MCP_URL="http://127.0.0.1:$((10#$remote_port))/mcp"
if [[ "${1:-}" == '--check' ]]; then
    printf 'Configuration OK. Endpoint: %s\n' "$WINDOWS_MCP_URL"
    exit 0
fi

command -v codex >/dev/null || { printf 'Codex CLI is missing from PATH.\n' >&2; exit 1; }
command -v curl >/dev/null || { printf 'curl is required for the connection check.\n' >&2; exit 1; }
if ! printf 'header = "Authorization: Bearer %s"\n' "$secret" |
    curl --config - --silent --show-error --fail --max-time 20 --noproxy '*' \
        --header 'Content-Type: application/json' --header 'Accept: application/json, text/event-stream' \
        --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"codex-launch-check","version":"1.0"}}}' \
        --output /dev/null "$WINDOWS_MCP_URL"; then
    printf 'MCP connection failed. Start Windows MCP and check both .env secrets.\n' >&2
    exit 1
fi

state_root="${CODEX_HOME:-$HOME/.codex}"
if [[ -n "${RELAY_CODEX_SESSION_ID:-}" ]]; then
    session="$RELAY_CODEX_SESSION_ID"
    [[ "$session" =~ ^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$ ]] || exit 2
    auth_file="$state_root/auth.json"
    if [[ ! -s "$auth_file" ]]; then
        printf 'Codex is not signed in. On the server, run: bash %q --login\n' "$script_dir/start-codex-container.sh" >&2
        exit 1
    fi
    session_home="$state_root/ui/$session"
    mkdir -p -- "$session_home"
    chmod 700 -- "$session_home"
    if [[ -f "$session_home/auth.json" && ! -L "$session_home/auth.json" && "$session_home/auth.json" -nt "$auth_file" ]]; then
        cp -- "$session_home/auth.json" "$auth_file"
        chmod 600 -- "$auth_file"
    fi
    ln -sfn -- "$auth_file" "$session_home/auth.json"
    export CODEX_HOME="$session_home"
fi

config_args=(
    --no-daemon
    -c "mcp_servers.windows_mcp.url=\"$WINDOWS_MCP_URL\""
    -c 'mcp_servers.windows_mcp.bearer_token_env_var="WINDOWS_MCP_SECRET"'
    -c 'mcp_servers.windows_mcp.required=true'
    -c 'cli_auth_credentials_store="file"'
    -c 'tui.resume_cwd="current"'
    -c 'sandbox_mode="danger-full-access"'
    -c 'approval_policy="on-request"'
    -c 'check_for_update_on_startup=false'
)
if [[ -n "${RELAY_CODEX_SESSION_ID:-}" && -d "$CODEX_HOME/sessions" ]] &&
    [[ -n "$(find "$CODEX_HOME/sessions" -type f -name 'rollout-*.jsonl' -print -quit)" ]]; then
    exec codex "${config_args[@]}" resume --last "$@"
fi
exec codex "${config_args[@]}" "$@"
