#!/usr/bin/env python3
"""Read displayable messages and the latest completed turn for Relay Desk."""

import argparse
import glob
import json
import os
import re
from datetime import datetime
from types import SimpleNamespace


def read_rows(filename, start, skip_partial=False, bounded=False):
    rows = []
    with open(filename, 'rb') as source:
        source.seek(start)
        if skip_partial and start:
            source.readline()
        while True:
            position = source.tell()
            line = source.readline(1048577) if bounded else source.readline()
            if not line:
                break
            if bounded and len(line) > 1048576 and not line.endswith(b'\n'):
                while line and not line.endswith(b'\n'):
                    line = source.readline(1048577)
                continue
            try:
                rows.append(json.loads(line.decode('utf-8', errors='replace')))
            except ValueError:
                if not line.endswith(b'\n'):
                    source.seek(position)
                    break
        return rows, source.tell()


def task_signal(row, provider):
    if provider == 'claude':
        if row.get('isCompactSummary') or row.get('isMeta'):
            return None
        kind = row.get('type')
        message = row.get('message') or {}
        content = message.get('content')
        parts = content if isinstance(content, list) else []
        if kind == 'system' and row.get('subtype') == 'turn_duration':
            return 'completed'
        if kind == 'api-request':
            return 'running'
        if kind == 'user' and not row.get('isMeta'):
            return 'running'
        if kind == 'assistant':
            if any(part.get('type') == 'tool_use' and part.get('name') in ('AskUserQuestion', 'ExitPlanMode') for part in parts if isinstance(part, dict)):
                return 'waiting'
            if message.get('stop_reason') == 'end_turn' and (isinstance(content, str) and content.strip() or any(part.get('type') == 'text' and part.get('text', '').strip() for part in parts if isinstance(part, dict))):
                return 'completed'
            if parts:
                return 'running'
    else:
        payload = row.get('payload') or {}
        if row.get('type') == 'event_msg':
            return {'task_started': 'running', 'user_message': 'running', 'task_complete': 'completed',
                    'turn_aborted': 'interrupted', 'error': 'failed'}.get(payload.get('type'))
    return None


def timestamp(value):
    try:
        return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp() * 1000
    except (AttributeError, TypeError, ValueError):
        return None


def read_history(provider, session, status=False, since=None):
    args = SimpleNamespace(provider=provider, session=session, status=status, since=since)
    if not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', session):
        raise ValueError('Invalid session ID')
    if since and (since[0] < 0 or since[1] < 0):
        raise ValueError('Invalid cursor')
    return read_history_result(args)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('provider', choices=('claude', 'codex'))
    parser.add_argument('session')
    parser.add_argument('--status', action='store_true')
    parser.add_argument('--since', nargs=2, type=int, metavar=('OFFSET', 'INODE'))
    args = parser.parse_args()
    if not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', args.session):
        parser.error('Invalid session ID')
    if args.since and (args.since[0] < 0 or args.since[1] < 0):
        parser.error('Invalid cursor')
    print(json.dumps(read_history_result(args), ensure_ascii=False))


