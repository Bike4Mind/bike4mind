import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

import selfhost_backup as sb

URI = 'mongodb://root:s3cret@mongo:27017/bike4mind?replicaSet=rs0&authSource=admin'
MINIO_PASSWORD = 'minio-pass-xyz'
COMPOSE_FILE = Path(__file__).resolve().parent.parent / 'compose.selfhost.yaml'


def config(**overrides):
    env = {key: 'b-' + key.lower() for key in sb.BUCKET_KEYS}
    env.update(MINIO_ROOT_PASSWORD=MINIO_PASSWORD)
    env.update(overrides)
    return {'services': {'createbuckets': {'environment': env},
                         'app': {'environment': {'MONGODB_URI': URI,
                                                 'AWS_ENDPOINT_URL_S3': 'http://minio:9000'}}}}


class ResolveTargets(unittest.TestCase):
    def test_reads_all_seven_buckets_and_uri(self):
        uri, buckets = sb.resolve_targets(config())
        self.assertEqual(uri, URI)
        self.assertEqual(len(buckets), 7)
        self.assertEqual(buckets['FAB_FILE_BUCKET'], 'b-fab_file_bucket')

    def test_empty_bucket_fails(self):
        with self.assertRaisesRegex(ValueError, 'SLACK_EXPORT_BUCKET'):
            sb.resolve_targets(config(SLACK_EXPORT_BUCKET=''))

    def test_missing_uri_fails(self):
        cfg = config()
        cfg['services']['app']['environment'] = {}
        with self.assertRaisesRegex(ValueError, 'MONGODB_URI'):
            sb.resolve_targets(cfg)


    def test_external_mongo_refused(self):
        cfg = config()
        cfg['services']['app']['environment']['MONGODB_URI'] = 'mongodb+srv://u:p@cluster0.example.net/db'
        with self.assertRaisesRegex(ValueError, 'MONGODB_URI'):
            sb.resolve_targets(cfg)

    def test_external_mongo_host_in_list_refused(self):
        cfg = config()
        cfg['services']['app']['environment']['MONGODB_URI'] = 'mongodb://mongo:27017,other:27017/db'
        with self.assertRaisesRegex(ValueError, 'MONGODB_URI'):
            sb.resolve_targets(cfg)

    def test_lookalike_hosts_refused(self):
        for uri in ('mongodb://mongo.example.net:27017/db', 'mongodb://mongo-replica:27017/db',
                    'mongodb://mongo:27017,mongo2:27017/db'):
            cfg = config()
            cfg['services']['app']['environment']['MONGODB_URI'] = uri
            with self.assertRaisesRegex(ValueError, 'MONGODB_URI', msg=uri):
                sb.resolve_targets(cfg)
        for endpoint in ('https://minio.example.com', 'http://minio-2:9000', 'http://example.com/minio'):
            cfg = config()
            cfg['services']['app']['environment']['AWS_ENDPOINT_URL_S3'] = endpoint
            with self.assertRaisesRegex(ValueError, 'AWS_ENDPOINT_URL_S3', msg=endpoint):
                sb.resolve_targets(cfg)

    def test_external_object_storage_refused(self):
        cfg = config()
        cfg['services']['app']['environment']['AWS_ENDPOINT_URL_S3'] = 'https://s3.example.net'
        with self.assertRaisesRegex(ValueError, 'AWS_ENDPOINT_URL_S3'):
            sb.resolve_targets(cfg)

    def test_unset_object_storage_endpoint_refused(self):
        cfg = config()
        del cfg['services']['app']['environment']['AWS_ENDPOINT_URL_S3']
        with self.assertRaisesRegex(ValueError, 'AWS_ENDPOINT_URL_S3'):
            sb.resolve_targets(cfg)

    def test_bucket_keys_match_compose_createbuckets(self):
        text = COMPOSE_FILE.read_text()
        loop = re.search(r'for b in ((?:"\$\$\w+_BUCKET" ?)+); do', text).group(1)
        self.assertEqual(re.findall(r'\$\$(\w+_BUCKET)', loop), sb.BUCKET_KEYS)


