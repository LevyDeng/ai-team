#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
docker_cmd=(docker)
if ! docker info >/dev/null 2>&1; then docker_cmd=(sudo docker); fi
if ! "${docker_cmd[@]}" image inspect windows-mcp-codex:local >/dev/null 2>&1; then
    printf 'Run bash %q first.\n' "$script_dir/install-codex-container.sh" >&2
    exit 1
fi

state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/windows-mcp/codex"
mkdir -p -- "$state_dir"
chmod 700 -- "$state_dir"
docker_args=(run --rm -i --init --network host
    --user "$(id -u):$(id -g)"
    --mount "type=bind,source=$state_dir,target=/home/codex/state"
    --mount "type=bind,source=$script_dir,target=/opt/windows-mcp,readonly")
if [[ -n "${RELAY_CONTAINER_NAME:-}" ]]; then
    if [[ ! "$RELAY_CONTAINER_NAME" =~ ^relay-codex-[a-f0-9-]{36}$ ]]; then
        printf 'Invalid desktop session name.\n' >&2
        exit 1
    fi
    if [[ ! "${RELAY_CODEX_SESSION_ID:-}" =~ ^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$ ]]; then
        printf 'Invalid Codex session ID.\n' >&2
        exit 1
    fi
    session_memory="${RELAY_MEMORY_MIB:-896}"
    session_memory_swap="${RELAY_MEMORY_SWAP_MIB:-1088}"
    [[ "$session_memory" =~ ^[0-9]+$ && "$session_memory_swap" =~ ^[0-9]+$ ]] || exit 2
    (( session_memory >= 512 && session_memory <= 1200 && session_memory_swap >= session_memory && session_memory_swap <= session_memory + 300 )) || exit 2
    docker_args+=(--name "$RELAY_CONTAINER_NAME" --label io.relaydesk.session=true
        --label "io.relaydesk.model=${RELAY_MODEL:-}" --label "io.relaydesk.effort=${RELAY_EFFORT:-}"
        --label io.relaydesk.provider=codex --memory="${session_memory}m" --memory-swap="${session_memory_swap}m" --pids-limit=256 --log-driver=none
        --env "RELAY_CODEX_SESSION_ID=$RELAY_CODEX_SESSION_ID")
fi
if [[ -n "${RELAY_CONTAINER_NAME:-}" ]]; then docker_args+=(-d -t);
elif [[ -t 0 && -t 1 ]]; then docker_args+=(-t); fi

# Forward only task-local proxy variables into this container.
for relay_proxy_name in HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy NO_PROXY no_proxy; do
    if [[ -v "$relay_proxy_name" ]]; then docker_args+=(--env "$relay_proxy_name"); fi
done
case "${1:-}" in
    --login) shift; container_cmd=(codex -c 'cli_auth_credentials_store="file"' login --device-auth "$@") ;;
    --version) shift; container_cmd=(codex --version "$@") ;;
    *)
        workspace="$PWD"
        if [[ "$workspace" == "$HOME" || "$workspace" == / ]]; then
            workspace="$HOME/codex-workspace"
            mkdir -p -- "$workspace"
            printf 'Using default project directory: %s\n' "$workspace"
        fi
        container_workdir=/workspace
        if [[ -n "${RELAY_CONTAINER_NAME:-}" ]]; then container_workdir="$workspace"; fi
        docker_args+=(--mount "type=bind,source=$workspace,target=$container_workdir" --workdir "$container_workdir")
        container_cmd=(bash /opt/windows-mcp/start-codex.sh "$@")
        ;;
esac
if [[ -n "${RELAY_CONTAINER_NAME:-}" ]]; then
    "${docker_cmd[@]}" "${docker_args[@]}" windows-mcp-codex:local "${container_cmd[@]}" >/dev/null
    exec "${docker_cmd[@]}" attach --sig-proxy=false "$RELAY_CONTAINER_NAME"
fi
exec "${docker_cmd[@]}" "${docker_args[@]}" windows-mcp-codex:local "${container_cmd[@]}"
