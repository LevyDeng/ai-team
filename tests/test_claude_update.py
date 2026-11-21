"""Exercise image-promotion invariants with a fake Docker backend."""
import importlib.util
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('relay_claude_update', Path(__file__).resolve().parents[1] / 'server/manage-claude-version.py')
update = importlib.util.module_from_spec(SPEC)
with patch.dict('sys.modules', {'fcntl': types.SimpleNamespace(LOCK_EX=1, LOCK_NB=2, flock=lambda *_args: None)}):
    SPEC.loader.exec_module(update)


class UpdateTests(unittest.TestCase):
    def run_worker(self, operation='update', prepare_error=None, changed_image=False):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        directory = Path(temporary.name)
        patcher = patch.object(update, 'DIRECTORY', directory)
        patcher.start()
        self.addCleanup(patcher.stop)
        job = {'state': 'running', 'jobId': 'fixture', 'operation': operation, 'target': '2.1.325', 'latest': '2.1.325', 'installed': '2.1.308'}
        update.atomic(directory / 'status.json', job)
        calls = []
        inspections = 0

        def info(tag):
            nonlocal inspections
            if tag == update.CURRENT:
                inspections += 1
                return {'id': 'sha256:changed' if changed_image and inspections > 1 else 'sha256:current'}
            if tag == update.PREVIOUS:
                return {'id': 'sha256:previous'}
            return None

        def docker(args, **_kwargs):
            calls.append(args)
            return types.SimpleNamespace(returncode=0, stdout='')

        def prepare(_target, _source, _phase):
            if prepare_error:
                raise update.UpdateError(prepare_error)
            return 'windows-mcp-claude:candidate-fixture'

        with patch.object(update, 'image_info', side_effect=info), patch.object(update, 'image_version', return_value='2.1.308'), patch.object(update, 'prepare', side_effect=prepare), patch.object(update, 'docker', side_effect=docker):
            update.worker('fixture')
        return update.read('status.json'), calls

    def test_prepare_does_not_replace_the_live_image(self):
        result, calls = self.run_worker('prepare')
        self.assertEqual(result['reason'], 'prepared')
        self.assertFalse(any(args[0] == 'tag' for args in calls))

    def test_verified_candidate_preserves_previous_before_switch(self):
        result, calls = self.run_worker()
        self.assertEqual(result['state'], 'complete')
        tags = [args for args in calls if args[0] == 'tag']
        self.assertEqual(tags[0], ['tag', 'sha256:current', update.PREVIOUS])
        self.assertEqual(tags[1][-1], update.CURRENT)
        self.assertFalse(any(args[0] in ('stop', 'kill') for args in calls))

    def test_failed_verification_or_external_change_preserves_live_tag(self):
        result, calls = self.run_worker(prepare_error='protocol_verification_failed')
        self.assertEqual(result['state'], 'failed')
        self.assertFalse(any(args[0] == 'tag' for args in calls))
        result, calls = self.run_worker(changed_image=True)
        self.assertEqual(result['reason'], 'image_changed')
        self.assertFalse(any(args[0] == 'tag' for args in calls))

    def test_rollback_swaps_image_references_without_touching_user_volumes(self):
        result, calls = self.run_worker('rollback')
        self.assertEqual(result['reason'], 'rolled_back')
        self.assertIn(['tag', 'sha256:previous', update.CURRENT], calls)
        self.assertFalse(any('volume' in args or '--mount' in args for args in calls))


if __name__ == '__main__':
    unittest.main()
