import importlib.util
import json
import pathlib
import subprocess
import tempfile
import unittest
import yaml

CHART = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('backup', CHART / 'backup.py')
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)

IMAGES = {key: 'example/' + key.lower() + ':tested' for key in ['app', 'chatcompletion', 'ws', 'subscriberFanout', 'minio', 'mc']}


def render(extra=None):
    values = {'existingSecret': 'runtime', 'imagePullSecrets': [{'name': 'pull'}], 'images': IMAGES}
    values.update(extra or {})
    with tempfile.NamedTemporaryFile(mode='w', suffix='.json') as config:
        json.dump(values, config)
        config.flush()
        out = subprocess.run(['helm', 'template', 'rel', str(CHART), '-f', config.name], text=True, capture_output=True)
    assert out.returncode == 0, out.stderr
    return [obj for obj in yaml.safe_load_all(out.stdout) if obj]


def default_buckets():
    env = yaml.safe_load(
        (CHART / 'files/default-env.yaml').read_text())
    return '\n'.join('%s=%s' % (k, env[k]) for k in backup.BUCKET_KEYS)


class FakeKube:
    """Records kubectl calls; answers the few queries restore makes."""

    def __init__(self, databases=('admin', 'config', 'local'), counts=0, fail_restore=False):
        self.calls, self.databases, self.counts, self.fail_restore = [], list(databases), counts, fail_restore

    def run(self, args, input_text=None, stdout=None, stdin=None, check=True):
        self.calls.append(list(args))
        joined = ' '.join(args)
        out = ''
        if 'listDatabases' in joined:
            out = json.dumps(self.databases)
        elif 'mongorestore' in joined and self.fail_restore:
            raise backup.BackupError('boom')
        return subprocess.CompletedProcess(args, 0, out, '')

    def exists(self, kind, name):
        return True

    def json(self, args):
        self.calls.append(list(args))
        if args[:2] == ['get', 'deploy']:
            return {'items': [self.deploy('app', 'app', 2), self.deploy('worker', 'worker', 1), self.deploy('minio', 'minio', 1)]}
        raise AssertionError(args)

    @staticmethod
    def deploy(name, component, replicas):
        labels = {'app.kubernetes.io/instance': 'rel', 'app.kubernetes.io/component': component}
        return {'metadata': {'name': 'rel-' + name}, 'spec': {'replicas': replicas, 'template': {'metadata': {'labels': labels}}}}

    def writes(self):
        return [c for c in self.calls if any(w in ' '.join(c) for w in ('mongorestore', 'dropDatabase', 'scale'))]


class HelperPodTests(unittest.TestCase):
    def setUp(self):
        objects = render()
        self.job = next(o for o in objects if o['kind'] == 'Job')
        self.pod = backup.helper_pod_manifest(self.job, 'rel-backup-abc')

    def test_clones_init_job_runtime(self):
        source = self.job['spec']['template']['spec']
        container = self.pod['spec']['containers'][0]
        self.assertEqual(container['image'], IMAGES['mc'])
        self.assertEqual(container['env'], source['containers'][0]['env'])
        self.assertEqual(container['envFrom'], source['containers'][0]['envFrom'])
        self.assertEqual(self.pod['spec']['imagePullSecrets'], [{'name': 'pull'}])

    def test_no_token_no_init_script_no_volumes(self):
        spec = self.pod['spec']
        self.assertIs(spec['automountServiceAccountToken'], False)
        self.assertEqual(spec['containers'][0]['command'], ['sleep', '3600'])
        self.assertNotIn('volumes', spec)
        self.assertNotIn('buckets.sh', json.dumps(self.pod))

    def test_mc_image_override(self):
        pod = backup.helper_pod_manifest(self.job, 'x', 'other/mc:1')
        self.assertEqual(pod['spec']['containers'][0]['image'], 'other/mc:1')

    def test_latest_job_chosen(self):
        jobs = {'items': [
            {'metadata': {'name': 'rel-buckets-aaa', 'creationTimestamp': '2026-01-01T00:00:00Z'}},
            {'metadata': {'name': 'rel-buckets-bbb', 'creationTimestamp': '2026-02-01T00:00:00Z'}},
            {'metadata': {'name': 'other-buckets-ccc', 'creationTimestamp': '2026-03-01T00:00:00Z'}}]}
        self.assertEqual(backup.latest_init_job(jobs, 'rel')['metadata']['name'], 'rel-buckets-bbb')
        self.assertIsNone(backup.latest_init_job({'items': []}, 'rel'))


