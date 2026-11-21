#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [[ "${WINDOWS_MCP_IN_CONTAINER:-}" != 1 && "${1:-}" != '--check' ]] && ! command -v claude >/dev/null; then
    exec bash "$script_dir/start-claude-container.sh" "$@"
fi
env_file="$script_dir/.env"
if [[ ! -f "$env_file" ]]; then
    printf 'Missing %s. Copy the Windows .env here first.\n' "$env_file" >&2
    exit 1
fi

# Parse literal values without executing the .env as shell code.
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
if [[ ! "$secret" =~ ^[a-f0-9]{64}$ ]]; then
    printf 'WINDOWS_MCP_SECRET must be 64 hexadecimal characters.\n' >&2
    exit 1
fi
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
command -v claude >/dev/null || { printf 'Claude Code is missing from PATH.\n' >&2; exit 1; }
command -v curl >/dev/null || { printf 'curl is required for the connection check.\n' >&2; exit 1; }
# Keep the credential out of command-line arguments and use stdin for curl configuration.
if ! printf 'header = "Authorization: Bearer %s"\n' "$secret" |
    curl --config - --silent --show-error --fail --max-time 20 --noproxy '*' \
        --header 'Content-Type: application/json' --header 'Accept: application/json, text/event-stream' \
        --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"claude-launch-check","version":"1.0"}}}' \
        --output /dev/null "$WINDOWS_MCP_URL"; then
    printf 'MCP connection failed. Start Windows MCP from Relay Desk or start-win-mcp-svr.cmd and check both .env secrets.\n' >&2
    exit 1
fi
printf 'Windows-MCP is reachable. Starting Claude Code in %s\n' "$PWD"
exec claude --mcp-config "$script_dir/mcp.json" "$@"

