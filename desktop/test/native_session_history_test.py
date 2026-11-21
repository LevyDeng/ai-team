import importlib.util
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from datetime import datetime

spec = importlib.util.spec_from_file_location('native_history', Path(__file__).parents[1] / 'workbench' / 'native-history.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class RestoredHistoryTest(unittest.TestCase):
    def test_exact_codex_session_starts_at_old_eof_and_keeps_new_messages(self):
        with tempfile.TemporaryDirectory(prefix='relay-history-') as root:
            day = datetime.fromtimestamp(time.time()).strftime('%Y/%m/%d')
            folder = Path(root) / 'sessions' / day
            folder.mkdir(parents=True)
            target = folder / 'rollout-fixture-owned.jsonl'
            target.write_text(json.dumps({'type': 'session_meta', 'payload': {'id': 'owned', 'originator': 'old-process'}}) + '\n' + json.dumps({'type': 'event_msg', 'payload': {'type': 'agent_message', 'message': 'OLD_REPLY'}}) + '\n', encoding='utf-8')
            other = folder / 'rollout-fixture-other.jsonl'
            other.write_text(json.dumps({'type': 'session_meta', 'payload': {'id': 'other', 'originator': 'new-process'}}) + '\n', encoding='utf-8')
            rows = []
            reader = module.NativeHistory('codex', root, 'owned', 'new-process', rows.append, from_end=True, exact_session=True)
            reader.poll(force=True)
            self.assertEqual(rows, [])
            self.assertEqual(Path(reader.file), target)
            with target.open('a', encoding='utf-8') as output:
                output.write(json.dumps({'type': 'event_msg', 'payload': {'type': 'agent_message', 'message': 'NEW_REPLY'}}) + '\n')
            reader.poll(force=True)
            self.assertEqual([row['row']['payload']['message'] for row in rows], ['NEW_REPLY'])

    def test_session_metadata_contains_identifiers_but_no_private_payload(self):
        row = module.public_row('codex', {'type': 'session_meta', 'payload': {'id': 'owned', 'originator': 'fixture', 'secret': 'PRIVATE'}})
        self.assertEqual(row['payload'], {'id': 'owned', 'originator': 'fixture'})
        self.assertNotIn('PRIVATE', json.dumps(row))


if __name__ == '__main__':
    unittest.main()
