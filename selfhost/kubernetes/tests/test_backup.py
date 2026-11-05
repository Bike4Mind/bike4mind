import contextlib
import importlib.util
import io
import json
import pathlib
import subprocess
import tarfile
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

    def __init__(self, databases=('admin', 'config', 'local'), counts=0, fail_restore=False, fail_scale_at=None,
                 replicas=None, late_databases=None):
        self.restored_counts, self.late_databases, self.db_reads = None, late_databases, 0
        self.calls, self.databases, self.counts, self.fail_restore = [], list(databases), counts, fail_restore
        self.fail_scale_at, self.replicas, self.scale_calls = fail_scale_at, replicas or {}, 0

    def run(self, args, input_text=None, stdout=None, stdin=None, check=True):
        self.calls.append(list(args))
        joined = ' '.join(args)
        out = ''
        if 'listDatabases' in joined:
            self.db_reads += 1
            late = self.late_databases is not None and self.db_reads > 1
            out = json.dumps(self.late_databases if late else self.databases)
        elif 'mongorestore' in joined and self.fail_restore:
            raise backup.BackupError('boom')
        elif args[0] == 'scale':
            self.scale_calls += 1
            if self.scale_calls == self.fail_scale_at:
                raise backup.BackupError('scale boom')
        return subprocess.CompletedProcess(args, 0, out, '')

    def exists(self, kind, name):
        return True

    def json(self, args):
        self.calls.append(list(args))
        if args[:2] == ['get', 'deploy']:
            return {'items': [self.deploy('app', 'app', self.replicas.get('app', 2)),
                              self.deploy('worker', 'worker', self.replicas.get('worker', 1)),
                              self.deploy('minio', 'minio', 1)]}
        if args[:2] == ['get', 'pod']:
            return {'spec': {'containers': [{'image': 'img:1'}]}}
        raise AssertionError(args)

    @staticmethod
    def deploy(name, component, replicas):
        labels = {'app.kubernetes.io/instance': 'rel', 'app.kubernetes.io/component': component}
        return {'metadata': {'name': 'rel-' + name}, 'spec': {'replicas': replicas, 'template': {'metadata': {'labels': labels}}}}

    def writes(self):
        words = ('mongorestore', 'dropDatabase', 'scale', 'mc mirror', 'mc mb')
        return [c for c in self.calls if any(w in ' '.join(c) for w in words)]


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
        self.assertEqual(spec['containers'][0]['command'], ['sleep', '604800'])
        self.assertEqual(spec['volumes'], [{'name': 'work', 'emptyDir': {}}])
        self.assertEqual(spec['containers'][0]['volumeMounts'], [{'name': 'work', 'mountPath': '/work'}])
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
        env = yaml.safe_load((CHART / 'files/default-env.yaml').read_text())
        self.assertEqual(backup.buckets_from_env(default_buckets()), [env[k] for k in backup.BUCKET_KEYS])
        self.assertEqual(len(set(backup.buckets_from_env(default_buckets()))), 7)

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

    def test_restore_script_creates_missing_buckets(self):
        script = backup.mirror_script(['a', 'b'], 'restore')
        for b in ('a', 'b'):
            self.assertIn('mc mb --ignore-existing "local/%s"' % b, script)

    def test_mirror_script_replace_matches_backup_and_keeps_marker(self):
        script = backup.mirror_script(['a'], 'restore', replace=True)
        self.assertIn('mc mirror --quiet --overwrite --remove --exclude \'.initialized-*\' "/work/a" "local/a"', script)
        self.assertNotIn('--remove', backup.mirror_script(['a'], 'backup', replace=True))

    def test_count_script_fails_on_mc_error(self):
        script = backup.count_script(['a'])
        self.assertTrue(script.startswith('set -eu'))
        self.assertIn('mc ls --recursive "local/a" >/work/ls\n', script)
        self.assertNotIn('$(mc ls', script)

    def test_count_matches_tar_counts_for_marker_lookalike_keys(self):
        keys = ['.initialized-abc', 'u1/uninitialized-notes.txt', 'reinitialized-x', 'dir/.initialized-y', 'plain.txt']
        with tempfile.TemporaryDirectory() as d:
            root = pathlib.Path(d)
            (root / 'bin').mkdir()
            listing = ''.join('[2026-01-01 00:00:00 UTC]     0B STANDARD %s\n' % k for k in keys)
            fake = root / 'bin' / 'mc'
            (root / 'listing').write_text(listing)
            fake.write_text('#!/bin/sh\n[ "$1" = ls ] && cat ' + str(root / 'listing') + '\nexit 0\n')
            fake.chmod(0o755)
            tar = root / 'o.tar'
            with tarfile.open(tar, 'w') as archive:
                for k in keys:
                    archive.addfile(tarfile.TarInfo('./a/' + k), io.BytesIO(b''))
            script = backup.count_script(['a']).replace('/work', str(root / 'work'))
            env = {'PATH': '%s/bin:/usr/bin:/bin' % root, 'LOCAL_OBJECTSTORE_ENDPOINT': 'x',
                   'MINIO_ROOT_USER': 'u', 'MINIO_ROOT_PASSWORD': 'p'}
            out = subprocess.run(['sh', '-c', script], env=env, text=True, capture_output=True, check=True).stdout
            self.assertEqual(int(out.split()[1]), backup.tar_counts(tar, ['a'])['a'])
            self.assertEqual(int(out.split()[1]), 4)

    def test_tar_counts_ignores_marker_and_other_dirs(self):
        with tempfile.TemporaryDirectory() as d:
            path = pathlib.Path(d) / 'o.tar'
            with tarfile.open(path, 'w') as archive:
                for name in ('./a/x', './a/dir/y', './a/.initialized-1', './b/z', './stray/q'):
                    info = tarfile.TarInfo(name)
                    archive.addfile(info, io.BytesIO(b''))
            self.assertEqual(backup.tar_counts(path, ['a', 'b', 'empty']), {'a': 2, 'b': 1, 'empty': 0})

    def test_local_context_is_prefix_or_exact(self):
        for ok in ('kind-kind', 'k3d-dev', 'minikube', 'docker-desktop'):
            self.assertTrue(backup.is_local_context(ok), ok)
        for bad in ('unkind-prod', 'remote-context-kind-prod', 'prod-k3d-migrated', 'minikube-prod', ''):
            self.assertFalse(backup.is_local_context(bad), bad)

    def test_missing_or_corrupt_manifest_is_a_backup_error(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaisesRegex(backup.BackupError, 'manifest.json'):
                backup.read_manifest(d)
            (pathlib.Path(d) / 'manifest.json').write_text('{')
            with self.assertRaisesRegex(backup.BackupError, 'manifest.json'):
                backup.read_manifest(d)

    def test_backup_prints_secret_reminder(self):
        class FakeHelper:
            def __init__(self, *a):
                pass

            def __enter__(self):
                return self

            def __exit__(self, *e):
                pass

            def buckets(self):
                return ['a']

            def sh(self, script, stdin=None, stdout=None):
                with tarfile.open(fileobj=stdout, mode='w') as archive:
                    archive.addfile(tarfile.TarInfo('./a/x'), io.BytesIO(b''))

            def image(self):
                return 'mc:1'

        with tempfile.TemporaryDirectory() as d:
            args = type('A', (), {'namespace': 'ns', 'release': 'rel', 'context': None, 'mc_image': None,
                                  'dest': str(pathlib.Path(d) / 'out')})
            saved = backup.Kube, backup.Helper
            backup.Kube, backup.Helper = lambda *a: FakeKube(), FakeHelper
            out = io.StringIO()
            try:
                with contextlib.redirect_stdout(out):
                    backup.backup(args)
            finally:
                backup.Kube, backup.Helper = saved
        for name in ('SECRET_ENCRYPTION_KEY', 'SECRET_ENCRYPTION_KEY_PREVIOUS', 'MEMORY_KEY_SECRET'):
            self.assertIn(name, out.getvalue())

    def test_mirror_script_creates_dir_for_empty_bucket(self):
        for direction in ('backup', 'restore'):
            self.assertIn('mkdir -p "/work/empty"', backup.mirror_script(['empty'], direction))

    def test_local_s3_detection(self):
        self.assertTrue(backup.is_local_s3('http://rel-minio:9000', 'rel'))
        self.assertFalse(backup.is_local_s3('https://s3.amazonaws.com', 'rel'))

    def test_app_roles_exclude_backing_services(self):
        roles = backup.app_role_deployments(FakeKube().json(['get', 'deploy']), 'rel')
        self.assertEqual(roles, {'rel-app': 2, 'rel-worker': 1})

    def test_roles_ignore_deployment_level_labels(self):
        items = [FakeKube.deploy('app', 'app', 1), FakeKube.deploy('minio', 'minio', 1)]
        for item in items:
            item['metadata']['labels'] = {'app.kubernetes.io/instance': 'argo-app'}
        self.assertEqual(backup.app_role_deployments({'items': items}, 'rel'), {'rel-app': 1})

    def test_roles_from_rendered_chart(self):
        deployments = {'items': [o for o in render() if o['kind'] == 'Deployment']}
        self.assertEqual(sorted(backup.app_role_deployments(deployments, 'rel')),
                         ['rel-app', 'rel-chatcompletion', 'rel-subscriber-fanout', 'rel-worker', 'rel-ws'])


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
    def run_restore(self, kube, yes=False, tamper=False, buckets_mismatch=False):
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
                if kube.restored_counts is not None and any('mc mirror' in ' '.join(c) for c in kube.calls):
                    return kube.restored_counts
                return {'a': kube.counts, 'b': 0}

            def sh(self, script, stdin=None, stdout=None):
                kube.calls.append(['helper', script])

        with tempfile.TemporaryDirectory() as d:
            for name in backup.ARTIFACTS:
                (pathlib.Path(d) / name).write_bytes(b'x')
            manifest = backup.build_manifest('rel', 'ns', 't0', 't1', {}, ['a', 'b'], {'a': 1, 'b': 0}, d)
            if tamper:
                (pathlib.Path(d) / 'objects.tar').write_bytes(b'tampered')
            if buckets_mismatch:
                manifest['buckets'] = ['a', 'zzz']
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

    def test_tampered_archive_rejected_before_any_write(self):
        kube = FakeKube()
        with self.assertRaisesRegex(backup.BackupError, 'checksum'):
            self.run_restore(kube, tamper=True)
        self.assertEqual(kube.writes(), [])

    def test_bucket_mismatch_rejected_before_any_write(self):
        kube = FakeKube()
        with self.assertRaisesRegex(backup.BackupError, 'buckets'):
            self.run_restore(kube, buckets_mismatch=True)
        self.assertEqual(kube.writes(), [])

    def test_fresh_target_runs_one_plain_object_restore(self):
        kube = FakeKube()
        kube.restored_counts = {'a': 1, 'b': 0}
        self.run_restore(kube)
        mirrors = [c for c in kube.calls if c[0] == 'helper' and 'mc mirror' in c[1]]
        self.assertEqual(len(mirrors), 1)
        self.assertNotIn('--remove', mirrors[0][1])

    def test_yes_makes_buckets_match_backup(self):
        kube = FakeKube(databases=['bike4mind'])
        kube.restored_counts = {'a': 1, 'b': 0}
        self.run_restore(kube, yes=True)
        mirror = next(c for c in kube.calls if c[0] == 'helper' and 'mc mirror' in c[1])
        self.assertIn('--overwrite --remove', mirror[1])

    def test_short_restore_fails(self):
        kube = FakeKube()
        kube.restored_counts = {'a': 0, 'b': 0}
        with self.assertRaisesRegex(backup.BackupError, 'fewer objects'):
            self.run_restore(kube)
        self.assertEqual([c[4] for c in kube.calls if c[0] == 'scale'], ['0', '0', '2', '1'])

    def test_scale_down_failure_still_scales_back(self):
        kube = FakeKube(fail_scale_at=2)
        with self.assertRaisesRegex(backup.BackupError, 'scale boom'):
            self.run_restore(kube)
        self.assertEqual([c[4] for c in kube.calls if c[0] == 'scale'], ['0', '0', '2', '1'])

    def test_role_already_at_zero_warns_and_stays_zero(self):
        kube = FakeKube(replicas={'worker': 0})
        kube.restored_counts = {'a': 1, 'b': 0}
        self.run_restore(kube)
        self.assertEqual([c[4] for c in kube.calls if c[0] == 'scale'], ['0', '0', '2', '0'])

    def test_fresh_target_scales_down_restores_and_scales_up(self):
        kube = FakeKube()
        kube.restored_counts = {'a': 1, 'b': 0}
        self.run_restore(kube)
        scales = [c for c in kube.calls if c[0] == 'scale']
        self.assertEqual([(c[2], c[4]) for c in scales],
                         [('rel-app', '0'), ('rel-worker', '0'), ('rel-app', '2'), ('rel-worker', '1')])

    def test_drain_wait_is_scoped_and_failure_is_an_error(self):
        class K(FakeKube):
            def run(self, args, **kw):
                if args[0] == 'wait':
                    self.calls.append(list(args))
                    return subprocess.CompletedProcess(args, 1, '', 'timed out waiting')
                return super().run(args, **kw)
        kube = K()
        with self.assertRaisesRegex(backup.BackupError, 'did not drain'):
            backup.scale(kube, {'rel-app': 1}, True, 'rel')
        wait = next(c for c in kube.calls if c[0] == 'wait')
        self.assertEqual(wait, ['wait', '--for=delete', 'pod', '-l',
                                'app.kubernetes.io/instance=rel,app.kubernetes.io/component notin '
                                '(backup-helper,initialize,mail,minio,mongo,sqs)', '--timeout=900s'])

    def test_drain_excludes_helper_and_init_job_components(self):
        job = next(o for o in render() if o['kind'] == 'Job')
        init = job['spec']['template']['metadata']['labels']['app.kubernetes.io/component']
        helper = backup.helper_pod_manifest(job, 'x')['metadata']['labels']['app.kubernetes.io/component']
        kube = FakeKube()
        backup.scale(kube, {'rel-app': 1}, True, 'rel')
        selector = next(c for c in kube.calls if c[0] == 'wait')[4]
        self.assertIn(init, selector.split('(')[1])
        self.assertIn(helper, selector.split('(')[1])

    def test_no_matching_resources_on_drain_is_fine(self):
        class K(FakeKube):
            def run(self, args, **kw):
                if args[0] == 'wait':
                    return subprocess.CompletedProcess(args, 1, '', 'error: no matching resources found')
                return super().run(args, **kw)
        backup.scale(K(), {'rel-app': 1}, True, 'rel')

    def test_scale_up_attempts_every_role_and_reports_both_errors(self):
        kube = FakeKube(fail_restore=True, fail_scale_at=3)
        with self.assertRaises(backup.BackupError) as ctx:
            self.run_restore(kube)
        self.assertEqual([c[4] for c in kube.calls if c[0] == 'scale'], ['0', '0', '2', '1'])
        self.assertIn('boom', str(ctx.exception))
        self.assertIn('scale boom', str(ctx.exception))

    def test_database_seeded_during_drain_is_dropped(self):
        kube = FakeKube(databases=['admin'], late_databases=['admin', 'bike4mind'])
        kube.restored_counts = {'a': 1, 'b': 0}
        self.run_restore(kube, yes=True)
        dropped = [c for c in kube.calls if 'dropDatabase' in ' '.join(c)]
        self.assertEqual(len(dropped), 1)
        self.assertIn('"bike4mind"', ' '.join(dropped[0]))
        self.assertLess(kube.calls.index(['scale', 'deployment', 'rel-app', '--replicas', '0']),
                        kube.calls.index(dropped[0]))

    def test_scaled_back_even_when_restore_fails(self):
        kube = FakeKube(fail_restore=True)
        with self.assertRaises(backup.BackupError):
            self.run_restore(kube)
        self.assertEqual([c[4] for c in kube.calls if c[0] == 'scale'], ['0', '0', '2', '1'])

    def test_yes_drops_user_databases_without_drop_flag(self):
        kube = FakeKube(databases=['admin', 'bike4mind'])
        kube.restored_counts = {'a': 1, 'b': 0}
        self.run_restore(kube, yes=True)
        joined = ' '.join(' '.join(c) for c in kube.calls)
        self.assertIn('dropDatabase', joined)
        self.assertNotIn('--drop', joined)


class HelperLifecycleTests(unittest.TestCase):
    def kube(self):
        class K(FakeKube):
            created = None

            def run(self, args, input_text=None, **kw):
                if args[0] == 'create':
                    self.created = json.loads(input_text)
                return super().run(args, input_text=input_text, **kw)

            def json(self, args):
                if args[:2] == ['get', 'jobs']:
                    return {'items': []}
                if args[:3] == ['get', 'deploy', 'rel-app']:
                    return {'spec': {'template': {'spec': {'containers': [{'envFrom': [
                        {'configMapRef': {'name': 'x'}}, {'secretRef': {'name': 'runtime'}}]}]}}}}
                return super().json(args)
        return K()

    def test_pod_deleted_on_success_and_failure(self):
        for fail in (False, True):
            kube = self.kube()
            helper = backup.Helper(kube, 'rel', 'mc:1')
            try:
                with helper:
                    if fail:
                        raise backup.BackupError('boom')
            except backup.BackupError:
                pass
            self.assertIn(['delete', 'pod', helper.name, '--wait=false', '--ignore-not-found'], kube.calls)

    def test_fallback_pod_created_when_init_job_gone(self):
        kube = self.kube()
        with backup.Helper(kube, 'rel', 'mc:1'):
            pass
        container = kube.created['spec']['containers'][0]
        self.assertEqual(container['image'], 'mc:1')
        self.assertEqual(container['envFrom'], [{'configMapRef': {'name': 'rel-config'}}, {'secretRef': {'name': 'runtime'}}])
        self.assertEqual(container['env'], [{'name': 'LOCAL_OBJECTSTORE_ENDPOINT', 'value': 'http://rel-minio:9000'}])
        self.assertIs(kube.created['spec']['automountServiceAccountToken'], False)

    def test_no_job_and_no_image_is_an_error(self):
        with self.assertRaisesRegex(backup.BackupError, '--mc-image'):
            with backup.Helper(self.kube(), 'rel', None):
                pass


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