class Commands(unittest.TestCase):
    compose = ['docker', 'compose', '-p', 'x']

    def test_instance_uri_drops_database_but_keeps_query(self):
        self.assertEqual(sb.instance_uri(URI), 'mongodb://root:s3cret@mongo:27017/?replicaSet=rs0&authSource=admin')

    def test_instance_uri_keeps_path_database_as_auth_source(self):
        self.assertEqual(sb.instance_uri('mongodb://app:pw@mongo:27017/bike4mind?replicaSet=rs0'),
                         'mongodb://app:pw@mongo:27017/?replicaSet=rs0&authSource=bike4mind')
        self.assertEqual(sb.instance_uri('mongodb://mongo:27017/bike4mind?replicaSet=rs0'),
                         'mongodb://mongo:27017/?replicaSet=rs0')

    def test_dump_and_restore_flags(self):
        self.assertIn('--oplog', sb.mongodump_cmd(self.compose)[-1])
        self.assertNotIn('--quiet', sb.mongodump_cmd(self.compose)[-1])
        self.assertNotIn('--quiet', sb.mongorestore_cmd(self.compose)[-1])

    def test_mongorestore_never_drops(self):
        cmd = sb.mongorestore_cmd(self.compose)[-1]
        self.assertIn('--oplogReplay', cmd)
        self.assertNotIn('--drop', cmd)

    def test_user_db_commands_skip_exactly_the_system_databases(self):
        for cmd in (sb.mongo_user_dbs_cmd(self.compose), sb.mongo_drop_dbs_cmd(self.compose)):
            self.assertIn('!["admin", "config", "local"].includes(n)', cmd[-1])
        self.assertIn(DROP_ACTION, sb.mongo_drop_dbs_cmd(self.compose)[-1])
        self.assertIn('const names = m.getDBNames().filter(', sb.mongo_drop_dbs_cmd(self.compose)[-1])
        self.assertNotIn('dropDatabase', sb.mongo_user_dbs_cmd(self.compose)[-1])

    def test_uri_never_in_container_argv(self):
        for cmd in (sb.mongodump_cmd(self.compose), sb.mongorestore_cmd(self.compose),
                    sb.mongo_user_dbs_cmd(self.compose), sb.mongo_drop_dbs_cmd(self.compose)):
            self.assertIn(sb.URI_ENV, cmd[cmd.index('-e') + 1])
            self.assertNotIn('--uri', cmd[-1])
            self.assertNotRegex(cmd[-1], r'(mongodump|mongorestore|mongosh)[^;]*\$\{?' + sb.URI_ENV)

    def test_with_config_writes_escaped_private_config_and_cleans_up(self):
        password = 'a\'b$c\\d"e%f'
        uri = f'mongodb://root:{password}@mongo:27017/'
        probe = ('probe() { ls -ld "$2" | cut -d" " -f1; cat "$2"; echo "$2"; }; '
                 + sb.with_config('probe'))
        out = subprocess.run(['/bin/sh', '-c', probe], env={**os.environ, sb.URI_ENV: uri},
                             capture_output=True, text=True, check=True).stdout.split('\n')
        mode, line, path = out[0], out[1], out[2]
        self.assertTrue(mode.startswith('-rw-------'), mode)
        self.assertEqual(line, "uri: '" + uri.replace("'", "''") + "'")
        self.assertFalse(os.path.exists(path), 'config file left behind')

    def test_load_passes_uri_by_environment_only(self):
        args = sb.parser().parse_args(['-p', 'x', 'backup', '--dest', '/d'])
        out = subprocess.CompletedProcess([], 0, stdout=json.dumps(config()))
        with mock.patch.object(sb, 'run', return_value=out):
            compose, _, env = sb.load(args)
        self.assertEqual(env[sb.URI_ENV], sb.instance_uri(URI))
        argv = ' '.join(compose + sb.mongodump_cmd(compose) + sb.mongorestore_cmd(compose)
                        + sb.mc_cmd(compose, Path('/o'), sb.mirror_script(['b'], False), False))
        self.assertNotIn('s3cret', argv)

    def test_backup_mc_runs_as_invoking_user(self):
        cmd = sb.mc_cmd(self.compose, Path('/o'), 's', False)
        self.assertEqual(cmd[cmd.index('--user') + 1], f'{os.getuid()}:{os.getgid()}')
        self.assertIn('MC_CONFIG_DIR=/tmp/.mc', cmd)
        self.assertNotIn('--user', sb.mc_cmd(self.compose, Path('/o'), 's', True))

    def test_mirror_directions_and_quoting(self):
        self.assertIn('mc mirror --quiet local/b /backup/b', sb.mirror_script(['b'], False))
        self.assertIn('mc mirror --quiet --overwrite /backup/b local/b', sb.mirror_script(['b'], True))
        self.assertIn("'a b'", sb.mirror_script(['a b'], False))
        self.assertNotIn('--remove', sb.mirror_script(['b'], True))
        self.assertIn('--overwrite --remove /backup/b local/b', sb.mirror_script(['b'], True, remove=True))

    def test_restore_mount_is_read_only(self):
        self.assertIn('/o:/backup:ro', sb.mc_cmd(self.compose, Path('/o'), 's', True))
        self.assertIn('/o:/backup', sb.mc_cmd(self.compose, Path('/o'), 's', False))


