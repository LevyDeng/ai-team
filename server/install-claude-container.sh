#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
docker_cmd=(docker)
if ! docker info >/dev/null 2>&1; then
    docker_cmd=(sudo docker)
fi
"${docker_cmd[@]}" build --pull \
    --build-arg "USER_UID=$(id -u)" --build-arg "USER_GID=$(id -g)" \
    --tag windows-mcp-claude:local "$script_dir"
"${docker_cmd[@]}" run --rm windows-mcp-claude:local claude --version
printf 'Installed. Sign in with: bash %q --login\n' "$script_dir/start-claude-container.sh"

