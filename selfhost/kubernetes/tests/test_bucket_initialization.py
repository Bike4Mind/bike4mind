import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).resolve().parents[1] / 'files/buckets.sh'

MC_STUB = r'''
import json, os, pathlib, sys
path = pathlib.Path(os.environ['MC_STATE'])
state = json.loads(path.read_text())
args = sys.argv[1:]
structured = '--json' in args
args = [arg for arg in args if arg != '--json']

def persist():
    path.write_text(json.dumps(state))

def flag(name, default=None):
    return args[args.index(name) + 1] if name in args else default

if args[:3] == ['ilm', 'rule', 'ls']:
    rules = state['rules'].get(args[-1], [])
    if os.environ.get('MC_FAIL') == 'read':
        print(json.dumps({'status':'error','error':{'cause':{'error':{'Code':'AccessDenied'}}}}))
        sys.exit(1)
    if os.environ.get('MC_FAIL') == 'malformed':
        print('not-json')
        sys.exit(0)
    if not rules:
        print(json.dumps({'status':'error','error':{'cause':{'error':{'Code':'NoSuchLifecycleConfiguration'}}}}))
        sys.exit(1)
    if structured:
        print(json.dumps({'status':'success','config':{'Rules':rules}}))
    else:
        print('\n'.join(rule.get('Filter', {}).get('Prefix', '') for rule in rules))
elif args[:3] in [['ilm', 'rule', 'add'], ['ilm', 'rule', 'edit']]:
    if os.environ.get('MC_FAIL') == 'write':
        sys.exit(1)
    rules = state['rules'].setdefault(args[-1], [])
    if args[2] == 'add':
        rule = {'ID':'created-' + str(sum(len(items) for items in state['rules'].values())), 'Status':'Enabled', 'Filter':{'Prefix':flag('--prefix', '')}, 'Expiration':{'Days':int(flag('--expire-days'))}}
        rules.append(rule)
    else:
        rule = next(rule for rule in rules if rule['ID'] == flag('--id'))
        rule['Expiration']['Days'] = int(flag('--expire-days'))
        rule['Expiration'].pop('Date', None)
        if '--enable' in args:
            rule['Status'] = 'Enabled'
    persist()
elif args[:1] == ['pipe']:
    sys.stdin.read()
    state['markers'].append(args[-1])
    persist()
elif args[:2] == ['alias', 'set'] or args[:1] == ['mb'] or args[:2] == ['event', 'add']:
    pass
else:
    sys.exit('unsupported mc invocation: ' + repr(args))
'''

def rule(identity, prefix, days, **extra):
    result = {'ID':identity, 'Status':'Enabled', 'Filter':{'Prefix':prefix}, 'Expiration':{'Days':days}}
    result.update(extra)
    return result

class BucketInitializationTests(unittest.TestCase):
    def run_initializer(self, rules, count=1, failure=None):
        with tempfile.TemporaryDirectory() as directory:
            state = pathlib.Path(directory) / 'state.json'
            state.write_text(json.dumps({'rules':rules, 'markers':[]}))
            client = pathlib.Path(directory) / 'mc'
            client.write_text('#!' + sys.executable + '\n' + MC_STUB)
            client.chmod(0o755)
            env = dict(os.environ, PATH=directory + ':' + os.environ['PATH'], MC_STATE=str(state), LOCAL_OBJECTSTORE_ENDPOINT='http://minio:9000', MINIO_ROOT_USER='test-user', MINIO_ROOT_PASSWORD='test-password-not-production', INITIALIZATION_REVISION='test', APP_FILES_BUCKET='app', EMAIL_INGESTION_BUCKET='email', FAB_FILE_BUCKET='fab', GENERATED_IMAGES_BUCKET='images', HISTORY_IMPORT_BUCKET='history', PUBLISHED_ARTIFACTS_BUCKET='published', SLACK_EXPORT_BUCKET='slack')
            if failure:
                env['MC_FAIL'] = failure
            result = None
            for _ in range(count):
                result = subprocess.run(['/bin/sh', str(SCRIPT)], env=env, text=True, capture_output=True, timeout=10)
            return result, json.loads(state.read_text())

    def assert_required(self, state):
        for bucket, prefix, days in [('published','drafts/',7), ('history','',7), ('fab','exports/',1), ('fab','generated-audio-offload/',1)]:
            policies = state['rules'].get('local/' + bucket, [])
            matches = [entry for entry in policies if entry['Status'] == 'Enabled' and entry['Filter'] == {'Prefix':prefix} and entry['Expiration'] == {'Days':days}]
            self.assertEqual(len(matches), 1, (bucket, prefix, policies))

    def test_unrelated_existing_rules_do_not_suppress_required_expirations(self):
        original = {'local/fab':[rule('audio','generated-audio-offload/',1)], 'local/published':[rule('archive','archive/',30)], 'local/history':[rule('logs','logs/',30)]}
        result, state = self.run_initializer(original, count=2)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_required(state)
        for bucket, rules in original.items():
            for entry in rules:
                self.assertIn(entry, state['rules'][bucket])

    def test_exact_existing_rules_are_not_duplicated(self):
        policies = {'local/fab':[rule('audio','generated-audio-offload/',1), rule('exports','exports/',1)], 'local/published':[rule('drafts','drafts/',7)], 'local/history':[rule('history','',7)]}
        result, state = self.run_initializer(policies, count=2)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(state['rules'], policies)

    def test_wrong_expiry_and_disabled_required_rules_are_reconciled(self):
        policies = {'local/fab':[rule('audio','generated-audio-offload/',90), rule('exports','exports/',20, Status='Disabled')], 'local/published':[rule('drafts','drafts/',30)], 'local/history':[rule('history','',20)]}
        result, state = self.run_initializer(policies, count=2)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_required(state)
        for bucket, rules in policies.items():
            self.assertEqual([entry['ID'] for entry in state['rules'][bucket]], [entry['ID'] for entry in rules])

    def test_tag_size_date_and_delete_marker_rules_are_preserved(self):
        tagged = rule('tagged','drafts/',7, Filter={'And':{'Prefix':'drafts/','Tags':[{'Key':'keep','Value':'yes'}]}})
        sized = rule('sized','exports/',1, Filter={'Prefix':'exports/','ObjectSizeGreaterThan':1024})
        zero_sized = rule('zero-sized','exports/',1, Filter={'Prefix':'exports/','ObjectSizeGreaterThan':0})
        dated = rule('dated','',0, Expiration={'Date':'2030-01-01T00:00:00Z'})
        marker = rule('delete-markers','generated-audio-offload/',0, Expiration={'DeleteMarker':True})
        transition = rule('transition-only','exports/',0, Expiration={}, Transition={'Days':30,'StorageClass':'GLACIER'})
        policies = {'local/fab':[sized, zero_sized, marker, transition], 'local/published':[tagged], 'local/history':[dated]}
        result, state = self.run_initializer(policies, count=2)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_required(state)
        for bucket, entries in policies.items():
            for entry in entries:
                self.assertIn(entry, state['rules'][bucket])

    def test_read_write_and_json_failures_never_publish_marker(self):
        policies = {'local/published':[rule('archive','archive/',30)]}
        for failure in ['read', 'write', 'malformed']:
            with self.subTest(failure=failure):
                result, state = self.run_initializer(policies, failure=failure)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(state['markers'], [])

    def test_fresh_buckets_initialize_once_per_policy(self):
        result, state = self.run_initializer({}, count=2)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_required(state)

if __name__ == '__main__':
    unittest.main()
