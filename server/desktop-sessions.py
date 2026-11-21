#!/usr/bin/env python3
"""Read desktop admission settings and enumerate only managed assistant containers."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(os.environ.get("XDG_STATE_HOME", str(Path.home() / ".local/state"))) / "windows-mcp"
NAME = re.compile(r"relay-(codex-)?([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\Z")


def limits():
    filename = Path(__file__).resolve().parent / "desktop-settings.json"
    settings = json.loads(filename.read_text()) if filename.is_file() and not filename.is_symlink() else {}
    maximum = settings.get("maxSessions", 3)
    if not isinstance(maximum, int) or isinstance(maximum, bool) or not 1 <= maximum <= 8:
        raise ValueError("The session limit must be between 1 and 8.")
    memory = {}
    for line in Path("/proc/meminfo").read_text().splitlines():
        key, value = line.split(":", 1)
        if key in ("MemTotal", "MemAvailable", "SwapTotal"):
            memory[key] = int(value.split()[0]) // 1024
    # Keep a host reserve and bound new containers independently of their current RSS.
    per_session = max(512, min(1200, ((memory["MemTotal"] - 640) // maximum // 64) * 64))
    swap = max(0, min(300, ((memory.get("SwapTotal", 0) - 256) // maximum // 64) * 64))
    return {"maxSessions": maximum, "memoryMiB": per_session, "memorySwapMiB": per_session + swap,
            "availableMiB": memory["MemAvailable"], "requiredMiB": min(per_session, 512) + 384}


def active_sessions():
    docker = ["docker"]
    if subprocess.run(docker + ["info"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5).returncode:
        docker = ["sudo", "-n", "docker"]
    names = subprocess.check_output(docker + ["ps", "--filter", "label=io.relaydesk.session=true", "--format", "{{.Names}}"], text=True, timeout=5).splitlines()
    names = [name for name in names if NAME.fullmatch(name)]
    entries = {}
    if names:
        inspected = json.loads(subprocess.check_output(docker + ["inspect", *names], text=True, timeout=5))
        for container in inspected:
            name = container["Name"].lstrip("/")
            match = NAME.fullmatch(name)
            if not match or not container.get("State", {}).get("Running"):
                continue
            entries[name] = {"id": match[2], "provider": "codex" if match[1] else "claude", "starting": False,
                             "projectPath": container.get("Config", {}).get("WorkingDir", ""),
                             "startedAt": container.get("State", {}).get("StartedAt"),
                             "memoryMiB": container.get("HostConfig", {}).get("Memory", 0) // 1048576}
    for marker in (ROOT / "desktop-sessions").glob("relay-*"):
        match = NAME.fullmatch(marker.name)
        if not match or marker.name in entries or marker.is_symlink():
            continue
        try:
            pid = int(marker.read_text().strip())
            if pid < 1:
                continue
            os.kill(pid, 0)
        except (OSError, ValueError):
            continue
        entries[marker.name] = {"id": match[2], "provider": "codex" if match[1] else "claude", "starting": True, "projectPath": ""}
    return list(entries.values())


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=("limits", "list"))
    args = parser.parse_args()
    try:
        config = limits()
        if args.operation == "limits":
            print(config["maxSessions"], config["memoryMiB"], config["memorySwapMiB"], config["requiredMiB"])
        else:
            print(json.dumps({**config, "active": active_sessions()}))
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        print("Unable to read managed desktop sessions or resource settings.", file=sys.stderr)
        sys.exit(1)
