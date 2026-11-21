"""Regression tests for quota normalization without invoking a model or Docker."""
import importlib.util
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('relay_usage', Path(__file__).resolve().parents[1] / 'server/read-usage.py')
usage = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(usage)


class UsageTests(unittest.TestCase):
    def test_fable_percentage_is_its_own_bucket_not_added_to_weekly(self):
        result = usage.normalize_claude_usage({'rate_limits': {
            'five_hour': {'utilization': 0, 'resets_at': '2026-11-14T13:50:00+00:00'},
            'seven_day': {'utilization': 46, 'resets_at': '2026-11-18T15:00:00+00:00'},
            'model_scoped': [{'display_name': 'Fable', 'utilization': 3, 'resets_at': '2026-11-18T15:00:00+00:00'}],
            'private_account_metadata': {'token': 'fixture-secret'},
        }}, 1000)
        windows = {item['id']: item for item in result['windows']}
        self.assertEqual(windows['five_hour']['usedPercent'], 0)
        self.assertEqual(windows['seven_day']['usedPercent'], 46)
        self.assertEqual(windows['model:fable']['usedPercent'], 3)
        self.assertEqual(100 - windows['model:fable']['usedPercent'], 97)
        self.assertIsInstance(windows['model:fable']['resetsAt'], float)
        self.assertNotIn('fixture-secret', json.dumps(result))

    def test_missing_or_invalid_scoped_windows_do_not_become_full_quota(self):
        result = usage.normalize_claude_usage({'rate_limits': {'five_hour': {'utilization': 18},
            'model_scoped': [{'display_name': 'Fable', 'utilization': None}, {'display_name': 'Other', 'utilization': float('nan')}, {'display_name': 'Invalid', 'utilization': True}]}}, 1000)
        self.assertEqual([item['id'] for item in result['windows']], ['five_hour'])

    def test_fresh_cache_avoids_another_cli_process(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(usage, 'ROOT', Path(temporary)):
            state = Path(temporary) / 'claude'
            state.mkdir()
            cached = usage.normalize_claude_usage({'rate_limits': {'model_scoped': [{'display_name': 'Fable', 'utilization': 3}]}}, 1000)
            (state / 'relay-account-usage.json').write_text(json.dumps(cached))
            with patch.object(usage.time, 'time', return_value=1050), patch.object(usage, 'query_claude_usage') as query:
                self.assertEqual(usage.read_claude()['windows'][0]['usedPercent'], 3)
                query.assert_not_called()

    def test_query_failure_preserves_last_fable_measurement(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(usage, 'ROOT', Path(temporary)):
            state = Path(temporary) / 'claude'
            state.mkdir()
            cached = usage.normalize_claude_usage({'rate_limits': {'model_scoped': [{'display_name': 'Fable', 'utilization': 3}]}}, 1000)
            (state / 'relay-account-usage.json').write_text(json.dumps(cached))
            fake_lock = types.SimpleNamespace(LOCK_EX=1, LOCK_NB=2, flock=lambda *_args: None)
            with patch.dict('sys.modules', {'fcntl': fake_lock}), patch.object(usage.time, 'time', return_value=2000), patch.object(usage.Path, 'read_text', autospec=True) as read_text, patch.object(usage, 'query_claude_usage', side_effect=ValueError('Unavailable')):
                def read_file(filename, *_args, **_kwargs):
                    if str(filename).replace('\\', '/') == '/proc/meminfo':
                        return 'MemAvailable: 2097152 kB\n'
                    with open(filename, encoding='utf-8') as source:
                        return source.read()
                read_text.side_effect = read_file
                result = usage.read_claude()
                self.assertEqual(result['windows'][0]['usedPercent'], 3)
                self.assertEqual(result['reason'], 'query_failed')
                self.assertTrue(result['cached'])


if __name__ == '__main__':
    unittest.main()
