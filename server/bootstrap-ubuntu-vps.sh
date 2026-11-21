#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" != 0 ]]; then
    printf 'Run this script as root.\n' >&2
    exit 1
fi

account="${1:?Missing account name}"
public_key_file="${2:?Missing public key file}"
if [[ ! "$account" =~ ^[a-z_][a-z0-9_-]*$ ]]; then
    printf 'Invalid account name.\n' >&2
    exit 1
fi
if [[ "$account" == root ]]; then
    printf 'Choose a non-root application account.\n' >&2
    exit 1
fi
. /etc/os-release
if [[ "${ID:-}" != ubuntu || "$(uname -m)" != x86_64 ]]; then
    printf 'This bootstrap supports Ubuntu x86_64 only.\n' >&2
    exit 1
fi
case "${VERSION_ID:-}" in
    22.04|24.04|26.04) ;;
    *) printf 'Use a maintained Ubuntu 22.04, 24.04, or 26.04 VPS.\n' >&2; exit 1 ;;
esac
if id "$account" >/dev/null 2>&1 && (( $(id -u "$account") < 1000 )); then
    printf 'Refusing to repurpose an existing system account.\n' >&2
    exit 1
fi
if [[ ! -f "$public_key_file" ]]; then
    printf 'Public key file is missing.\n' >&2
    exit 1
fi
public_key="$(head -n 1 -- "$public_key_file")"
if [[ ! "$public_key" =~ ^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521))[[:space:]][A-Za-z0-9+/=]+([[:space:]].*)?$ ]]; then
    printf 'Invalid public key.\n' >&2
    exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
# Preserve an existing working Docker installation rather than mixing Docker packages.
packages=(ca-certificates curl git tmux python3)
if ! command -v docker >/dev/null 2>&1; then packages+=(docker.io); fi
apt-get install -y --no-install-recommends "${packages[@]}"
systemctl enable --now docker

if ! id "$account" >/dev/null 2>&1; then
    useradd --create-home --shell /bin/bash "$account"
fi
usermod -aG docker "$account"
home_dir="$(getent passwd "$account" | cut -d: -f6)"
group="$(id -gn "$account")"
install -d -m 700 -o "$account" -g "$group" "$home_dir/.ssh"
authorized="$home_dir/.ssh/authorized_keys"
touch "$authorized"
chown "$account:$group" "$authorized"
chmod 600 "$authorized"
if ! grep -Fqx -- "$public_key" "$authorized"; then
    printf '%s\n' "$public_key" >> "$authorized"
fi

printf 'Docker is ready. Account %s has the public key and Docker access.\n' "$account"