def read_history_result(args):
    root = os.path.join(os.environ.get('XDG_STATE_HOME', os.path.expanduser('~/.local/state')), 'windows-mcp')
    if args.provider == 'claude':
        files = glob.glob(os.path.join(root, 'claude', 'projects', '*', args.session + '.jsonl'))
        files = sorted(files, key=os.path.getmtime)[-1:]
    else:
        files = sorted(glob.glob(os.path.join(root, 'codex', 'ui', args.session, 'sessions', '**', 'rollout-*.jsonl'), recursive=True))
    messages = []
    completion = ''
    seen = set()
    cursor = None
    reset = False
    found = False
    task_state = None
    task_updated = None
    task_source = 'transcript'
    for filename in files:
        if not os.path.isfile(filename) or os.path.islink(filename):
            continue
        found = True
        info = os.stat(filename)
        start = 0
        if args.provider == 'claude':
            if args.since:
                offset, inode = args.since
                if inode == info.st_ino and offset <= info.st_size:
                    start = offset
                else:
                    reset = True
            if args.status and (not args.since or reset):
                start = max(0, info.st_size - 1024 * 1024)
        elif args.status:
            start = max(0, info.st_size - 1024 * 1024)
        previous_start = start
        if args.status:
            start = max(start, info.st_size - 2097152)
        skip_partial = bool(start and (not args.since or reset or start != previous_start))
        rows, offset = read_rows(filename, start, skip_partial, bounded=args.status)
        if args.provider == 'claude':
            cursor = {'offset': offset, 'inode': info.st_ino}
        for row in rows:
                signal = task_signal(row, args.provider)
                if signal:
                    task_state = signal
                    task_updated = timestamp(row.get('timestamp'))
                if args.provider == 'claude':
                    kind = row.get('type')
                    message = row.get('message') or {}
                    if kind == 'assistant' and message.get('stop_reason') == 'end_turn' and signal == 'completed':
                        completion = row.get('uuid') or message.get('id') or ''
                    if args.status or kind not in ('assistant', 'user'):
                        continue
                    if row.get('isCompactSummary') or row.get('isMeta'):
                        continue
                    role = message.get('role') or kind
                    content = message.get('content')
                    if isinstance(content, str):
                        body = content
                    elif isinstance(content, list):
                        body = '\n\n'.join(part['text'] for part in content if isinstance(part, dict) and part.get('type') == 'text' and isinstance(part.get('text'), str))
                    else:
                        body = ''
                    key = (role, message.get('id'), body)
                else:
                    kind = row.get('type')
                    payload = row.get('payload') or {}
                    if kind == 'event_msg' and payload.get('type') == 'task_complete':
                        completion = payload.get('turn_id') or row.get('timestamp') or ''
                    if args.status:
                        continue
                    if kind == 'event_msg' and payload.get('type') in ('user_message', 'agent_message'):
                        role = 'user' if payload['type'] == 'user_message' else 'assistant'
                        body = payload.get('message') or ''
                    elif kind == 'response_item' and payload.get('type') == 'message':
                        role = payload.get('role')
                        parts = payload.get('content') or []
                        body = '\n\n'.join(part['text'] for part in parts if isinstance(part, dict) and part.get('type') in ('input_text', 'output_text') and isinstance(part.get('text'), str))
                    else:
                        continue
                    key = (role, payload.get('id') or row.get('timestamp'), body)
                if role not in ('assistant', 'user') or not isinstance(body, str) or not body.strip() or key in seen:
                    continue
                seen.add(key)
                messages.append({'role': role, 'text': body[:50000]})
    if args.provider == 'claude':
        marker = os.path.join(root, 'claude', 'relay-task-state', args.session + '.json')
        try:
            if not os.path.islink(marker) and os.path.getsize(marker) < 4096:
                with open(marker) as source:
                    hook = json.load(source)
                if hook.get('state') in ('running', 'waiting', 'completed', 'failed', 'stopped') and isinstance(hook.get('updatedAt'), (int, float)) and hook['updatedAt'] >= (task_updated or 0):
                    task_state, task_updated, task_source = hook['state'], hook['updatedAt'], 'hook'
        except (OSError, ValueError, TypeError):
            pass
    result = {'completion': completion, 'cursor': cursor, 'reset': reset, 'found': found,
              'taskState': task_state, 'taskUpdatedAt': task_updated, 'taskSource': task_source}
    if not args.status:
        result['historyFormatVersion'] = 2
        result['messages'] = messages[-100:]
        while len(json.dumps(result, ensure_ascii=False).encode('utf-8')) > 700000 and result['messages']:
            result['messages'].pop(0)
    return result


if __name__ == '__main__':
    main()
