import importlib.util
from pathlib import Path
import unittest


class ProxyPolicyTests(unittest.TestCase):
    def test_remote_tasks_and_model_catalogs_apply_the_same_policy(self):
        root = Path(__file__).resolve().parents[1]
        for filename in ('desktop/workbench/run-agent.py', 'server/read-model-catalog.py'):
            spec = importlib.util.spec_from_file_location('proxy_fixture', root / filename)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            original = {'HTTP_PROXY': 'http://old.example:9000', 'NO_PROXY': 'example.test'}
            self.assertEqual(module.proxy_environment(original, {'mode': 'system'}), original)
            direct = module.proxy_environment(original, {'mode': 'direct'})
            self.assertNotIn('HTTP_PROXY', direct)
            self.assertEqual(direct['NO_PROXY'], '*')
            custom = module.proxy_environment(original, {'mode': 'custom', 'url': 'http://127.0.0.1:8888'})
            self.assertEqual(custom['HTTPS_PROXY'], 'http://127.0.0.1:8888')
            self.assertIn('127.0.0.1', custom['NO_PROXY'])
            self.assertEqual(original['HTTP_PROXY'], 'http://old.example:9000')
            with self.assertRaises(ValueError):
                module.proxy_environment(original, {'mode': 'custom', 'url': 'http://user:password@example.test'})


if __name__ == '__main__':
    unittest.main()
