import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

import selfhost_backup as sb

URI = 'mongodb://root:s3cret@mongo:27017/bike4mind?replicaSet=rs0&authSource=admin'
MINIO_PASSWORD = 'minio-pass-xyz'


def config(**overrides):
    env = {key: 'b-' + key.lower() for key in sb.BUCKET_KEYS}
    env.update(MINIO_ROOT_PASSWORD=MINIO_PASSWORD)
    env.update(overrides)
    return {'services': {'createbuckets': {'environment': env},
                         'app': {'environment': {'MONGODB_URI': URI}}}}


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


class Commands(unittest.TestCase):
    compose = ['docker', 'compose', '-p', 'x']

    def test_instance_uri_drops_database_but_keeps_query(self):
        self.assertEqual(sb.instance_uri(URI), 'mongodb://root:s3cret@mongo:27017/?replicaSet=rs0&authSource=admin')

    def test_dump_and_restore_flags(self):
        self.assertIn('--oplog', sb.mongodump_cmd(self.compose)[-1])
        restore = sb.mongorestore_cmd(self.compose)[-1]
        self.assertIn('--oplogReplay', restore)
        self.assertIn('--drop', restore)

    def test_no_secret_in_argv(self):
        argv = (sb.mongodump_cmd(self.compose) + sb.mongorestore_cmd(self.compose)
                + sb.mongo_user_dbs_cmd(self.compose)
                + sb.mc_cmd(self.compose, Path('/o'), sb.mirror_script(['b'], False), False))
        text = ' '.join(argv)
        for secret in ('s3cret', MINIO_PASSWORD):
            self.assertNotIn(secret, text)
        self.assertIn(sb.URI_ENV, text)

    def test_mirror_directions_and_quoting(self):
        self.assertIn('mc mirror --quiet local/b /backup/b', sb.mirror_script(['b'], False))
        self.assertIn('mc mirror --quiet --overwrite /backup/b local/b', sb.mirror_script(['b'], True))
        self.assertIn("'a b'", sb.mirror_script(['a b'], False))

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


class RestoreSafety(unittest.TestCase):
    def test_populated_target_aborts_before_any_write(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        dest = Path(tmp.name)
        (dest / sb.MONGO_ARCHIVE).write_bytes(b'dump')
        _, buckets = sb.resolve_targets(config())
        for name in buckets.values():
            (dest / 'objects' / name).mkdir(parents=True)
        (dest / 'manifest.json').write_text(json.dumps(sb.build_manifest(dest, buckets, 't0', 't1', 'r')))
        calls = []

        def fake_run(cmd, **kwargs):
            calls.append(cmd)
            out = subprocess.CompletedProcess(cmd, 0, stdout='bike4mind\n' if 'mongosh' in ' '.join(cmd) else '')
            return out

        args = sb.parser().parse_args(['restore', '--from', str(dest)])
        with mock.patch.object(sb, 'load', return_value=(['docker', 'compose'], buckets, {})), \
                mock.patch.object(sb, 'run', side_effect=fake_run):
            with self.assertRaises(SystemExit):
                sb.restore(args)
        self.assertFalse(any('mongorestore' in ' '.join(c) for c in calls))
        self.assertFalse(any('mc mirror' in ' '.join(c) for c in calls))


if __name__ == '__main__':
    unittest.main()
