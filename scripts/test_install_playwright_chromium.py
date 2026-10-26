#!/usr/bin/env python3
"""Exercise the composite action's real shell scripts without apt or browsers."""

import os
from pathlib import Path
import re
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest


ACTION = Path(__file__).resolve().parents[1] / '.github/actions/install-playwright-chromium/action.yml'


def step_script(name):
    """Read a named step's inline or literal run value using YAML indentation."""
    lines = ACTION.read_text().splitlines()
    marker = f'    - name: {name}'
    start = lines.index(marker) + 1
    for index in range(start, len(lines)):
        line = lines[index]
        if line.startswith('    - '):
            break
        if not line.startswith('      run: '):
            continue
        value = line.removeprefix('      run: ')
        if value != '|':
            return value + '\n'
        body = []
        for body_line in lines[index + 1:]:
            if body_line.strip() and not body_line.startswith('        '):
                break
            body.append(body_line[8:] if body_line.strip() else '')
        return '\n'.join(body) + '\n'
    raise AssertionError(f'No run script in step {name!r}')


STUBS = {
    'sudo': 'export SUDO_ACTIVE=1\nexec "$@"\n',
    'tee': '''
[ "$#" -eq 1 ] && [ "$1" = /etc/apt/apt.conf.d/80-ci-timeouts ] || exit 90
cat > "$APT_CONFIG"
cat "$APT_CONFIG"
''',
    'timeout': '''
printf 'timeout %s\\n' "$*" >> "$CALL_LOG"
[ "$1" = --signal=KILL ] || exit 91
shift
case "$1" in
  5m) shift ;;
  1m) shift ;;
  *) exit 92 ;;
esac
if [ "$1" = dpkg ] && [ "$RECOVERY_TIMEOUT" -ne 0 ]; then
  exit "$RECOVERY_TIMEOUT"
fi
exec "$@"
''',
    'npx': '''
printf 'npx %s\\n' "$*" >> "$CALL_LOG"
case "$*" in
  'playwright install-deps chromium') [ "${SUDO_ACTIVE:-0}" = 1 ] || exit 97; exit "$DEPS_STATUS" ;;
  'playwright install chromium') exit "$DOWNLOAD_STATUS" ;;
  *) exit 93 ;;
esac
''',
    'dpkg': '''
printf 'dpkg %s\\n' "$*" >> "$CALL_LOG"
[ "$*" = '--configure -a' ] || exit 94
[ "${SUDO_ACTIVE:-0}" = 1 ] || exit 97
exit "$RECOVERY_STATUS"
''',
    'node': '''
printf 'node %s\\n' "$*" >> "$CALL_LOG"
[ "$1" = -e ] || exit 95
case "$2" in
  *"chromium.launch()"*"b.close()"*) exit "$LAUNCH_STATUS" ;;
  *) exit 96 ;;
esac
''',
}


class ChromiumActionTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.log = self.root / 'calls'
        self.config = self.root / 'apt-config'
        binary_directory = self.root / 'bin'
        binary_directory.mkdir()
        for name, body in STUBS.items():
            executable = binary_directory / name
            executable.write_text('#!/bin/bash\nset -eu\n' + body)
            executable.chmod(0o755)
        self.environment = {
            **os.environ,
            'PATH': str(binary_directory) + os.pathsep + os.environ['PATH'],
            'CALL_LOG': str(self.log),
            'APT_CONFIG': str(self.config),
            'DEPS_STATUS': '0',
            'DOWNLOAD_STATUS': '0',
            'RECOVERY_STATUS': '0',
            'RECOVERY_TIMEOUT': '0',
            'LAUNCH_STATUS': '0',
        }

    def run_step(self, name='Install Chromium system dependencies', **statuses):
        environment = {**self.environment, **{key: str(value) for key, value in statuses.items()}}
        result = subprocess.run(
            ['bash', '-e', '-o', 'pipefail', '-c', step_script(name)],
            env=environment, capture_output=True, text=True, timeout=5,
        )
        calls = self.log.read_text().splitlines() if self.log.exists() else []
        return result, calls

    def test_dependency_success_writes_real_apt_lines_and_skips_recovery(self):
        result, calls = self.run_step()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.config.read_text(), (
            'Acquire::Retries "3";\n'
            'Acquire::http::Timeout "20";\n'
            'Acquire::https::Timeout "20";\n'
        ))
        self.assertEqual(calls, [
            'timeout --signal=KILL 5m npx playwright install-deps chromium',
            'npx playwright install-deps chromium',
        ])

    @unittest.skipUnless(shutil.which('apt-config'), 'apt-config is unavailable')
    def test_apt_accepts_emitted_configuration(self):
        result, _ = self.run_step()
        self.assertEqual(result.returncode, 0, result.stderr)
        parsed = subprocess.run(
            ['apt-config', '-c', str(self.config), 'shell',
             'retries', 'Acquire::Retries',
             'http', 'Acquire::http::Timeout',
             'https', 'Acquire::https::Timeout'],
            capture_output=True, text=True, timeout=5,
        )
        self.assertEqual(parsed.returncode, 0, parsed.stderr)
        self.assertEqual(parsed.stdout.splitlines(), [
            "retries='3'", "http='20'", "https='20'",
        ])

    def test_dependency_failure_recovers_before_launch(self):
        for status in (100, 124, 137):
            with self.subTest(status=status):
                self.log.unlink(missing_ok=True)
                result, calls = self.run_step(DEPS_STATUS=status)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(f'exit {status}', result.stdout)
                self.assertEqual(calls[:4], [
                    'timeout --signal=KILL 5m npx playwright install-deps chromium',
                    'npx playwright install-deps chromium',
                    'timeout --signal=KILL 1m dpkg --configure -a',
                    'dpkg --configure -a',
                ])
                self.assertEqual(len(calls), 5)
                self.assertTrue(calls[4].startswith('node -e '), calls)

    def test_recovery_failure_stops_before_launch(self):
        result, calls = self.run_step(DEPS_STATUS=100, RECOVERY_STATUS=2)
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn('dpkg --configure -a', calls)
        self.assertFalse(any(call.startswith('node ') for call in calls), calls)

    def test_recovery_timeout_stops_before_launch(self):
        for status in (124, 137):
            with self.subTest(status=status):
                self.log.unlink(missing_ok=True)
                result, calls = self.run_step(DEPS_STATUS=124, RECOVERY_TIMEOUT=status)
                self.assertEqual(result.returncode, status, result.stderr)
                self.assertIn('timeout --signal=KILL 1m dpkg --configure -a', calls)
                self.assertFalse(any(call.startswith('node ') for call in calls), calls)

    def test_launch_failure_fails_step(self):
        result, calls = self.run_step(DEPS_STATUS=100, LAUNCH_STATUS=1)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertTrue(calls[-1].startswith('node -e '), calls)

    def test_download_uses_hard_deadline_and_propagates_failure(self):
        for status in (0, 1, 124, 137):
            with self.subTest(status=status):
                self.log.unlink(missing_ok=True)
                result, calls = self.run_step('Download Chromium', DOWNLOAD_STATUS=status)
                self.assertEqual(result.returncode, status, result.stderr)
                self.assertEqual(calls, [
                    'timeout --signal=KILL 5m npx playwright install chromium',
                    'npx playwright install chromium',
                ])


def live_state_after(pid, grace=5.0):
    """Return the pid's /proc state if it is still alive after the grace period, else None.

    timeout's group SIGKILL only marks the child; on a loaded runner it can still
    read 'R' when timeout exits, until the scheduler lets it run do_exit.
    """
    stop = time.monotonic() + grace
    while True:
        try:
            state = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()[0]
        except (FileNotFoundError, ProcessLookupError):
            return None  # Already reaped.
        if state in ('Z', 'X'):
            return None
        if time.monotonic() >= stop:
            return state
        time.sleep(0.01)


@unittest.skipUnless(sys.platform.startswith('linux') and shutil.which('timeout'), 'GNU timeout requires Linux')
class TimeoutProcessGroupTests(unittest.TestCase):
    def test_action_deadlines_kill_term_resistant_child(self):
        # Keep the action's actual option order, shortening only its durations.
        commands = (
            ('Download Chromium', r'timeout (.+?) npx playwright install chromium'),
            ('Install Chromium system dependencies', r'timeout (.+?) npx playwright install-deps chromium'),
            ('Install Chromium system dependencies', r'timeout (.+?) dpkg --configure -a'),
        )
        for step, pattern in commands:
            with self.subTest(step=step, pattern=pattern):
                match = re.search(pattern, step_script(step))
                self.assertIsNotNone(match)
                options = shlex.split(match.group(1))
                options = ['0.5s' if option in ('5m', '1m') else option for option in options]
                for parent_script in ('"$@" & wait', 'trap "" TERM; "$@" & wait'):
                    with tempfile.TemporaryDirectory() as directory:
                        pid_file = Path(directory) / 'child-pid'
                        # sh starts well inside the 0.5s deadline on a loaded runner; SIG_IGN survives the exec.
                        pid_tmp = shlex.quote(f'{pid_file}.tmp')
                        child = f'trap "" TERM; echo $$ > {pid_tmp}; mv {pid_tmp} {shlex.quote(str(pid_file))}; exec sleep 20'
                        process = subprocess.Popen(
                            ['timeout', *options, 'bash', '-c', parent_script, 'bash', 'sh', '-c', child],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True,
                        )
                        try:
                            process.communicate(timeout=3)
                            self.assertIn(process.returncode, (-signal.SIGKILL, 137))
                            self.assertTrue(pid_file.exists(), 'child did not start')
                            child_pid = int(pid_file.read_text())
                            self.assertIsNone(live_state_after(child_pid), 'child survived hard deadline')
                        finally:
                            try:
                                os.killpg(process.pid, signal.SIGKILL)
                            except ProcessLookupError:
                                pass
                            process.communicate()


if __name__ == '__main__':
    unittest.main()