class Manifest(unittest.TestCase):
    def make_backup(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        dest = Path(tmp.name)
        (dest / sb.MONGO_ARCHIVE).write_bytes(b'dump')
        _, buckets = sb.resolve_targets(config())
        for name in buckets.values():
            (dest / 'objects' / name).mkdir(parents=True)
        (dest / 'objects' / 'b-fab_file_bucket' / 'f.bin').write_bytes(b'x')
        manifest = sb.build_manifest(dest, buckets, 't0', 't1', 'rev')
        (dest / 'manifest.json').write_text(json.dumps(manifest))
        return dest, buckets, manifest

    def test_round_trip(self):
        dest, buckets, manifest = self.make_backup()
        self.assertEqual(manifest['buckets']['b-fab_file_bucket']['objects'], 1)
        self.assertEqual(sb.check_manifest(dest, buckets), manifest)

    def test_tampered_archive_rejected(self):
        dest, buckets, _ = self.make_backup()
        (dest / sb.MONGO_ARCHIVE).write_bytes(b'tampered')
        with self.assertRaisesRegex(ValueError, 'checksum'):
            sb.check_manifest(dest, buckets)

    def test_missing_object_rejected(self):
        dest, buckets, _ = self.make_backup()
        (dest / 'objects' / 'b-fab_file_bucket' / 'f.bin').unlink()
        with self.assertRaisesRegex(ValueError, 'Object count'):
            sb.check_manifest(dest, buckets)

    def test_bucket_set_mismatch_rejected(self):
        dest, _, _ = self.make_backup()
        _, other = sb.resolve_targets(config(APP_FILES_BUCKET='renamed'))
        with self.assertRaisesRegex(ValueError, 'bucket set'):
            sb.check_manifest(dest, other)


def make_backup_dir(test):
    tmp = tempfile.TemporaryDirectory()
    test.addCleanup(tmp.cleanup)
    dest = Path(tmp.name)
    (dest / sb.MONGO_ARCHIVE).write_bytes(b'dump')
    _, buckets = sb.resolve_targets(config())
    for name in buckets.values():
        (dest / 'objects' / name).mkdir(parents=True)
    (dest / 'manifest.json').write_text(json.dumps(sb.build_manifest(dest, buckets, 't0', 't1', 'r')))
    return dest, buckets


ENV = {sb.URI_ENV: 'mongodb://root:pw@mongo:27017/'}
DROP_ACTION = 'names.forEach(n => m.getDB(n).dropDatabase())'


def assert_mongo_steps_wired(test, cmds, kwargs_list):
    """Every Mongo tool step streams redacted stderr and carries the URI in its environment."""
    seen = 0
    for cmd, kwargs in zip(cmds, kwargs_list):
        if kind(cmd) in ('mongodump', 'mongorestore', 'mongosh'):
            seen += 1
            test.assertIs(kwargs.get('redact_stderr'), True, cmd[-1])
            test.assertIn(sb.URI_ENV, kwargs.get('env') or {}, cmd[-1])
    test.assertGreater(seen, 0)


def recorder(user_dbs=''):
    calls = []
    calls_kwargs = []

    def fake_run(cmd, **kwargs):
        calls.append(cmd)
        calls_kwargs.append(kwargs)
        return subprocess.CompletedProcess(cmd, 0, stdout=user_dbs if 'mongosh' in ' '.join(cmd) else '')

    fake_run.kwargs = calls_kwargs
    return calls, fake_run


def kind(cmd):
    text = ' '.join(cmd)
    for name in ('mongorestore', 'mongodump', 'mongosh', 'mc mirror', 'createbuckets', ' up '):
        if name in text and not (name == 'createbuckets' and ('mc mirror' in text)):
            return name.strip()
    return text


class Restore(unittest.TestCase):
    def restore(self, user_dbs='', *flags, dest=None):
        backup_dir, buckets = make_backup_dir(self)
        calls, fake_run = recorder(user_dbs)
        args = sb.parser().parse_args(['restore', '--from', str(dest or backup_dir), *flags])
        with mock.patch.object(sb, 'load', return_value=(['docker', 'compose'], buckets, ENV)), \
                mock.patch.object(sb, 'run', side_effect=fake_run):
            try:
                sb.restore(args)
            finally:
                self.calls = calls
                self.kwargs = fake_run.kwargs
        return calls

    def test_fresh_target_call_order_and_no_drop(self):
        calls = self.restore()
        self.assertEqual([kind(c) for c in calls], ['up', 'mongosh', 'mongorestore', 'createbuckets', 'mc mirror'])
        self.assertNotIn('--drop', calls[2][-1])
        self.assertNotIn('--remove', calls[4][-1])
        self.assertIn('print(names.join', calls[1][-1])
        self.assertNotIn('dropDatabase', calls[1][-1])
        assert_mongo_steps_wired(self, calls, self.kwargs)

    def test_populated_target_aborts_before_any_write(self):
        with self.assertRaisesRegex(SystemExit, 'already has data'):
            self.restore('bike4mind\n')
        self.assertEqual([kind(c) for c in self.calls], ['up', 'mongosh'])
        self.assertIn('print(names.join', self.calls[1][-1])
        self.assertNotIn('dropDatabase', self.calls[1][-1])
        assert_mongo_steps_wired(self, self.calls, self.kwargs)

    def test_yes_drops_user_databases_then_restores_without_drop(self):
        calls = self.restore('bike4mind\n', '--yes')
        self.assertEqual([kind(c) for c in calls],
                         ['up', 'mongosh', 'mongosh', 'mongorestore', 'createbuckets', 'mc mirror'])
        self.assertIn('print(names.join', calls[1][-1])
        self.assertNotIn('dropDatabase', calls[1][-1])
        self.assertIn(DROP_ACTION, calls[2][-1])
        self.assertIn('new Mongo(process.env.' + sb.URI_ENV, calls[2][-1])
        assert_mongo_steps_wired(self, calls, self.kwargs)
        self.assertNotIn('--drop', calls[3][-1])
        self.assertIn('--remove', calls[5][-1])

    def test_tampered_backup_aborts_before_touching_the_target(self):
        dest, _ = make_backup_dir(self)
        (dest / sb.MONGO_ARCHIVE).write_bytes(b'tampered')
        with self.assertRaisesRegex(ValueError, 'checksum'):
            self.restore(dest=dest)
        self.assertEqual(self.calls, [])

    def test_restore_mounts_objects_read_only_without_user_override(self):
        mc = self.restore()[-1]
        self.assertTrue(any(part.endswith('/objects:/backup:ro') for part in mc), mc)
        self.assertNotIn('--user', mc)


class Backup(unittest.TestCase):
    def backup(self, dest, fail_on=None):
        _, buckets = sb.resolve_targets(config())
        calls = []
        self.cmds = []
        self.kwargs = []

        def fake_run(cmd, **kwargs):
            calls.append(kind(cmd))
            self.cmds.append(cmd)
            self.kwargs.append(kwargs)
            if fail_on and kind(cmd) == fail_on:
                raise subprocess.CalledProcessError(3, cmd)
            if kind(cmd) == 'mongodump':
                kwargs['stdout'].write(b'dump')
            return subprocess.CompletedProcess(cmd, 0)

        args = sb.parser().parse_args(['backup', '--dest', str(dest)])
        with mock.patch.object(sb, 'load', return_value=(['docker', 'compose'], buckets, ENV)), \
                mock.patch.object(sb, 'run', side_effect=fake_run):
            try:
                sb.backup(args)
            finally:
                self.calls = calls

    def tempdir(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        return Path(tmp.name)

    def test_dumps_mongo_before_mirroring_and_writes_manifest(self):
        dest = self.tempdir() / 'b'
        self.backup(dest)
        self.assertEqual(self.calls, ['mongodump', 'mc mirror'])
        assert_mongo_steps_wired(self, self.cmds, self.kwargs)
        self.assertTrue((dest / 'manifest.json').is_file())

    def test_destination_is_private(self):
        dest = self.tempdir() / 'b'
        self.backup(dest)
        self.assertEqual(stat.S_IMODE(dest.stat().st_mode), 0o700)

    def test_existing_empty_destination_is_made_private(self):
        dest = self.tempdir()
        dest.chmod(0o755)
        self.backup(dest)
        self.assertEqual(stat.S_IMODE(dest.stat().st_mode), 0o700)

    def test_non_empty_destination_refused(self):
        dest = self.tempdir()
        (dest / 'old').write_text('x')
        with self.assertRaisesRegex(SystemExit, 'non-empty'):
            self.backup(dest)
        self.assertEqual(self.calls, [])

    def test_backup_mounts_objects_writable_as_invoking_user(self):
        self.backup(self.tempdir() / 'b')
        mc = self.cmds[-1]
        self.assertFalse(any(part.endswith(':ro') for part in mc), mc)
        self.assertIn('--user', mc)

    def test_failure_names_step_and_incomplete_directory(self):
        dest = self.tempdir() / 'b'
        with self.assertRaisesRegex(SystemExit, r'mongodump failed \(exit 3\); .* is incomplete'):
            self.backup(dest, fail_on='mongodump')


class Redaction(unittest.TestCase):
    URI_ERROR = 'Failed: can\'t create session: failed to connect to mongodb://root:p4ss@localhost:27017/?authSource=app: timeout\n'

    def streamed(self, code, exit_code=0):
        """Run a real child that writes `code`'s stderr; return (raised, stderr as printed)."""
        script = f'import sys; sys.stderr.buffer.write({code}); sys.stderr.flush(); sys.exit({exit_code})'
        with mock.patch('sys.stderr') as err:
            try:
                sb.step('mongodump', [sys.executable, '-c', script], redact_stderr=True)
                raised = None
            except SystemExit as error:
                raised = str(error)
        return raised, ''.join(c.args[0] for c in err.write.call_args_list)

    def test_redact_masks_password_keeps_the_rest(self):
        self.assertEqual(sb.redact(self.URI_ERROR),
                         'Failed: can\'t create session: failed to connect to mongodb://root:***@localhost:27017/?authSource=app: timeout\n')
        self.assertEqual(sb.redact(None), '')

    def test_failed_step_prints_redacted_stderr(self):
        raised, printed = self.streamed(repr(self.URI_ERROR.encode()), 1)
        self.assertRegex(raised, r'mongodump failed \(exit 1\)')
        self.assertIn('authSource=app', printed)
        self.assertNotIn('p4ss', printed)

    def test_successful_step_prints_redacted_stderr(self):
        raised, printed = self.streamed(repr(('dumped 1 oplog entry ' + self.URI_ERROR).encode()))
        self.assertIsNone(raised)
        self.assertIn('dumped 1 oplog entry', printed)
        self.assertNotIn('p4ss', printed)

    def test_non_utf8_output_does_not_raise(self):
        raised, printed = self.streamed(repr(b'ok \xff\xfe done\n'))
        self.assertIsNone(raised)
        self.assertIn('done', printed)

    def test_stderr_is_streamed_not_buffered_until_exit(self):
        seen = []
        # a line must reach the printer while the child is still running
        with mock.patch('builtins.print', side_effect=lambda *a, **k: seen.append(a[0])) as printer:
            proc = mock.MagicMock()
            proc.stderr = iter(['one\n', 'two\n'])
            proc.stdout = None

            def wait():
                self.assertEqual(seen, ['one\n', 'two\n'])  # printed before wait() returns
                return 0
            proc.wait.side_effect = wait
            proc.__enter__.return_value = proc
            with mock.patch.object(subprocess, 'Popen', return_value=proc):
                sb.run(['x'], redact_stderr=True)
        self.assertEqual(seen, ['one\n', 'two\n'])


if __name__ == '__main__':
    unittest.main()
