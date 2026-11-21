#!/usr/bin/env python3
"""Read account quota metadata without starting a model turn or exposing credentials."""

import argparse
from datetime import datetime
import json
import math
import os
from pathlib import Path
import selectors
import stat
import subprocess
import time
import uuid

ROOT = Path(os.environ.get("XDG_STATE_HOME", str(Path.home() / ".local/state"))) / "windows-mcp"
STATUS_COMMAND = "bash /opt/windows-mcp/record-claude-usage.sh"
CLAUDE_CACHE_SECONDS = 300


def result(provider, state, windows=None, **extra):
    return {"provider": provider, "state": state, "windows": windows or [], **extra}


def number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def window(identifier, label, used, resets, minutes):
    if not number(used):
        return None
    return {"id": identifier, "label": label[:100], "usedPercent": max(0, min(100, used)),
            "resetsAt": resets if number(resets) and resets > 0 else None,
            "windowMinutes": minutes if number(minutes) and minutes > 0 else None}


def read_json(filename, limit=1048576):
    info = filename.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
        raise ValueError("Invalid quota metadata file.")
    return json.loads(filename.read_text())


def configure_claude():
    directory = ROOT / "claude"
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    filename = directory / "settings.json"
    settings = read_json(filename) if filename.exists() else {}
    statusline = settings.get("statusLine")
    if statusline and statusline != {"type": "command", "command": STATUS_COMMAND}:
        return {"configured": False, "reason": "custom_statusline"}
    if not statusline:
        backup = directory / "settings.before-relay-usage.json"
        if not backup.exists():
            with backup.open("x") as output:
                os.chmod(backup, 0o600)
                json.dump(settings, output, indent=2)
        settings["statusLine"] = {"type": "command", "command": STATUS_COMMAND}
        temporary = directory / (".relay-settings-" + uuid.uuid4().hex)
        try:
            with temporary.open("x") as output:
                os.chmod(temporary, 0o600)
                json.dump(settings, output, indent=2)
                output.write("\n")
            os.replace(temporary, filename)
        finally:
            temporary.unlink(missing_ok=True)
    return {"configured": True}


def reset_seconds(value):
    if number(value):
        return value
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()
        except (ValueError, OverflowError):
            return None
    return None


def normalize_claude_usage(payload, reported_at):
    rate = payload.get('rate_limits') or {}
    windows = []
    for key, label, minutes in (('five_hour', '5 小时', 300), ('seven_day', '7 天总额度', 10080)):
        item = rate.get(key)
        if isinstance(item, dict):
            entry = window(key, label, item.get('utilization'), reset_seconds(item.get('resets_at')), minutes)
            if entry:
                windows.append(entry)
    scoped = rate.get('model_scoped')
    if isinstance(scoped, list):
        for index, item in enumerate(scoped[:12]):
            if not isinstance(item, dict) or not isinstance(item.get('display_name'), str):
                continue
            name = item['display_name'].strip()[:60]
            if not name:
                continue
            entry = window('model:' + name.casefold(), name + ' 周额度', item.get('utilization'), reset_seconds(item.get('resets_at')), 10080)
            if entry and not any(existing['id'] == entry['id'] for existing in windows):
                entry['modelName'] = name
                windows.append(entry)
    return result('claude', 'ready' if windows else 'unsupported', windows, updatedAt=reported_at * 1000,
                  source='claude-cli-control', modelScopedAvailable=bool(scoped),
                  reason='' if windows else 'usage_unavailable')


