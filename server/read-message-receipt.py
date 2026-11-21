#!/usr/bin/env python3
"""Confirm a submitted prompt from new user transcript records without exporting its text."""
import glob
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import time
from datetime import datetime


def files_for(provider, session):
    root = Path(os.environ.get('XDG_STATE_HOME', str(Path.home() / '.local/state'))) / 'windows-mcp'
    pattern = str(root / 'claude' / 'projects' / '*' / (session + '.jsonl')) if provider == 'claude' else str(root / 'codex' / 'ui' / session / 'sessions' / '**' / 'rollout-*.jsonl')
    files = [file for file in glob.glob(pattern, recursive=True) if os.path.isfile(file) and not os.path.islink(file)]
    return sorted(files, key=os.path.getmtime)[-32:]


def user_text(row, provider):
    if provider == 'claude':
        if row.get('type') != 'user' or row.get('isMeta') or row.get('isCompactSummary'):
            return None
        message = row.get('message') or {}
        if message.get('role') != 'user':
            return None
        content = message.get('content')
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            if any(isinstance(part, dict) and part.get('type') == 'tool_result' for part in content):
                return None
            return '\n\n'.join(part['text'] for part in content if isinstance(part, dict) and part.get('type') == 'text' and isinstance(part.get('text'), str))
    elif row.get('type') == 'event_msg' and (row.get('payload') or {}).get('type') == 'user_message':
        return row['payload'].get('message')
    return None


def prompt_digests(text):
    normalized = text.replace('\r\n', '\n').strip()
    yield hashlib.sha256(normalized.encode('utf-8')).hexdigest()
    # Claude may wrap bracketed-paste input in transport markup before recording it.
    if re.search(r'<pasted_content(?:\s[^>]*)?>', normalized):
        unwrapped = re.sub(r'</?pasted_content(?:\s[^>]*)?>', '', normalized).strip()
        yield hashlib.sha256(unwrapped.encode('utf-8')).hexdigest()


def main():
    request = json.loads(sys.argv[1])
    provider, session = request.get('provider'), request.get('session')
    if provider not in ('claude', 'codex') or not isinstance(session, str) or not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', session):
        raise ValueError('Invalid conversation.')
    files = files_for(provider, session)
    if request.get('action') == 'checkpoint':
        positions = []
        for file in files:
            info = os.stat(file)
            positions.append({'inode': info.st_ino, 'offset': info.st_size})
        return {'positions': positions, 'createdAt': int(time.time() * 1000)}
    checkpoint, digest = request.get('checkpoint'), request.get('digest')
    if not isinstance(checkpoint, dict) or not isinstance(checkpoint.get('createdAt'), (int, float)) or not isinstance(digest, str) or not re.fullmatch('[a-f0-9]{64}', digest):
        raise ValueError('Invalid receipt request.')
    positions = checkpoint.get('positions')
    if not isinstance(positions, list) or len(positions) > 32:
        raise ValueError('Invalid receipt checkpoint.')
    known = {entry['inode']: entry['offset'] for entry in positions if isinstance(entry, dict) and isinstance(entry.get('inode'), int) and isinstance(entry.get('offset'), int) and entry['offset'] >= 0}
    for file in files:
        info = os.stat(file)
        offset = known.get(info.st_ino, 0)
        if offset > info.st_size:
            offset = 0
        start = max(offset, info.st_size - 4194304)
        with open(file, 'rb') as source:
            source.seek(start)
            if start > offset:
                source.readline(2097153)
            while True:
                line = source.readline(2097153)
                if not line:
                    break
                if not line.endswith(b'\n'):
                    while line and not line.endswith(b'\n'):
                        line = source.readline(2097153)
                    continue
                try:
                    row = json.loads(line)
                    timestamp = datetime.fromisoformat(row.get('timestamp', '').replace('Z', '+00:00')).timestamp() * 1000
                except (ValueError, TypeError, AttributeError):
                    continue
                # A rotated/recreated file must not confirm an identical older prompt.
                if timestamp < checkpoint['createdAt']:
                    continue
                text = user_text(row, provider)
                if isinstance(text, str) and digest in prompt_digests(text):
                    return {'accepted': True, 'recordedAt': timestamp}
    return {'accepted': False}


if __name__ == '__main__':
    try:
        print(json.dumps(main()))
    except (OSError, ValueError, TypeError, KeyError):
        print(json.dumps({'error': 'Unable to confirm remote message receipt.'}))
