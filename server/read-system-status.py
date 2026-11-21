#!/usr/bin/env python3
"""Collect bounded task metadata and host metrics without inspecting message bodies for the client."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import subprocess
import time
import uuid

directory = Path(__file__).resolve().parent


def load_module(name, file):
    spec = importlib.util.spec_from_file_location(name, directory / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def cpu_ticks():
    return [int(value) for value in Path('/proc/stat').read_text().splitlines()[0].split()[1:9]]


def resources():
    ticks = cpu_ticks()
    now = time.time()
    root = Path(os.environ.get('XDG_STATE_HOME', str(Path.home() / '.local/state'))) / 'windows-mcp'
    cache = root / 'server-cpu-sample.json'
    previous = None
    try:
        if cache.stat().st_size < 4096 and not cache.is_symlink():
            previous = json.loads(cache.read_text())
        if (not isinstance(previous, dict) or not isinstance(previous.get('time'), (int, float))
                or not 0.5 < now - previous['time'] < 120
                or not isinstance(previous.get('ticks'), list) or len(previous['ticks']) != len(ticks)
                or not all(isinstance(value, int) and value >= 0 for value in previous['ticks'])):
            previous = None
    except (OSError, ValueError, TypeError, KeyError):
        previous = None
    if previous is None:
        previous = {'ticks': ticks, 'time': now}
        time.sleep(0.2)
        ticks, now = cpu_ticks(), time.time()
    delta = [current - old for current, old in zip(ticks, previous['ticks'])]
    total = sum(delta)
    percent = max(0, min(100, (total - delta[3] - delta[4]) / total * 100)) if total > 0 else 0
    temporary = root / ('.cpu-' + uuid.uuid4().hex)
    try:
        with temporary.open('x') as output:
            os.chmod(temporary, 0o600)
            json.dump({'ticks': ticks, 'time': now}, output)
        os.replace(temporary, cache)
    finally:
        temporary.unlink(missing_ok=True)
    memory = {}
    for line in Path('/proc/meminfo').read_text().splitlines():
        key, value = line.split(':', 1)
        if key in ('MemTotal', 'MemAvailable', 'Cached', 'Buffers', 'SReclaimable', 'Shmem', 'SwapTotal', 'SwapFree'):
            memory[key] = int(value.split()[0]) * 1024
    return {'updatedAt': now * 1000, 'cpuPercent': round(percent, 1), 'cpuCores': os.cpu_count(), 'load1': os.getloadavg()[0],
            'memoryTotal': memory['MemTotal'], 'memoryAvailable': memory['MemAvailable'],
            'memoryUsedPercent': round((1 - memory['MemAvailable'] / memory['MemTotal']) * 100, 1),
            'memoryCache': memory.get('Cached', 0) + memory.get('Buffers', 0) + memory.get('SReclaimable', 0) - memory.get('Shmem', 0),
            'swapTotal': memory.get('SwapTotal', 0), 'swapUsed': memory.get('SwapTotal', 0) - memory.get('SwapFree', 0)}


def main():
    requests = json.loads(sys.argv[1]) if len(sys.argv) > 1 else []
    if not isinstance(requests, list) or len(requests) > 200:
        raise ValueError('Invalid status request.')
    history = load_module('relay_history', 'read-session-history.py')
    managed = load_module('relay_sessions', 'desktop-sessions.py')
    active = managed.active_sessions()
    active_keys = {(entry['provider'], entry['id']) for entry in active}
    states = {}
    for item in requests:
        if item.get('provider') not in ('claude', 'codex'):
            continue
        cursor = item.get('cursor')
        since = (cursor['offset'], cursor['inode']) if isinstance(cursor, dict) and all(isinstance(cursor.get(key), int) and cursor[key] >= 0 for key in ('offset', 'inode')) else None
        data = history.read_history(item['provider'], item['id'], status=True, since=since)
        if (item['provider'], item['id']) not in active_keys and data['taskState'] in ('running', 'waiting'):
            data['taskState'] = 'interrupted'
            data['taskSource'] = 'process-ended'
        data['remoteActive'] = (item['provider'], item['id']) in active_keys
        states[item['id']] = data
    return {'resources': {**resources(), 'activeSessions': len(active), 'maxSessions': managed.limits()['maxSessions']}, 'sessions': states}


if __name__ == '__main__':
    try:
        print(json.dumps(main()))
    except (OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError):
        print(json.dumps({'error': 'Unable to read server metrics or task state.'}))
