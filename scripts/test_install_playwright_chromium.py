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
if [ "${1:-}" = --version ]; then
  echo 'timeout (GNU coreutils) 9.7'
  exit 0
fi
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
        self.binary_directory = binary_directory
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
            'TIMEOUT_COMMAND': str(binary_directory / 'timeout'),
            'GITHUB_OUTPUT': str(self.root / 'outputs'),
        }

    def run_step(self, name='Install Chromium system dependencies', **statuses):
        environment = {**self.environment, **{key: str(value) for key, value in statuses.items()}}
        result = subprocess.run(
            ['/bin/bash', '-e', '-o', 'pipefail', '-c', step_script(name)],
            env=environment, capture_output=True, text=True, timeout=5,
        )
        calls = self.log.read_text().splitlines() if self.log.exists() else []
        return result, calls

    def test_prefers_gnutimeout_when_both_implementations_are_present(self):
        gnutimeout = self.binary_directory / 'gnutimeout'
        gnutimeout.write_text('#!/bin/bash\necho "timeout (GNU coreutils) 9.7"\n')
        gnutimeout.chmod(0o755)
        (self.binary_directory / 'timeout').write_text('#!/bin/bash\necho "timeout (uutils coreutils) 0.10.0"\n')
        result, _ = self.run_step('Resolve GNU timeout', PATH=self.binary_directory)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.root / 'outputs').read_text(), f'command={gnutimeout}\n')

    def test_uses_validated_timeout_when_gnutimeout_is_absent(self):
        result, _ = self.run_step('Resolve GNU timeout', PATH=self.binary_directory)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.root / 'outputs').read_text(), f'command={self.binary_directory / "timeout"}\n')

    def test_rejects_non_gnu_timeout_before_any_install(self):
        (self.binary_directory / 'timeout').write_text('#!/bin/bash\necho "timeout (uutils coreutils) 0.10.0"\n')
        result, calls = self.run_step('Resolve GNU timeout', PATH=self.binary_directory)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Install GNU coreutils', result.stdout)
        self.assertFalse((self.root / 'outputs').exists())
        self.assertEqual(calls, [])

    def test_rejects_missing_timeout_before_any_install(self):
        (self.binary_directory / 'timeout').unlink()
        result, calls = self.run_step('Resolve GNU timeout', PATH=self.binary_directory)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('GNU coreutils timeout is required', result.stdout)
        self.assertFalse((self.root / 'outputs').exists())
        self.assertEqual(calls, [])

    def test_install_steps_use_resolved_timeout(self):
        source = ACTION.read_text()
        bindings = (
            ('Resolve GNU timeout', '      id: timeout'),
            ('Download Chromium', '        TIMEOUT_COMMAND: ${{ steps.timeout.outputs.command }}'),
            ('Install Chromium system dependencies', '        TIMEOUT_COMMAND: ${{ steps.timeout.outputs.command }}'),
        )
        for name, binding in bindings:
            with self.subTest(step=name):
                block = source.split(f'    - name: {name}\n', 1)[1].split('\n    - name:', 1)[0]
                self.assertIn(binding, block)

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


@unittest.skipUnless(sys.platform.startswith('linux') and (shutil.which('timeout') or shutil.which('gnutimeout')), 'GNU timeout process groups require Linux')
class TimeoutProcessGroupTests(unittest.TestCase):
    def test_action_deadlines_kill_term_resistant_child(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'outputs'
            resolved = subprocess.run(
                ['bash', '-e', '-c', step_script('Resolve GNU timeout')],
                env={**os.environ, 'GITHUB_OUTPUT': str(output)},
                capture_output=True, text=True, timeout=5,
            )
            self.assertEqual(resolved.returncode, 0, resolved.stdout + resolved.stderr)
            timeout_command = output.read_text().strip().removeprefix('command=')
        # Keep the action's actual option order, shortening only its durations.
        commands = (
            ('Download Chromium', r'"\$TIMEOUT_COMMAND" (.+?) npx playwright install chromium'),
            ('Install Chromium system dependencies', r'"\$TIMEOUT_COMMAND" (.+?) npx playwright install-deps chromium'),
            ('Install Chromium system dependencies', r'"\$TIMEOUT_COMMAND" (.+?) dpkg --configure -a'),
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
                            [timeout_command, *options, 'bash', '-c', parent_script, 'bash', 'sh', '-c', child],
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
