#!/usr/bin/env bash
set -euo pipefail
umask 077

# Run from the private upload directory as the daily application user.
if [[ "$(id -u)" == 0 ]]; then
    printf 'Run provisioning as the non-root application account.\n' >&2
    exit 1
fi
source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
destination="$HOME/windows-mcp"
for dependency in docker python3 tmux curl flock; do
    command -v "$dependency" >/dev/null || { printf 'Missing dependency: %s\n' "$dependency" >&2; exit 1; }
done
docker info >/dev/null
exec 9>"$HOME/.relay-provision.lock"
flock -n 9 || { printf 'Another provisioning operation is running.\n' >&2; exit 1; }
mkdir -p -- "$destination"
chmod 700 -- "$destination"

# Refuse an accidental secret change, including reinstalling from another Windows PC.
python3 - "$source_dir/server.env" "$destination/.env" <<'PY'
import pathlib
import re
import sys

def secret(filename):
    text = pathlib.Path(filename).read_text(encoding='utf-8-sig')
    values = []
    for line in text.splitlines():
        if re.match(r'^\s*WINDOWS_MCP_SECRET\s*=', line):
            values.append(line.split('=', 1)[1].strip().strip('\"\''))
    if len(values) != 1 or not re.fullmatch(r'[a-f0-9]{64}', values[0]):
        raise SystemExit('Missing, duplicate, or invalid MCP secret. No files installed.')
    return values[0]

incoming = secret(sys.argv[1])
if pathlib.Path(sys.argv[2]).exists() and secret(sys.argv[2]) != incoming:
    raise SystemExit('Existing server secret differs. Recover the original local .env before retrying; no files installed.')
PY

# A running container can still use these bind-mounted files. Update only when idle.
if docker ps --filter label=io.relaydesk.session=true --format '{{.ID}}' | grep -q .; then
    printf 'Managed assistant containers are running. End them in Relay Desk before provisioning; histories remain on disk.\n' >&2
    exit 1
fi
for source in "$source_dir"/* "$source_dir"/.dockerignore; do
    [[ -f "$source" ]] || continue
    name="$(basename -- "$source")"
    case "$name" in
        server.env|provision-relay.sh) continue ;;
        *.sh|*.py|*.json|*.conf|Dockerfile|Codex.Dockerfile|.dockerignore) ;;
        *) continue ;;
    esac
    mode=600
    [[ "$name" != *.sh ]] || mode=700
    install -m "$mode" -- "$source" "$destination/$name.setup-new"
    mv -f -- "$destination/$name.setup-new" "$destination/$name"
done
install -m 600 -- "$source_dir/server.env" "$destination/.env.setup-new"
mv -f -- "$destination/.env.setup-new" "$destination/.env"
mkdir -p -- "$HOME/claude-workspace"
bash "$destination/start-claude.sh" --check
if ! docker image inspect windows-mcp-claude:local >/dev/null 2>&1; then
    bash "$destination/install-claude-container.sh"
fi
image_owner="$(docker run --rm --network none --entrypoint sh windows-mcp-claude:local -c 'printf "%s:%s" "$(id -u)" "$(id -g)"')"
if [[ "$image_owner" != "$(id -u):$(id -g)" ]]; then
    printf 'Existing Claude image belongs to another UID/GID. Use its original app user, or deliberately rebuild the image for this account.\n' >&2
    exit 1
fi
bash "$destination/start-claude-container.sh" --version
printf 'Server files and Claude image are ready. Login and a desktop connection still need verification.\n'
