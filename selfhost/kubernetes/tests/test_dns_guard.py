import os
import pathlib
import subprocess
import shutil
import sys
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).resolve().parents[1] / 'files/mongo-dns-guard.sh'

class DnsGuardTests(unittest.TestCase):
    def run_guard(self, answer, ip='192.0.2.10', seconds='3'):
        with tempfile.TemporaryDirectory() as directory:
            # Control only the resolver response; all deadline and matching logic runs unchanged.
            resolver = pathlib.Path(directory) / 'getent'
            resolver.write_text('#!/bin/sh\nprintf "%s\\n" "$DNS_TEST_ANSWER"\n')
            resolver.chmod(0o755)
            if shutil.which('timeout') is None:
                deadline = pathlib.Path(directory) / 'timeout'
                deadline.write_text('#!' + sys.executable + '\nimport subprocess, sys\ntry:\n sys.exit(subprocess.run(sys.argv[2:], timeout=float(sys.argv[1])).returncode)\nexcept subprocess.TimeoutExpired:\n sys.exit(124)\n')
                deadline.chmod(0o755)
            env = dict(os.environ, PATH=directory + ':' + os.environ['PATH'], POD_IP=ip, MEMBER_DNS='mongo-0.mongo', DNS_GUARD_SECONDS=seconds, DNS_TEST_ANSWER=answer)
            return subprocess.run(['/bin/sh', str(SCRIPT)], env=env, capture_output=True, text=True, timeout=8)

    def test_missing_dns_never_admits_member(self):
        self.assertEqual(self.run_guard('').returncode, 1)

    def test_stale_dns_never_admits_member(self):
        self.assertEqual(self.run_guard('192.0.2.11 STREAM mongo').returncode, 1)

    def test_current_ip_with_duplicate_socket_records_admits_member(self):
        result = self.run_guard('192.0.2.10 STREAM mongo\n192.0.2.10 DGRAM mongo\n192.0.2.10 RAW mongo')
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_mixed_stale_and_current_answers_fail_closed(self):
        self.assertEqual(self.run_guard('192.0.2.10 STREAM mongo\n192.0.2.11 STREAM mongo').returncode, 1)

    def test_ipv6_records(self):
        result = self.run_guard('2001:db8::10 STREAM mongo\n2001:db8::10 DGRAM mongo', ip='2001:db8::10')
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_invalid_budget_is_rejected(self):
        self.assertEqual(self.run_guard('', seconds='unbounded').returncode, 2)

if __name__ == '__main__':
    unittest.main()
