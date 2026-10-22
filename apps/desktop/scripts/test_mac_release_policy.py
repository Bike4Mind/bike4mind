import unittest
import os
from pathlib import Path
import subprocess
import sys
import tempfile

from mac_release_policy import signing_mode


class MacReleasePolicyTest(unittest.TestCase):
    def test_explicit_allow_paths_and_signed_precedence(self):
        self.assertEqual(signing_mode('0.6.0', '', 'true'), 'adhoc')
        self.assertEqual(signing_mode('0.6.0', 'true', ''), 'signed')
        self.assertEqual(signing_mode('0.6.0', 'true', 'true'), 'signed')
        self.assertEqual(signing_mode('0.6.0-pr.12.3', '', '', True), 'adhoc')

    def test_unset_false_and_invalid_config_deny(self):
        for signing, adhoc in [('', ''), ('false', ''), ('', 'false'), ('false', 'false'),
                                ('TRUE', 'true'), ('true', 'yes'), ('', ' true'), ('', '1')]:
            with self.subTest(signing=signing, adhoc=adhoc), self.assertRaises(ValueError):
                signing_mode('0.6.0', signing, adhoc)

    def test_major_and_malformed_versions_deny_even_with_opt_in(self):
        for version in ('1.0.0', '0.06.0', '', '0.6', '0.6.0;exit'):
            with self.subTest(version=version), self.assertRaises(ValueError):
                signing_mode(version, '', 'true')

    def test_developer_id_path_is_not_capped_at_beta(self):
        self.assertEqual(signing_mode('1.0.0', 'true', ''), 'signed')
        self.assertEqual(signing_mode('1.0.0', 'true', 'true'), 'signed')
        self.assertEqual(signing_mode('1.2.0-pr.12.3', '', '', True), 'adhoc')
        for version in ('01.0.0', '1.0', '1.0.0;exit'):
            with self.subTest(version=version), self.assertRaises(ValueError):
                signing_mode(version, 'true', '')

    def test_cli_denies_configuration_drift_before_emitting_mode(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'output'
            env = {**os.environ, 'DESKTOP_VERSION': '0.6.0', 'SIGNING': '',
                   'ADHOC_BETA': 'true', 'GITHUB_EVENT_NAME': 'push',
                   'EXPECTED_MAC_MODE': 'signed', 'GITHUB_OUTPUT': str(output)}
            script = str(Path(__file__).with_name('mac_release_policy.py'))
            result = subprocess.run([sys.executable, script], env=env, capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(output.exists())
            env['EXPECTED_MAC_MODE'] = 'adhoc'
            subprocess.run([sys.executable, script], env=env, check=True, capture_output=True)
            self.assertEqual(output.read_text(), 'mode=adhoc\n')
