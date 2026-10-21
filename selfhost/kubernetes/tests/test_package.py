import json
import os
import pathlib
import shutil
import subprocess
import tempfile
import time
import unittest
import yaml

CHART = pathlib.Path(__file__).resolve().parents[1]

class UniqueLoader(yaml.SafeLoader):
    pass

def unique_mapping(loader, node, deep=False):
    result = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if key in result:
            raise ValueError('Duplicate YAML key: ' + str(key))
        result[key] = loader.construct_object(value_node, deep=deep)
    return result

UniqueLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, unique_mapping)

class PackageTests(unittest.TestCase):
    def render(self, overrides=None, success=True):
        values = {'existingSecret': 'runtime', 'images': {key: 'example/' + key.lower() + ':tested' for key in ['app', 'chatcompletion', 'ws', 'subscriberFanout', 'minio', 'mc']}}
        for key, value in (overrides or {}).items():
            if isinstance(value, dict) and isinstance(values.get(key), dict):
                values[key].update(value)
            else:
                values[key] = value
        with tempfile.NamedTemporaryFile(mode='w', suffix='.json') as config:
            json.dump(values, config)
            config.flush()
            result = subprocess.run(['helm', 'template', 'test', str(CHART), '-f', config.name], text=True, capture_output=True)
        if not success:
            self.assertNotEqual(result.returncode, 0)
            return result
        self.assertEqual(result.returncode, 0, result.stderr)
        return [obj for obj in yaml.load_all(result.stdout, Loader=UniqueLoader) if obj]

    def test_rendered_runtime_contract(self):
        objects = self.render()
        deployments = {obj['metadata']['name']: obj for obj in objects if obj['kind'] == 'Deployment'}
        self.assertEqual(deployments['test-worker']['spec']['replicas'], 1)
        self.assertEqual(deployments['test-worker']['spec']['strategy']['type'], 'Recreate')
        self.assertEqual(deployments['test-ws']['spec']['strategy']['type'], 'Recreate')
        pod = deployments['test-worker']['spec']['template']['spec']
        self.assertEqual(pod['containers'][0]['workingDir'], '/app/apps/workers')
        self.assertIn('src/selfhost/main.ts', pod['containers'][0]['command'])
        self.assertEqual(deployments['test-chatcompletion']['spec']['template']['spec']['terminationGracePeriodSeconds'], 150)
        claims = [obj for obj in objects if obj['kind'] == 'PersistentVolumeClaim']
        self.assertEqual(len(claims), 3)
        self.assertTrue(all(obj['metadata']['annotations']['helm.sh/resource-policy'] == 'keep' for obj in claims))
        self.assertTrue(all(obj['spec']['type'] == 'ClusterIP' for obj in objects if obj['kind'] == 'Service'))
        self.assertTrue(all('helm.sh/hook' not in obj['metadata'].get('annotations', {}) for obj in objects))

    def test_mongo_guard_precedes_mongod_and_can_resolve_unready_self(self):
        objects = self.render()
        mongo = next(obj for obj in objects if obj['kind'] == 'StatefulSet')
        pod = mongo['spec']['template']['spec']
        self.assertEqual(pod['initContainers'][0]['command'], ['/bin/sh', '/scripts/mongo-dns-guard.sh'])
        self.assertEqual(pod['initContainers'][0]['env'][0]['valueFrom']['fieldRef']['fieldPath'], 'status.podIP')
        self.assertNotIn('mongo-dns-guard.sh', str(pod['containers'][0]['startupProbe']))
        headless = next(obj for obj in objects if obj['kind'] == 'Service' and obj['metadata']['name'] == 'test-mongo')
        self.assertTrue(headless['spec']['publishNotReadyAddresses'])

    def test_source_queue_host_is_release_prefixed(self):
        scripts = next(obj for obj in self.render() if obj['kind'] == 'ConfigMap' and obj['metadata']['name'] == 'test-scripts')
        self.assertIn('host = "test-sqs"', scripts['data']['elasticmq.conf'])
        self.assertNotIn('host = "sqs"', scripts['data']['elasticmq.conf'])

    def test_external_s3_selection_does_not_initialize_external_buckets(self):
        objects = self.render({'config': {'AWS_ENDPOINT_URL_S3': 'https://s3.example.com'}})
        config = next(obj for obj in objects if obj['kind'] == 'ConfigMap' and obj['metadata']['name'] == 'test-config')
        self.assertEqual(config['data']['AWS_ENDPOINT_URL_S3'], 'https://s3.example.com')
        job = next(obj for obj in objects if obj['kind'] == 'Job')
        env = job['spec']['template']['spec']['containers'][0]['env']
        local = next(entry['value'] for entry in env if entry['name'] == 'LOCAL_OBJECTSTORE_ENDPOINT')
        self.assertEqual(local, 'http://test-minio:9000')
        app = next(obj for obj in objects if obj['kind'] == 'Deployment' and obj['metadata']['name'] == 'test-app')
        wait = next(container for container in app['spec']['template']['spec']['initContainers'] if container['name'] == 'wait-buckets')
        self.assertIn('http://test-minio:9000', wait['args'][0])

    def test_initializer_changes_name_for_new_image_and_marker_tracks_it(self):
        original = next(obj for obj in self.render() if obj['kind'] == 'Job')
        objects = self.render({'images': {'mc': 'example/mc:new'}})
        updated = next(obj for obj in objects if obj['kind'] == 'Job')
        self.assertNotEqual(original['metadata']['name'], updated['metadata']['name'])
        revision = next(entry['value'] for entry in updated['spec']['template']['spec']['containers'][0]['env'] if entry['name'] == 'INITIALIZATION_REVISION')
        app = next(obj for obj in objects if obj['kind'] == 'Deployment' and obj['metadata']['name'] == 'test-app')
        self.assertIn('.initialized-' + revision, str(app['spec']['template']['spec']['initContainers']))

    def test_executor_is_opt_in_and_gets_drain_and_secret(self):
        objects = self.render({'agentExecutor': {'enabled': True, 'image': 'example/executor:tested'}})
        executor = next(obj for obj in objects if obj['kind'] == 'Deployment' and obj['metadata']['name'] == 'test-agentexecutor')
        self.assertEqual(executor['spec']['template']['spec']['terminationGracePeriodSeconds'], 840)
        self.assertIn('AGENT_EXECUTOR_INTERNAL_SECRET', str(executor))
        config = next(obj for obj in objects if obj['kind'] == 'ConfigMap' and obj['metadata']['name'] == 'test-config')
        self.assertEqual(config['data']['AGENT_EXECUTOR_SERVICE'], 'http://test-agentexecutor:8080')

    def test_declared_secret_rotation_restarts_all_runtime_roles(self):
        original = self.render()
        before = {obj['metadata']['name']: obj['spec']['template']['metadata']['annotations']['checksum/config'] for obj in original if obj['kind'] in ['Deployment', 'StatefulSet']}
        for change in [{'initializationRevision': 'rotation-2'}, {'existingSecret': 'replacement-runtime'}]:
            with self.subTest(change=change):
                after = {obj['metadata']['name']: obj['spec']['template']['metadata']['annotations']['checksum/config'] for obj in self.render(change) if obj['kind'] in ['Deployment', 'StatefulSet']}
                self.assertEqual(set(before), set(after))
                for name in before:
                    self.assertNotEqual(before[name], after[name], name)

    def test_fanout_stage_references_configured_application_stage(self):
        objects = self.render({'config': {'APP_STAGE': 'evaluation'}})
        config = next(obj for obj in objects if obj['kind'] == 'ConfigMap' and obj['metadata']['name'] == 'test-config')
        self.assertEqual(config['data']['APP_STAGE'], 'evaluation')
        fanout = next(obj for obj in objects if obj['kind'] == 'Deployment' and obj['metadata']['name'] == 'test-subscriber-fanout')
        stage = next((entry for entry in fanout['spec']['template']['spec']['containers'][0]['env'] if entry['name'] == 'STAGE'), None)
        self.assertIsNotNone(stage, 'Fanout must receive the application stage')
        self.assertEqual(stage['valueFrom']['configMapKeyRef'], {'name': 'test-config', 'key': 'APP_STAGE'})

    def test_external_mongo_omits_local_resources_and_requires_secret_uri(self):
        objects = self.render({'externalMongo': {'enabled': True}})
        self.assertFalse(any(obj['metadata']['name'] in ['test-mongo', 'test-mongo-data'] for obj in objects))
        config = next(obj for obj in objects if obj['metadata']['name'] == 'test-config')
        scripts = next(obj for obj in objects if obj['metadata']['name'] == 'test-scripts')
        self.assertNotIn('MONGODB_URI', config['data'])
        self.assertNotIn('mongo-dns-guard.sh', scripts['data'])
        app = next(obj for obj in objects if obj['metadata']['name'] == 'test-app' and obj['kind'] == 'Deployment')
        wait = next(c for c in app['spec']['template']['spec']['initContainers'] if c['name'] == 'wait-mongo')
        uri = next(e for e in wait['env'] if e['name'] == 'MONGODB_URI')
        self.assertEqual(uri['valueFrom']['secretKeyRef'], {'name': 'runtime', 'key': 'MONGODB_URI'})
        self.assertNotIn('optional', uri['valueFrom']['secretKeyRef'])
        self.assertIn('process.env.MONGODB_URI', wait['command'][-1])
        self.assertNotIn('mongosh "$MONGODB_URI"', wait['command'][-1])
        self.assertNotIn('rs.initiate', str(wait))
        self.assertEqual(len([o for o in objects if o['kind'] == 'PersistentVolumeClaim']), 2)

    def test_local_mongo_explicit_uri_overrides_lingering_secret_key(self):
        objects = self.render({'agentExecutor': {'enabled': True, 'image': 'example/executor:tested'}})
        config = next(obj for obj in objects if obj['metadata']['name'] == 'test-config')
        self.assertEqual(config['data']['MONGODB_URI'], 'mongodb://test-mongo-0.test-mongo:27017/bike4mind?replicaSet=rs0')
        checked = 0
        for obj in objects:
            if obj['kind'] not in ['Deployment', 'StatefulSet', 'Job']:
                continue
            pod = obj['spec']['template']['spec']
            for container in pod.get('containers', []) + pod.get('initContainers', []):
                if not container.get('envFrom'):
                    continue
                uri = [entry for entry in container['env'] if entry['name'] == 'MONGODB_URI']
                self.assertEqual(len(uri), 1, container['name'])
                self.assertEqual(uri[0]['valueFrom'], {'configMapKeyRef': {'name': 'test-config', 'key': 'MONGODB_URI'}})
                self.assertEqual(container['envFrom'][-1], {'secretRef': {'name': 'runtime'}})
                checked += 1
        self.assertGreaterEqual(checked, 6)

    def external_mongo_wait_command(self):
        objects = self.render({'externalMongo': {'enabled': True}})
        app = next(obj for obj in objects if obj['kind'] == 'Deployment' and obj['metadata']['name'] == 'test-app')
        wait = next(container for container in app['spec']['template']['spec']['initContainers'] if container['name'] == 'wait-mongo')
        return wait['command'][-1]

    def test_external_mongo_check_resolves_environment_and_fails_closed(self):
        javascript = self.external_mongo_wait_command().split("--eval '", 1)[1].split("' 2>/dev/null", 1)[0]
        cases = [
            ('mongodb://example/test', True, None, ''),
            ('mongodb://example/test?tls=true', True, None, ''),
            ('mongodb://example/test?connectTimeoutMS=5000', True, None, ''),
            ('mongodb+srv://example/test?connectTimeoutMS=5000&tls=true', True, None, ''),
            ('mongodb://first:27017,second:27017/test?connect%54imeoutMS=5000', True, None, ''),
            ('mongodb://example/test?serverSelectionTimeoutM%53=0&CONNECT%54IMEOUTMS=500&socketTimeout%4dS=900000', True, None, ''),
            ('mongodb://example/test?SERVERSELECTIONTIMEOUTMS=500&ConnectTimeoutMS=0&socketTimeoutMS=900000', True, None, ''),
            ('mongodb://example/test?connectTimeoutMS=500&CONNECTTIMEOUTMS=600', True, None, 'MongoInvalidArgumentError'),
            ('', True, None, 'MongoUriMissing'),
            ('mongodb://example/test', False, None, 'MongoNotWritablePrimary'),
            ('mongodb://example/test', True, 'MongoServerSelectionError', 'MongoServerSelectionError'),
            ('mongodb://example/test', True, 'MongoInvalidArgumentError', 'MongoInvalidArgumentError'),
            ('mongodb://example/test', True, 'untrusted mongodb://fake:credential@example/test', 'MongoConnectionError'),
        ]
        for uri, primary, error_name, reason in cases:
            with self.subTest(uri=uri, primary=primary, error_name=error_name):
                prelude = '''
                  process.env.MONGODB_URI = __URI__;
                  const quit = process.exit;
                  const print = console.log;
                  const connect = resolved => {
                    if (!resolved.startsWith(process.env.MONGODB_URI)) process.exit(2);
                    const query = value => new URLSearchParams(value.includes("?") ? value.slice(value.indexOf("?") + 1) : "");
                    const supplied = query(process.env.MONGODB_URI);
                    const options = new Map();
                    for (const [key, value] of query(resolved)) {
                      const normalized = key.toLowerCase();
                      if (options.has(normalized)) { const error = new Error("duplicated option"); error.name = "MongoInvalidArgumentError"; throw error; }
                      options.set(normalized, value);
                    }
                    for (const [key, value] of supplied) if (options.get(key.toLowerCase()) !== value) process.exit(2);
                    for (const key of ["serverselectiontimeoutms", "connecttimeoutms", "sockettimeoutms"]) {
                      if (!options.has(key)) process.exit(2);
                      const original = [...supplied].find(([name]) => name.toLowerCase() === key);
                      if (!original && options.get(key) !== "10000") process.exit(2);
                    }
                    if ([...supplied.keys()].length === 3 && resolved !== process.env.MONGODB_URI) process.exit(2);
                    if (__ERROR_NAME__ !== null) { const error = new Error("mongodb://fake:credential@example/test"); error.name = __ERROR_NAME__; throw error; }
                    return {hello: () => ({isWritablePrimary: __PRIMARY__})};
                  };
                '''.replace('__URI__', json.dumps(uri)).replace('__ERROR_NAME__', json.dumps(error_name)).replace('__PRIMARY__', str(primary).lower())
                result = subprocess.run(['node', '-e', prelude + javascript], capture_output=True, text=True)
                self.assertEqual(result.returncode, 1 if reason else 0, result.stderr)
                self.assertEqual(result.stdout, reason + '\n' if reason else '')
                self.assertEqual(result.stderr, '')
                self.assertNotIn('credential', result.stdout)
                self.assertNotIn('mongodb://', result.stdout)

    def test_external_mongo_shell_emits_only_safe_failure_reasons(self):
        command = self.external_mongo_wait_command().replace('seq 1 60', 'seq 1 1').replace('sleep 2', 'sleep 0')
        for diagnostic, expected in [('MongoNetworkError', 'MongoNetworkError'), ('mongodb://fake:credential@example/test', 'MongoConnectionError'), ('MongoNetworkError\nprivate detail', 'MongoConnectionError')]:
            with self.subTest(diagnostic=diagnostic), tempfile.TemporaryDirectory() as directory:
                timeout = pathlib.Path(directory) / 'timeout'
                timeout.write_text('#!/bin/sh\ntest "$1" = -k && test "$2" = 5s && test "$3" = 15s || exit 2\nshift 3\nexec "$@"\n')
                timeout.chmod(0o755)
                mongosh = pathlib.Path(directory) / 'mongosh'
                mongosh.write_text('#!/bin/sh\nprintf "%s\\n" "$FAKE_DIAGNOSTIC"\necho "private credential" >&2\nexit 1\n')
                mongosh.chmod(0o755)
                env = {**os.environ, 'PATH': directory + os.pathsep + os.environ['PATH'], 'FAKE_DIAGNOSTIC': diagnostic}
                result = subprocess.run(['/bin/sh', '-ec', command], env=env, text=True, capture_output=True, timeout=3)
                self.assertEqual(result.returncode, 1)
                self.assertEqual(result.stdout, '')
                self.assertEqual(result.stderr, expected + '\n')

    @unittest.skipUnless(shutil.which('timeout'), 'GNU timeout is required for the real process-bound test')
    def test_external_mongo_process_timeout_suppresses_connection_output(self):
        command = self.external_mongo_wait_command()
        self.assertIn('timeout -k 5s 15s mongosh', command)
        command = command.replace('timeout -k 5s 15s', 'timeout -k 0.1s 0.1s').replace('seq 1 60', 'seq 1 1').replace('sleep 2', 'sleep 0')
        with tempfile.TemporaryDirectory() as directory:
            shell = pathlib.Path(directory) / 'mongosh'
            shell.write_text('#!/bin/sh\necho "mongodb://fake:credential@example/test"\necho "fake credential" >&2\nsleep 30\n')
            shell.chmod(0o755)
            env = {**os.environ, 'PATH': directory + os.pathsep + os.environ['PATH'], 'MONGODB_URI': 'mongodb://example/test?connectTimeoutMS=0'}
            start = time.monotonic()
            result = subprocess.run(['/bin/sh', '-ec', command], env=env, text=True, capture_output=True, timeout=3)
        self.assertLess(time.monotonic() - start, 3)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, '')
        self.assertEqual(result.stderr, 'MongoProbeTimeout\n')

    def test_argocd_example_requires_manual_preparation(self):
        application = yaml.safe_load((CHART / 'argocd-application.example.yaml').read_text())
        spec = application['spec']
        self.assertNotIn('syncPolicy', spec)
        self.assertEqual(spec['source']['targetRevision'], 'REPLACE_WITH_IMMUTABLE_COMMIT_SHA')
        values = spec['source']['helm']['valuesObject']
        self.assertEqual(values['existingSecret'], 'bike4mind-runtime')
        self.assertFalse(values['externalMongo']['enabled'])
        self.assertEqual(values['storage']['className'], 'gp3-retain')
        self.assertTrue(all('localhost' in value for value in values['config'].values()))
        invalid = self.render(values, success=False)
        self.assertRegex(invalid.stderr, r'images[/.](app|chatcompletion|ws|minio|mc|subscriberFanout)')
        valid = {key: value for key, value in values.items() if key != 'images'}
        objects = self.render(valid)
        self.assertTrue(any(obj['metadata']['name'] == 'test-mongo' and obj['kind'] == 'StatefulSet' for obj in objects))
        claims = [obj for obj in objects if obj['kind'] == 'PersistentVolumeClaim']
        self.assertEqual(len(claims), 3)
        self.assertTrue(all(obj['spec']['storageClassName'] == 'gp3-retain' for obj in claims))

    def test_external_mongo_uri_cannot_be_supplied_in_values(self):
        result = self.render({'externalMongo': {'enabled': True}, 'config': {'MONGODB_URI': 'mongodb://example/db'}}, success=False)
        self.assertIn('never config values', result.stderr)

    def test_external_mongo_example_uses_documented_runtime_secret(self):
        example = yaml.safe_load((CHART / 'external-mongo.example.yaml').read_text())
        self.assertEqual(example['existingSecret'], 'bike4mind-runtime')
        objects = self.render(example)
        self.assertFalse(any(obj['kind'] == 'StatefulSet' and obj['metadata']['name'] == 'test-mongo' for obj in objects))

    def test_missing_secret_floating_image_and_secret_in_values_fail(self):
        cases = [
            ({'existingSecret': ''}, r'existingSecret'),
            ({'images': {'app': 'example/app:latest'}}, r'images[/.]app'),
            ({'config': {'JWT_SECRET': 'unsafe'}}, r'JWT_SECRET'),
        ]
        for overrides, reason in cases:
            with self.subTest(overrides=overrides):
                result = self.render(overrides, success=False)
                self.assertRegex(result.stderr, reason)

if __name__ == '__main__':
    unittest.main()
