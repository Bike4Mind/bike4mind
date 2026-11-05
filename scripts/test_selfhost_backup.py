import json
import os
from pathlib import Path
import re
import stat
import subprocess
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
        self.assertNotIn('--quiet', sb.mongorestore_cmd(self.compose, drop=True)[-1])

    def test_restore_drops_only_when_overwriting(self):
        fresh = sb.mongorestore_cmd(self.compose, drop=False)[-1]
        self.assertIn('--oplogReplay', fresh)
        self.assertNotIn('--drop', fresh)
        self.assertIn('--drop', sb.mongorestore_cmd(self.compose, drop=True)[-1])

    def test_uri_never_in_container_argv(self):
        for cmd in (sb.mongodump_cmd(self.compose), sb.mongorestore_cmd(self.compose, True), sb.mongo_user_dbs_cmd(self.compose)):
            self.assertIn(sb.URI_ENV, cmd[cmd.index('-e') + 1])
            self.assertNotIn('--uri', cmd[-1])
            self.assertNotRegex(cmd[-1], r'(mongodump|mongorestore|mongosh)[^;]*\$' + sb.URI_ENV)

    def test_load_passes_uri_by_environment_only(self):
        args = sb.parser().parse_args(['-p', 'x', 'backup', '--dest', '/d'])
        out = subprocess.CompletedProcess([], 0, stdout=json.dumps(config()))
        with mock.patch.object(sb, 'run', return_value=out):
            compose, _, env = sb.load(args)
        self.assertEqual(env[sb.URI_ENV], sb.instance_uri(URI))
        argv = ' '.join(compose + sb.mongodump_cmd(compose) + sb.mongorestore_cmd(compose, True)
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


def recorder(user_dbs=''):
    calls = []

    def fake_run(cmd, **kwargs):
        calls.append(cmd)
        return subprocess.CompletedProcess(cmd, 0, stdout=user_dbs if 'mongosh' in ' '.join(cmd) else '')

    return calls, fake_run


def kind(cmd):
    text = ' '.join(cmd)
    for name in ('mongorestore', 'mongodump', 'mongosh', 'mc mirror', 'createbuckets', ' up '):
        if name in text and not (name == 'createbuckets' and ('mc mirror' in text)):
            return name.strip()
    return text


class Restore(unittest.TestCase):
    def restore(self, user_dbs='', *flags):
        dest, buckets = make_backup_dir(self)
        calls, fake_run = recorder(user_dbs)
        args = sb.parser().parse_args(['restore', '--from', str(dest), *flags])
        with mock.patch.object(sb, 'load', return_value=(['docker', 'compose'], buckets, {})), \
                mock.patch.object(sb, 'run', side_effect=fake_run):
            try:
                sb.restore(args)
            except SystemExit:
                pass
        return calls

    def test_fresh_target_call_order_and_no_drop(self):
        calls = self.restore()
        self.assertEqual([kind(c) for c in calls], ['up', 'mongosh', 'mongorestore', 'createbuckets', 'mc mirror'])
        self.assertNotIn('--drop', calls[2][-1])
        self.assertNotIn('--remove', calls[4][-1])

    def test_populated_target_aborts_before_any_write(self):
        calls = self.restore('bike4mind\n')
        self.assertEqual([kind(c) for c in calls], ['up', 'mongosh'])

    def test_yes_overwrite_drops_and_removes_newer_objects(self):
        calls = self.restore('bike4mind\n', '--yes')
        self.assertIn('--drop', calls[2][-1])
        self.assertIn('--remove', calls[4][-1])


class Backup(unittest.TestCase):
    def backup(self, dest, fail_on=None):
        _, buckets = sb.resolve_targets(config())
        calls = []

        def fake_run(cmd, **kwargs):
            calls.append(kind(cmd))
            if fail_on and kind(cmd) == fail_on:
                raise subprocess.CalledProcessError(3, cmd)
            if kind(cmd) == 'mongodump':
                kwargs['stdout'].write(b'dump')
            return subprocess.CompletedProcess(cmd, 0)

        args = sb.parser().parse_args(['backup', '--dest', str(dest)])
        with mock.patch.object(sb, 'load', return_value=(['docker', 'compose'], buckets, {})), \
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

    def test_failure_names_step_and_incomplete_directory(self):
        dest = self.tempdir() / 'b'
        with self.assertRaisesRegex(SystemExit, r'mongodump failed \(exit 3\); .* is incomplete'):
            self.backup(dest, fail_on='mongodump')


if __name__ == '__main__':
    unittest.main()