def query_claude_usage(image='windows-mcp-claude:local'):
    state = ROOT / 'claude'
    docker = ['docker']
    if subprocess.run(docker + ['info'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5).returncode:
        docker = ['sudo', '-n', 'docker']
    container = 'relay-claude-usage-' + uuid.uuid4().hex
    command = docker + ['run', '--rm', '-i', '--init', '--name', container, '--network', 'host',
                        '--memory=512m', '--memory-swap=512m', '--pids-limit=96', '--log-driver=none',
                        '--user', f'{os.getuid()}:{os.getgid()}',
                        '--mount', f'type=bind,source={state},target=/home/claude/state', '--workdir', '/tmp',
                        image, 'claude', '-p', '--input-format', 'stream-json',
                        '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--safe-mode',
                        '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', '']
    process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)

    def send(identifier, request):
        process.stdin.write((json.dumps({'type': 'control_request', 'request_id': identifier, 'request': request}) + '\n').encode())
        process.stdin.flush()

    try:
        send('relay-init', {'subtype': 'initialize'})
        buffer = b''
        deadline = time.monotonic() + 22
        while time.monotonic() < deadline:
            if not selector.select(1):
                if process.poll() is not None:
                    raise ValueError('Claude usage control unavailable.')
                continue
            chunk = os.read(process.stdout.fileno(), 65536)
            if not chunk:
                break
            buffer += chunk
            if len(buffer) > 1048576:
                raise ValueError('Claude usage output limit exceeded.')
            while b'\n' in buffer:
                line, buffer = buffer.split(b'\n', 1)
                try:
                    record = json.loads(line)
                except ValueError:
                    continue
                if record.get('type') != 'control_response':
                    continue
                response = record.get('response') or {}
                if response.get('subtype') != 'success':
                    raise ValueError('Claude usage control failed.')
                if response.get('request_id') == 'relay-init':
                    # This control message fetches metadata, never a model turn or a reset.
                    send('relay-usage', {'subtype': 'get_usage', 'skip_behaviors': True})
                elif response.get('request_id') == 'relay-usage':
                    return normalize_claude_usage(response.get('response') or {}, time.time())
        raise ValueError('Claude usage control timed out.')
    finally:
        selector.close()
        process.terminate()
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        subprocess.run(docker + ['rm', '-f', container], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)


def atomic_json(filename, data):
    temporary = filename.with_name('.relay-usage-' + uuid.uuid4().hex)
    try:
        with temporary.open('x') as output:
            os.chmod(temporary, 0o600)
            json.dump(data, output)
        os.replace(temporary, filename)
    finally:
        temporary.unlink(missing_ok=True)


def read_claude_statusline():
    filename = ROOT / "claude" / "relay-usage.json"
    if not filename.exists():
        settings_path = ROOT / "claude" / "settings.json"
        settings = read_json(settings_path) if settings_path.exists() else {}
        statusline = settings.get("statusLine") or {}
        reason = "waiting_for_claude" if statusline.get("command") == STATUS_COMMAND else "custom_statusline"
        return result("claude", "pending", reason=reason, source="claude-statusline")
    data = read_json(filename, 32768)
    rate = data.get("rate_limits") or {}
    windows = []
    for key, label, minutes in (("five_hour", "5 小时", 300), ("seven_day", "7 天", 10080), ("spend_limit", "消费限额", None)):
        item = rate.get(key) or {}
        entry = window(key, label, item.get("used_percentage"), item.get("resets_at"), minutes)
        if entry:
            windows.append(entry)
    reported = data.get("reportedAt")
    return result("claude", "ready" if windows else "pending", windows,
                  updatedAt=reported * 1000 if number(reported) else filename.stat().st_mtime * 1000,
                  reason="" if windows else "waiting_for_claude", source="claude-statusline")


def read_claude():
    directory = ROOT / 'claude'
    fallback = read_claude_statusline()
    if not directory.is_dir():
        return fallback
    filename = directory / 'relay-account-usage.json'
    cached = None
    try:
        data = read_json(filename, 32768)
        if data.get('provider') == 'claude' and data.get('source') == 'claude-cli-control' and isinstance(data.get('windows'), list) and data['windows']:
            cached = data
    except (OSError, ValueError, AttributeError):
        pass
    now = time.time()
    if cached and number(cached.get('updatedAt')) and 0 <= now - cached['updatedAt'] / 1000 < CLAUDE_CACHE_SECONDS:
        return {**cached, 'cached': True}
    import fcntl
    with (directory / 'relay-usage.lock').open('a') as lock:
        os.chmod(directory / 'relay-usage.lock', 0o600)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return {**(cached or fallback), 'cached': True, 'reason': 'query_in_progress'}
        attempt_file = directory / 'relay-usage-attempt.json'
        try:
            last = read_json(attempt_file).get('at')
            if number(last) and 0 <= now - last < CLAUDE_CACHE_SECONDS:
                return {**(cached or fallback), 'cached': True, 'reason': 'query_cooldown'}
        except (OSError, ValueError, AttributeError):
            pass
        try:
            available = next(int(line.split()[1]) for line in Path('/proc/meminfo').read_text().splitlines() if line.startswith('MemAvailable:'))
            if available < 700 * 1024:
                return {**(cached or fallback), 'cached': True, 'reason': 'server_busy'}
            atomic_json(attempt_file, {'at': now})
            current = query_claude_usage()
            if current['windows']:
                atomic_json(filename, current)
                return current
        except (OSError, ValueError, TypeError, AttributeError, StopIteration, subprocess.SubprocessError):
            return {**(cached or fallback), 'cached': True, 'reason': 'query_failed'}
        return {**(cached or fallback), 'cached': True, 'reason': 'usage_unavailable'}


