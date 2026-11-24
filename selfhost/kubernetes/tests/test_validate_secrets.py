import os
import pathlib
import shutil
import subprocess
import unittest

SCRIPT = pathlib.Path(__file__).resolve().parents[1] / 'files' / 'validate-secrets.cjs'
KEY = 'a' * 64
FLAG = '--allow-plaintext-opt-out'


@unittest.skipUnless(shutil.which('node'), 'node is required')
class ValidateSecretsTests(unittest.TestCase):
    def run_script(self, env=None, flag=False):
        clean = {'PATH': os.environ['PATH']}
        clean.update(env or {})
        return subprocess.run(['node', str(SCRIPT)] + ([FLAG] if flag else []), env=clean, text=True, capture_output=True)

    def test_valid_current_key_passes(self):
        for key in (KEY, '0123456789ABCDEF' * 4, '0123456789abcdef' * 4):
            self.assertEqual(self.run_script({'SECRET_ENCRYPTION_KEY': key}).returncode, 0)

    def test_bad_current_key_fails_without_echoing_value(self):
        for key in (None, '', 'change-me-openssl-rand-hex-32', 'a' * 63, 'a' * 65, 'g' + 'a' * 63):
            result = self.run_script({} if key is None else {'SECRET_ENCRYPTION_KEY': key}, flag=True)
            self.assertEqual(result.returncode, 1, key)
            self.assertIn('SECRET_ENCRYPTION_KEY', result.stderr)
            self.assertIn('64 hexadecimal', result.stderr)
            if key:
                self.assertNotIn(key, result.stderr)

    def test_opt_out_with_placeholder_key_passes_loudly(self):
        result = self.run_script({'B4M_ALLOW_PLAINTEXT_SECRETS': 'true', 'SECRET_ENCRYPTION_KEY': 'change-me-openssl-rand-hex-32'}, flag=True)
        self.assertEqual(result.returncode, 0)
        self.assertIn('WARNING', result.stderr)
        self.assertIn('PLAINTEXT', result.stderr)

    def test_opt_out_with_empty_or_unset_key_fails(self):
        for env in ({'B4M_ALLOW_PLAINTEXT_SECRETS': 'true'}, {'B4M_ALLOW_PLAINTEXT_SECRETS': 'true', 'SECRET_ENCRYPTION_KEY': ''}):
            result = self.run_script(env, flag=True)
            self.assertEqual(result.returncode, 1, env)
            self.assertIn('SECRET_ENCRYPTION_KEY is empty', result.stderr)
            self.assertIn('change-me-openssl-rand-hex-32', result.stderr)

    def test_opt_out_hint_only_when_flag_passed(self):
        with_flag = self.run_script({'SECRET_ENCRYPTION_KEY': 'x'}, flag=True)
        self.assertIn('B4M_ALLOW_PLAINTEXT_SECRETS', with_flag.stderr)
        strict = self.run_script({'SECRET_ENCRYPTION_KEY': 'x'})
        self.assertEqual(strict.returncode, 1)
        self.assertNotIn('B4M_ALLOW_PLAINTEXT_SECRETS', strict.stderr)

    def test_opt_out_needs_the_flag(self):
        env = {'SECRET_ENCRYPTION_KEY': 'change-me-openssl-rand-hex-32', 'B4M_ALLOW_PLAINTEXT_SECRETS': 'true'}
        self.assertEqual(self.run_script(env).returncode, 1)
        self.assertEqual(self.run_script(env, flag=True).returncode, 0)

    def test_opt_out_must_be_exactly_true(self):
        for value in ('1', 'TRUE', 'yes', 'false'):
            self.assertEqual(self.run_script({'B4M_ALLOW_PLAINTEXT_SECRETS': value}, flag=True).returncode, 1, value)

    def test_previous_key_accepted_forms(self):
        for previous in (None, '', 'not-configured', 'B' * 64):
            env = {'SECRET_ENCRYPTION_KEY': KEY}
            if previous is not None:
                env['SECRET_ENCRYPTION_KEY_PREVIOUS'] = previous
            self.assertEqual(self.run_script(env).returncode, 0, previous)

    def test_malformed_previous_key_fails_even_with_opt_out(self):
        for previous in ('b' * 63, 'z' * 64, 'change-me'):
            for env in ({'SECRET_ENCRYPTION_KEY': KEY}, {'B4M_ALLOW_PLAINTEXT_SECRETS': 'true', 'SECRET_ENCRYPTION_KEY': 'unset-placeholder'}):
                for flag in (False, True):
                    result = self.run_script({**env, 'SECRET_ENCRYPTION_KEY_PREVIOUS': previous}, flag=flag)
                    self.assertEqual(result.returncode, 1, (previous, env, flag))
                    self.assertIn('SECRET_ENCRYPTION_KEY_PREVIOUS', result.stderr)
                    self.assertNotIn(previous, result.stderr)

    def test_reports_both_errors_in_one_pass(self):
        result = self.run_script({'SECRET_ENCRYPTION_KEY': 'x', 'SECRET_ENCRYPTION_KEY_PREVIOUS': 'y'})
        self.assertIn('SECRET_ENCRYPTION_KEY must', result.stderr)
        self.assertIn('SECRET_ENCRYPTION_KEY_PREVIOUS must', result.stderr)


if __name__ == '__main__':
    unittest.main()