class CommandTests(unittest.TestCase):
    def test_all_seven_buckets_resolved(self):
        self.assertEqual(len(backup.buckets_from_env(default_buckets())), 7)

    def test_empty_bucket_fails(self):
        text = default_buckets().replace('SLACK_EXPORT_BUCKET=b4m-slack-export', 'SLACK_EXPORT_BUCKET=')
        with self.assertRaises(backup.BackupError):
            backup.buckets_from_env(text)

    def test_mongo_commands(self):
        dump, restore = backup.mongo_dump_cmd(), backup.mongo_restore_cmd()
        self.assertIn('--oplog', dump)
        self.assertIn('--oplogReplay', restore)
        for cmd in (dump, restore):
            self.assertNotIn('--drop', cmd)
            self.assertNotIn('password', ' '.join(cmd).lower())

    def test_mirror_script_uses_env_credentials(self):
        script = backup.mirror_script(['a', 'b'], 'backup')
        self.assertIn('"$MINIO_ROOT_PASSWORD"', script)
        self.assertIn('local/a', script)
        self.assertNotIn('--remove', backup.mirror_script(['a'], 'restore'))

    def test_local_s3_detection(self):
        self.assertTrue(backup.is_local_s3('http://rel-minio:9000', 'rel'))
        self.assertFalse(backup.is_local_s3('https://s3.amazonaws.com', 'rel'))

    def test_app_roles_exclude_backing_services(self):
        roles = backup.app_role_deployments(FakeKube().json(['get', 'deploy']), 'rel')
        self.assertEqual(roles, {'rel-app': 2, 'rel-worker': 1})


class ManifestTests(unittest.TestCase):
    def make(self, directory):
        for name in backup.ARTIFACTS:
            (pathlib.Path(directory) / name).write_bytes(name.encode())
        return backup.build_manifest('rel', 'ns', 't0', 't1', {}, ['a', 'b'], {'a': 1, 'b': 0}, directory)

    def test_round_trip(self):
        with tempfile.TemporaryDirectory() as d:
            backup.check_manifest(self.make(d), d, ['b', 'a'])

    def test_tamper_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            manifest = self.make(d)
            (pathlib.Path(d) / 'objects.tar').write_bytes(b'tampered')
            with self.assertRaisesRegex(backup.BackupError, 'checksum'):
                backup.check_manifest(manifest, d, ['a', 'b'])

    def test_bucket_mismatch_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaisesRegex(backup.BackupError, 'buckets'):
                backup.check_manifest(self.make(d), d, ['a', 'c'])


class RestoreSafetyTests(unittest.TestCase):
    def run_restore(self, kube, yes=False):
        class FakeHelper:
            def __init__(self, *a):
                pass

            def __enter__(self):
                return self

            def __exit__(self, *e):
                pass

            def buckets(self):
                return ['a', 'b']

            def counts(self, buckets):
                return {'a': kube.counts, 'b': 0}

            def sh(self, script, stdin=None, stdout=None):
                kube.calls.append(['helper', script])

        with tempfile.TemporaryDirectory() as d:
            for name in backup.ARTIFACTS:
                (pathlib.Path(d) / name).write_bytes(b'x')
            manifest = backup.build_manifest('rel', 'ns', 't0', 't1', {}, ['a', 'b'], {}, d)
            (pathlib.Path(d) / 'manifest.json').write_text(json.dumps(manifest))
            args = type('A', (), {'namespace': 'ns', 'release': 'rel', 'context': None, 'mc_image': None, 'src': d, 'yes': yes})
            saved = backup.Kube, backup.Helper
            backup.Kube, backup.Helper = lambda *a: kube, FakeHelper
            try:
                backup.restore(args)
            finally:
                backup.Kube, backup.Helper = saved

    def test_populated_database_aborts_before_any_write(self):
        kube = FakeKube(databases=['admin', 'bike4mind'])
        with self.assertRaisesRegex(backup.BackupError, 'not empty'):
            self.run_restore(kube)
        self.assertEqual(kube.writes(), [])

    def test_populated_bucket_aborts_before_any_write(self):
        kube = FakeKube(counts=3)
        with self.assertRaisesRegex(backup.BackupError, 'not empty'):
            self.run_restore(kube)
        self.assertEqual(kube.writes(), [])

    def test_fresh_target_scales_down_restores_and_scales_up(self):
        kube = FakeKube()
        self.run_restore(kube)
        scales = [c for c in kube.calls if c[0] == 'scale']
        self.assertEqual([(c[2], c[4]) for c in scales],
                         [('rel-app', '0'), ('rel-worker', '0'), ('rel-app', '2'), ('rel-worker', '1')])

    def test_scaled_back_even_when_restore_fails(self):
        kube = FakeKube(fail_restore=True)
        with self.assertRaises(backup.BackupError):
            self.run_restore(kube)
        self.assertEqual([c[4] for c in kube.calls if c[0] == 'scale'], ['0', '0', '2', '1'])

    def test_yes_drops_user_databases_without_drop_flag(self):
        kube = FakeKube(databases=['admin', 'bike4mind'])
        self.run_restore(kube, yes=True)
        joined = ' '.join(' '.join(c) for c in kube.calls)
        self.assertIn('dropDatabase', joined)
        self.assertNotIn('--drop', joined)


class RefusalTests(unittest.TestCase):
    def test_external_mongo_refused(self):
        class NoMongo:
            def exists(self, kind, name):
                return False
        with self.assertRaisesRegex(backup.BackupError, 'external MongoDB'):
            backup.require_local_mongo(NoMongo(), 'rel')

    def test_non_local_s3_refused(self):
        helper = backup.Helper.__new__(backup.Helper)
        helper.release = 'rel'
        helper.text = lambda script: 'https://s3.example.com'
        with self.assertRaisesRegex(backup.BackupError, 'external S3'):
            helper.buckets()


if __name__ == '__main__':
    unittest.main()
