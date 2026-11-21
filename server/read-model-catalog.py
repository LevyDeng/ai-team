#!/usr/bin/env python3
"""Discover CLI model metadata without submitting an inference request."""

import argparse
import json
import os
from pathlib import Path
import re
import selectors
import subprocess
import sys
import time
import uuid
from urllib.parse import urlsplit


def proxy_environment(source, policy):
    env = dict(source)
    mode = policy.get('mode', 'system')
    if mode not in ('system', 'direct', 'custom'):
        raise ValueError('Invalid proxy mode.')
    if mode == 'system':
        return env
    names = ('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy')
    for name in names + ('NO_PROXY', 'no_proxy'):
        env.pop(name, None)
    env['NO_PROXY'] = env['no_proxy'] = '*' if mode == 'direct' else 'localhost,127.0.0.1,::1'
    if mode == 'custom':
        url = policy.get('url', '')
        parsed = urlsplit(url)
        if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ('', '/'):
            raise ValueError('Invalid HTTP proxy URL.')
        for name in names:
            env[name] = url
    return env


MODEL_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/@+\-]{0,199}\Z")
EFFORT = re.compile(r"[a-z][a-z0-9_\-]{0,31}\Z")


def normalize(provider, entries):
    result = []
    seen = set()
    for entry in entries:
        identifier = entry.get("value") if provider == "claude" else entry.get("model")
        if not isinstance(identifier, str) or not MODEL_ID.fullmatch(identifier):
            continue
        if identifier in seen or entry.get("hidden"):
            continue
        seen.add(identifier)
        levels = entry.get("supportedEffortLevels" if provider == "claude" else "supportedReasoningEfforts")
        effort_fields = {}
        if isinstance(levels, list):
            levels = [level.get("reasoningEffort") if isinstance(level, dict) else level for level in levels]
            efforts = list(dict.fromkeys(level for level in levels if isinstance(level, str) and EFFORT.fullmatch(level)))
            default_effort = entry.get("defaultEffortLevel") or entry.get("defaultReasoningEffort")
            effort_fields = {"efforts": efforts, "defaultEffort": default_effort if default_effort in efforts else ""}
        result.append({
            "id": identifier,
            "label": str(entry.get("displayName") or identifier)[:200],
            "description": str(entry.get("description") or "")[:1000],
            "resolvedModel": str(entry.get("resolvedModel") or identifier)[:200],
            **effort_fields,
            "isDefault": identifier == "default" if provider == "claude" else bool(entry.get("isDefault")),
        })
    if not result:
        raise RuntimeError("The CLI returned no selectable models.")
    return result


def discover(provider, proxy=None):
    env = proxy_environment(os.environ, proxy or {})
    docker = ["docker"]
    if subprocess.run(docker + ["info"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5).returncode:
        docker = ["sudo", "-n", "docker"]
    state = Path(os.environ.get("XDG_STATE_HOME", str(Path.home() / ".local/state"))) / "windows-mcp" / provider
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    container = "relay-model-catalog-" + uuid.uuid4().hex
    command = docker + [
        "run", "--rm", "-i", "--init", "--name", container,
        "--network", "host", "--memory=512m" if provider == "claude" else "--memory=256m",
        "--memory-swap=512m", "--pids-limit=128", "--log-driver=none",
        "--user", f"{os.getuid()}:{os.getgid()}",
        "--mount", f"type=bind,source={state},target=/home/{provider}/state",
        "--workdir", "/tmp",
    ]
    for name in ('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'NO_PROXY', 'no_proxy'):
        if name in env:
            command += ['--env', name]
    command += [f"windows-mcp-{provider}:local"]
    if provider == "claude":
        command += [
            "claude", "--print", "--input-format", "stream-json", "--output-format", "stream-json",
            "--verbose", "--no-session-persistence", "--setting-sources", "",
            "--settings", '{"disableAllHooks":true}', "--strict-mcp-config",
            "--mcp-config", '{"mcpServers":{}}', "--tools", "",
        ]
    else:
        command += ["codex", "app-server", "--listen", "stdio://", "-c", "check_for_update_on_startup=false"]

    process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env)
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    buffer = b""
    entries = []
    request_id = 2
    version = ""

    def send(value):
        process.stdin.write((json.dumps(value) + "\n").encode())
        process.stdin.flush()

    try:
        if provider == "claude":
            send({"type": "control_request", "request_id": "catalog", "request": {"subtype": "initialize"}})
        else:
            send({"id": 1, "method": "initialize", "params": {"clientInfo": {"name": "relay_desk", "version": "0.1.0"}}})
        deadline = time.monotonic() + 25
        while time.monotonic() < deadline:
            if not selector.select(min(1, max(0, deadline - time.monotonic()))):
                if process.poll() is not None:
                    raise RuntimeError(f"{provider} model discovery exited ({process.returncode}). Check CLI installation and login.")
                continue
            chunk = os.read(process.stdout.fileno(), 65536)
            if not chunk:
                raise RuntimeError(f"{provider} model discovery closed before returning models.")
            buffer += chunk
            if len(buffer) > 2000000:
                raise RuntimeError("CLI discovery response exceeded its size limit.")
            while b"\n" in buffer:
                line, buffer = buffer.split(b"\n", 1)
                if not line.strip():
                    continue
                message = json.loads(line)
                if provider == "claude":
                    response = message.get("response", {})
                    if message.get("type") != "control_response" or response.get("request_id") != "catalog":
                        continue
                    if response.get("subtype") == "error":
                        raise RuntimeError("Claude initialization rejected model discovery. Check CLI installation and login.")
                    payload = response.get("response", {})
                    return {"models": normalize(provider, payload.get("models", [])), "version": payload.get("claude_code_version", "")}
                if message.get("id") not in (1, request_id):
                    continue
                if "error" in message:
                    raise RuntimeError("Codex rejected model discovery. Check CLI installation and login.")
                if message.get("id") == 1:
                    version = str(message.get("result", {}).get("userAgent", ""))[:200]
                    send({"method": "initialized", "params": {}})
                    send({"id": request_id, "method": "model/list", "params": {"limit": 100, "includeHidden": False}})
                else:
                    payload = message.get("result", {})
                    entries.extend(payload.get("data", []))
                    cursor = payload.get("nextCursor")
                    if cursor and len(entries) < 500:
                        request_id += 1
                        send({"id": request_id, "method": "model/list", "params": {"limit": 100, "includeHidden": False, "cursor": cursor}})
                    else:
                        return {"models": normalize(provider, entries), "version": version}
        raise RuntimeError(f"{provider} model discovery timed out.")
    finally:
        selector.close()
        process.terminate()
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        # Remove only this discovery container, including after an interrupted protocol exchange.
        subprocess.run(docker + ["rm", "-f", container], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("provider", choices=["claude", "codex"])
    parser.add_argument('--proxy-stdin', action='store_true')
    arguments = parser.parse_args()
    try:
        proxy = json.loads(sys.stdin.read(4096)) if arguments.proxy_stdin else None
        print(json.dumps(discover(arguments.provider, proxy)))
    except (RuntimeError, OSError, ValueError, subprocess.SubprocessError) as error:
        print(json.dumps({"error": str(error)}))
        raise SystemExit(1)
