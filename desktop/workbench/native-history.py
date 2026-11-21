"""Tail only the owned interactive transcript; emit public messages, never reasoning."""
import glob
import json
import os
import time
from datetime import datetime


def public_row(engine, row):
    if row.get('isMeta') or row.get('isCompactSummary') or row.get('parent_tool_use_id'):
        return None
    result = {key: row[key] for key in ('type', 'uuid', 'timestamp', 'subtype', 'sessionId') if key in row}
    if engine == 'codex' and row.get('type') == 'session_meta':
        result['payload'] = {key: row['payload'][key] for key in ('id', 'originator') if key in row.get('payload', {})}
        return result
    if engine == 'claude':
        if row.get('type') not in ('user', 'assistant', 'system', 'api-request'):
            return None
        message = row.get('message') or {}
        content = message.get('content')
        if isinstance(content, list):
            content = [{key: p[key] for key in ('type', 'text', 'name') if key in p}
                       for p in content if isinstance(p, dict) and p.get('type') in ('text', 'tool_use')]
        result['message'] = {key: message[key] for key in ('id', 'role', 'stop_reason', 'model') if key in message}
        result['message']['content'] = content
        return result
    payload = row.get('payload') or {}
    if row.get('type') == 'event_msg' and payload.get('type') in ('user_message', 'agent_message', 'task_started', 'task_complete', 'turn_aborted', 'error'):
        result['payload'] = {key: payload[key] for key in ('type', 'id', 'message', 'turn_id', 'phase') if key in payload}
        return result
    if row.get('type') == 'response_item' and payload.get('type') == 'message' and payload.get('role') in ('user', 'assistant'):
        result['payload'] = {key: payload[key] for key in ('type', 'id', 'role', 'phase') if key in payload}
        result['payload']['content'] = [{key: p[key] for key in ('type', 'text') if key in p}
                                       for p in payload.get('content', []) if isinstance(p, dict) and p.get('type') in ('input_text', 'output_text', 'text')]
        return result
    return None


class NativeHistory:
    def __init__(self, engine, root, session, originator, emit, start_at=None, from_end=False, exact_session=False):
        self.engine, self.root, self.session, self.originator, self.emit = engine, root, session, originator, emit
        self.start, self.file, self.offset = start_at or time.time(), None, 0
        self.from_end = from_end
        self.exact_session = exact_session
        self.next_poll = 0
        self.oversize = False

    def discover(self):
        if self.engine == 'claude':
            return glob.glob(os.path.join(self.root, 'projects', '*', self.session + '.jsonl'))
        result = []
        for day in (time.time(), time.time() - 86400, self.start, self.start - 86400, self.start + 86400):
            date = datetime.fromtimestamp(day)
            folder = os.path.join(self.root, 'sessions', date.strftime('%Y/%m/%d'))
            for filename in glob.glob(os.path.join(folder, 'rollout-*.jsonl')):
                if os.path.islink(filename) or (not self.exact_session and os.path.getmtime(filename) < self.start - 5):
                    continue
                try:
                    with open(filename, 'rb') as source:
                        meta = json.loads(source.readline(65537))
                    payload = meta.get('payload') or {}
                    if meta.get('type') == 'session_meta' and (payload.get('id') == self.session if self.exact_session else payload.get('originator') == self.originator):
                        result.append(filename)
                except (OSError, ValueError):
                    pass
        return list(set(result))

    def poll(self, force=False):
        if not force and time.monotonic() < self.next_poll:
            return
        self.next_poll = time.monotonic() + 0.5
        try:
            if not self.file:
                files = self.discover()
                if len(files) != 1:
                    return
                self.file = files[0]
                if self.from_end:
                    self.offset = os.path.getsize(self.file)
                    self.from_end = False
            if os.path.islink(self.file):
                return
            if os.path.getsize(self.file) < self.offset:
                self.offset = 0
            with open(self.file, 'rb') as source:
                source.seek(self.offset)
                budget = 2 * 1024 * 1024
                while budget > 0:
                    position = source.tell()
                    line = source.readline(1048577)
                    if not line:
                        break
                    if not line.endswith(b'\n'):
                        if len(line) > 1048576 or self.oversize:
                            self.oversize = True
                            budget -= len(line)
                            continue
                        source.seek(position)
                        break
                    budget -= len(line)
                    if self.oversize:
                        self.oversize = False
                        continue
                    try:
                        row = public_row(self.engine, json.loads(line))
                        if row:
                            self.emit({'record': str(position), 'row': row})
                    except (ValueError, TypeError):
                        pass
                self.offset = source.tell()
        except OSError:
            pass
