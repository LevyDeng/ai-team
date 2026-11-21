#!/usr/bin/env python3
"""Release completed, detached desktop processes at admission and lifecycle boundaries."""
from contextlib import contextmanager
from datetime import datetime
import fcntl
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import time


DIRECTORY = Path(__file__).resolve().parent


def load_module(name, filename):
    spec = importlib.util.spec_from_file_location(name, DIRECTORY / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@contextmanager
def try_lock(filename):
    with filename.open('a') as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            yield False
            return
        try:
            yield True
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def attached_clients(root):
    result = subprocess.run(['tmux', '-S', str(root / 'desktop-terminals/tmux.sock'),
                             'list-sessions', '-F', '#{session_name}\t#{session_attached}'],
                            capture_output=True, text=True, timeout=3)
    if result.returncode:
        return {}
    return {name: int(count) for name, count in (line.split('\t') for line in result.stdout.splitlines())}


def milliseconds(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp() * 1000


def completed_at(history, entry):
    data = history.read_history(entry['provider'], entry['id'], status=True)
    updated = data.get('taskUpdatedAt')
    # Old transcript/hook state from before this process started is not proof of idleness.
    if (data.get('taskState') != 'completed' or not isinstance(updated, (int, float))
            or updated < milliseconds(entry['startedAt']) or time.time() * 1000 - updated < 60000):
        return None
    return updated


def admit(request, dry_run=False):
    managed = load_module('relay_sessions', 'desktop-sessions.py')
    history = load_module('relay_history', 'read-session-history.py')
    session = request.get('id')
    provider = request.get('provider')
    cleanup = request.get('action') == 'cleanup-completed'
    if not cleanup and (provider not in ('claude', 'codex') or not managed.NAME.fullmatch('relay-' + str(session))):
        raise ValueError('Invalid target session.')
    protected = request.get('protected', [])
    if not isinstance(protected, list) or len(protected) > 200:
        raise ValueError('Invalid protected sessions.')
    protected_keys = {(item['provider'], item['id']) for item in protected}
    root = managed.ROOT
    lock_dir = root / 'desktop-terminals'
    lock_dir.mkdir(parents=True, exist_ok=True)
    released = []

    def snapshot():
        return {**managed.limits(), 'active': managed.active_sessions(), 'released': released}

    value = snapshot()
    target = lambda item: not cleanup and item['id'] == session and item['provider'] == provider
    needs_room = lambda current: (not any(target(item) for item in current['active'])
                                 and (cleanup or len(current['active']) >= current['maxSessions']
                                      or current['availableMiB'] < current['requiredMiB']))
    if not needs_room(value):
        return value
    # Use the same global admission lock as start-desktop-session.sh.
    with try_lock(root / 'desktop-startup-v2.lock') as locked:
        if not locked:
            return snapshot()
        value = snapshot()
        docker = ['docker']
        if subprocess.run(docker + ['info'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5).returncode:
            docker = ['sudo', '-n', 'docker']
        clients = attached_clients(root)
        candidates = []
        for entry in value['active']:
            terminal = 'relay-' + entry['provider'] + '-' + entry['id']
            if target(entry) or entry.get('starting') or (entry['provider'], entry['id']) in protected_keys or clients.get(terminal) != 0:
                continue
            updated = completed_at(history, entry)
            if updated is not None:
                candidates.append((updated, entry, terminal))
        if dry_run:
            return {**value, 'reclaimable': [{'id': entry['id'], 'provider': entry['provider']}
                                            for _, entry, _ in candidates]}
        # Release the least recently completed process first; keep transcripts and project data.
        for _, entry, terminal in sorted(candidates, key=lambda item: item[0]):
            if not needs_room(value):
                break
            with try_lock(lock_dir / (terminal + '.lock')) as session_locked:
                if not session_locked or attached_clients(root).get(terminal) != 0 or completed_at(history, entry) is None:
                    continue
                name = ('relay-codex-' if entry['provider'] == 'codex' else 'relay-') + entry['id']
                info = json.loads(subprocess.check_output(docker + ['inspect', name], text=True, timeout=5))[0]
                if (not info['State']['Running'] or info['State']['StartedAt'] != entry['startedAt']
                        or info['Config'].get('Labels', {}).get('io.relaydesk.session') != 'true'):
                    continue
                subprocess.run(docker + ['stop', '--time', '3', info['Id']], check=True,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=8)
                subprocess.run(['tmux', '-S', str(root / 'desktop-terminals/tmux.sock'),
                                'kill-session', '-t', '=' + terminal],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=3)
                released.append({'id': entry['id'], 'provider': entry['provider']})
            value = snapshot()
    return value


if __name__ == '__main__':
    try:
        print(json.dumps(admit(json.loads(sys.argv[1]), dry_run='--dry-run' in sys.argv[2:])))
    except (OSError, ValueError, TypeError, KeyError, IndexError, subprocess.SubprocessError):
        print('Unable to safely release idle desktop sessions.', file=sys.stderr)
        sys.exit(1)
