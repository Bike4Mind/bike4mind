import json
import pathlib
import subprocess
import tempfile
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

    def test_missing_secret_floating_image_and_secret_in_values_fail(self):
        for overrides in [{'existingSecret': ''}, {'images': {'app': 'example/app:latest'}}, {'config': {'JWT_SECRET': 'unsafe'}}]:
            with self.subTest(overrides=overrides):
                self.render(overrides, success=False)

if __name__ == '__main__':
    unittest.main()