def read_codex():
    state = ROOT / "codex"
    if not (state / "auth.json").is_file():
        return result("codex", "not_signed_in")
    for line in Path("/proc/meminfo").read_text().splitlines():
        if line.startswith("MemAvailable:") and int(line.split()[1]) < 524288:
            return result("codex", "pending", reason="server_busy")
    docker = ["docker"]
    if subprocess.run(docker + ["info"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5).returncode:
        docker = ["sudo", "-n", "docker"]
    container = "relay-usage-" + uuid.uuid4().hex
    command = docker + ["run", "--rm", "-i", "--init", "--name", container, "--network", "host",
                        "--memory=256m", "--memory-swap=256m", "--pids-limit=96", "--log-driver=none",
                        "--user", f"{os.getuid()}:{os.getgid()}",
                        "--mount", f"type=bind,source={state},target=/home/codex/state", "--workdir", "/tmp",
                        "windows-mcp-codex:local", "codex", "app-server", "--listen", "stdio://",
                        "-c", "check_for_update_on_startup=false"]
    process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    buffer = b""

    def send(message):
        process.stdin.write((json.dumps(message) + "\n").encode())
        process.stdin.flush()

    try:
        send({"id": 1, "method": "initialize", "params": {"clientInfo": {"name": "relay_desk_usage", "version": "0.1.0"}}})
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            if not selector.select(1):
                if process.poll() is not None:
                    return result("codex", "error", reason="query_failed")
                continue
            chunk = os.read(process.stdout.fileno(), 65536)
            if not chunk:
                return result("codex", "error", reason="query_failed")
            buffer += chunk
            if len(buffer) > 1048576:
                return result("codex", "error", reason="query_failed")
            while b"\n" in buffer:
                line, buffer = buffer.split(b"\n", 1)
                if not line.strip():
                    continue
                message = json.loads(line)
                if message.get("id") not in (1, 2):
                    continue
                if "error" in message:
                    return result("codex", "error", reason="query_failed")
                if message.get("id") == 1:
                    send({"method": "initialized", "params": {}})
                    send({"id": 2, "method": "account/rateLimits/read"})
                    continue
                payload = message.get("result") or {}
                buckets = payload.get("rateLimitsByLimitId") or {}
                if not buckets and payload.get("rateLimits"):
                    buckets = {"codex": payload["rateLimits"]}
                windows = []
                for identifier, bucket in list(buckets.items())[:10]:
                    for key in ("primary", "secondary"):
                        item = bucket.get(key) or {}
                        name = str(bucket.get("limitName") or (identifier if len(buckets) > 1 else ""))[:80]
                        entry = window(str(identifier)[:80] + ":" + key, name, item.get("usedPercent"), item.get("resetsAt"), item.get("windowDurationMins"))
                        if entry:
                            windows.append(entry)
                return result("codex", "ready" if windows else "unsupported", windows,
                              updatedAt=time.time() * 1000, source="codex-app-server")
        return result("codex", "error", reason="query_timeout")
    finally:
        selector.close()
        process.terminate()
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        subprocess.run(docker + ["rm", "-f", container], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("provider", choices=("claude", "codex"))
    parser.add_argument("--configure", action="store_true")
    args = parser.parse_args()
    try:
        output = configure_claude() if args.configure and args.provider == "claude" else read_claude() if args.provider == "claude" else read_codex()
        print(json.dumps(output))
    except (OSError, ValueError, TypeError, AttributeError, subprocess.SubprocessError):
        print(json.dumps(result(args.provider, "error", reason="query_failed")))
