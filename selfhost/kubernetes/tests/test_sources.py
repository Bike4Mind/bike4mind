import pathlib
import unittest
import yaml

CHART = pathlib.Path(__file__).resolve().parents[1]
ROOT = CHART.parents[1]

class SourceContracts(unittest.TestCase):
    def test_elasticmq_config_matches_authoritative_root(self):
        self.assertEqual((CHART / 'files/elasticmq.conf').read_text(), (ROOT / 'elasticmq.conf').read_text())

    def test_all_active_queue_and_bucket_keys_match_example(self):
        expected = {}
        for line in (ROOT / '.env.selfhost.example').read_text().splitlines():
            if line and not line.startswith('#') and '=' in line:
                key, value = line.split('=', 1)
                if value and ('QUEUE' in key or key.endswith('_BUCKET')):
                    expected[key] = value.replace('http://sqs:9324', 'http://{{ .Release.Name }}-sqs:9324')
        defaults = yaml.safe_load((CHART / 'files/default-env.yaml').read_text())
        actual = {key: value for key, value in defaults.items() if 'QUEUE' in key or key.endswith('_BUCKET')}
        self.assertEqual(actual, expected)

if __name__ == '__main__':
    unittest.main()
