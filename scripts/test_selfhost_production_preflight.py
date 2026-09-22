import copy
import io
import json
import os
from pathlib import Path
import shutil
import tempfile
import subprocess
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

from selfhost_production_preflight import check_config, main


def configured_stack():
    env = {
        'B4M_SELF_HOST': 'true',
        'APP_URL': 'https://chat.example.org',
        'WEBSOCKET_URL': 'wss://chat.example.org/ws',
        'JWT_SECRET': 'j' * 64,
        'SESSION_SECRET': 's' * 64,
        'SECRET_ENCRYPTION_KEY': 'a' * 64,
        'INTERNAL_WS_SECRET': 'w' * 64,
        'CHAT_COMPLETION_INTERNAL_SECRET': 'c' * 64,
        'INTERNAL_S3_WEBHOOK_SECRET': 'h' * 64,
        'MONGODB_URI': 'mongodb://operator:db-password@mongo:27017/app?replicaSet=rs0&authSource=admin',
        'MAIL_HOST': 'smtp.example.org',
        'MAIL_PORT': '587',
        'MAIL_USERNAME': 'sender',
        'MAIL_PASSWORD': 'smtp-password',
        'MAIL_FROM': 'sender@example.org',
    }
    return {'services': {
        'app': {'environment': env, 'ports': [{'target': 3000, 'host_ip': '127.0.0.1', 'published': '3000'}]},
        'mongo': {'image': 'mongo:7', 'command': ['mongod', '--auth', '--replSet', 'rs0']},
        'sqs': {'image': 'softwaremill/elasticmq-native'},
        'ws': {'environment': {'INTERNAL_WS_SECRET': 'w' * 64}},
        'chatcompletion': {'environment': copy.deepcopy(env)},
    }}


class PreflightTests(unittest.TestCase):
    def test_configured_local_dependencies_pass_without_a_specific_proxy(self):
        self.assertEqual(check_config(configured_stack()), [])

    def test_app_must_be_selected_as_selfhost(self):
        model = configured_stack()
        model['services']['app']['environment']['B4M_SELF_HOST'] = 'false'
        self.assertIn('app.selected', check_config(model))

    def test_missing_and_malformed_database_uris_fail(self):
        for uri in ('', 'https://db.example.org', 'mongodb://', 'mongodb://[invalid/app'):
            with self.subTest(uri=uri):
                model = configured_stack()
                model['services']['app']['environment']['MONGODB_URI'] = uri
                self.assertIn('mongo.connection', check_config(model))

    def test_active_runtime_database_override_is_checked(self):
        model = configured_stack()
        model['services']['chatcompletion']['environment']['MONGODB_URI'] = 'mongodb://mongo:27017/app'
        self.assertIn('mongo.client-auth', check_config(model))

    def test_external_database_does_not_require_a_local_mongo_service(self):
        model = configured_stack()
        del model['services']['mongo']
        for name in ('app', 'chatcompletion'):
            model['services'][name]['environment']['MONGODB_URI'] = 'mongodb+srv://db.example.org/app'
        self.assertEqual(check_config(model), [])

    def test_external_database_does_not_hide_an_active_unauthenticated_mongo(self):
        model = configured_stack()
        model['services']['app']['environment']['MONGODB_URI'] = 'mongodb+srv://db.example.org/app'
        model['services']['mongo']['command'] = ['mongod', '--replSet', 'rs0']
        self.assertIn('mongo.auth-config', check_config(model))

    def test_local_database_uri_needs_credentials_but_external_auth_is_not_inferred(self):
        model = configured_stack()
        model['services']['app']['environment']['MONGODB_URI'] = 'mongodb://mongo:27017/app'
        self.assertIn('mongo.client-auth', check_config(model))

    def test_custom_mongo_auth_cannot_pass_by_containing_an_auth_string(self):
        for command in (['sh', '-c', 'echo --auth'], ['mongod', '--auth', '--noauth'],
                        ['mongod', '--keyFile', '/key', '--transitionToAuth']):
            with self.subTest(command=command):
                model = configured_stack()
                model['services']['mongo']['command'] = command
                self.assertIn('mongo.auth-config', check_config(model))

    def test_catcher_is_rejected_even_when_app_points_at_real_smtp(self):
        model = configured_stack()
        model['services']['mail'] = {'image': 'axllent/mailpit:v1.20'}
        self.assertIn('mail.catcher', check_config(model))

    def test_internal_smtp_service_named_mail_is_not_automatically_a_catcher(self):
        model = configured_stack()
        model['services']['mail'] = {'image': 'operator/smtp-relay:1'}
        model['services']['app']['environment']['MAIL_HOST'] = 'mail'
        model['services']['app']['environment']['MAIL_PORT'] = '25'
        self.assertEqual(check_config(model), [])

    def test_authless_smtp_relay_is_supported(self):
        model = configured_stack()
        env = model['services']['app']['environment']
        env.update(MAIL_PORT='25', MAIL_USERNAME='', MAIL_PASSWORD='')
        self.assertEqual(check_config(model), [])

    def test_local_storage_accepts_non_root_client_credentials_but_not_defaults(self):
        model = configured_stack()
        model['services']['minio'] = {'image': 'minio/minio', 'environment': {
            'MINIO_ROOT_USER': 'operator', 'MINIO_ROOT_PASSWORD': 'private-root-password',
        }}
        env = model['services']['app']['environment']
        env.update(AWS_ENDPOINT_URL_S3='http://minio:9000',
                   AWS_ACCESS_KEY_ID='app-service-account', AWS_SECRET_ACCESS_KEY='private-app-password')
        self.assertEqual(check_config(model), [])
        env['AWS_SECRET_ACCESS_KEY'] = 'minioadmin'
        self.assertIn('storage.credentials', check_config(model))
        env['AWS_SECRET_ACCESS_KEY'] = 'private-app-password'
        model['services']['minio']['environment']['MINIO_ROOT_PASSWORD'] = 'minioadmin'
        self.assertIn('storage.credentials', check_config(model))

    def test_each_active_storage_client_uses_non_template_credentials(self):
        for role in ('worker', 'chatcompletion', 'agentexecutor'):
            with self.subTest(role=role):
                model = configured_stack()
                app_env = model['services']['app']['environment']
                model['services']['minio'] = {'image': 'minio/minio', 'environment': {
                    'MINIO_ROOT_USER': 'operator', 'MINIO_ROOT_PASSWORD': 'root-password',
                }}
                runtime_env = copy.deepcopy(app_env)
                runtime_env.update(AWS_ENDPOINT_URL_S3='http://minio:9000',
                                   AWS_ACCESS_KEY_ID='minioadmin', AWS_SECRET_ACCESS_KEY='minioadmin')
                if role == 'agentexecutor':
                    app_env['AGENT_EXECUTOR_INTERNAL_SECRET'] = 'executor-secret'
                    runtime_env['AGENT_EXECUTOR_INTERNAL_SECRET'] = 'executor-secret'
                model['services'][role] = {'environment': runtime_env}
                self.assertIn('storage.credentials', check_config(model))
                runtime_env.update(AWS_ACCESS_KEY_ID='scoped-account', AWS_SECRET_ACCESS_KEY='scoped-secret')
                self.assertEqual(check_config(model), [])
                runtime_env.update(AWS_ENDPOINT_URL_S3='https://external.example.org',
                                   AWS_ACCESS_KEY_ID='', AWS_SECRET_ACCESS_KEY='')
                self.assertEqual(check_config(model), [])

    def test_missing_or_template_mail_configuration_is_rejected(self):
        for key, value in [('MAIL_HOST', ''), ('MAIL_PORT', 'not-a-port'),
                           ('MAIL_PASSWORD', 'selfhost'), ('MAIL_FROM', 'bike4mind@selfhost.local')]:
            with self.subTest(key=key):
                model = configured_stack()
                model['services']['app']['environment'][key] = value
                self.assertIn('mail.configuration', check_config(model))

    def test_development_mail_host_without_active_service_is_rejected(self):
        model = configured_stack()
        model['services']['app']['environment']['MAIL_HOST'] = 'mail'
        self.assertIn('mail.configuration', check_config(model))

    def test_signing_keys_and_encryption_keys_are_checked_without_echoing_them(self):
        for key, value in [('JWT_SECRET', 'change-me-openssl-rand-hex-32'),
                           ('SESSION_SECRET', ''), ('SECRET_ENCRYPTION_KEY', 'not-hex'),
                           ('SECRET_ENCRYPTION_KEY_PREVIOUS', 'not-hex')]:
            with self.subTest(key=key):
                model = configured_stack()
                model['services']['app']['environment'][key] = value
                self.assertIn('app.secrets', check_config(model))

    def test_gateway_must_share_actual_app_secret(self):
        model = configured_stack()
        model['services']['ws']['environment']['INTERNAL_WS_SECRET'] = 'different-secret'
        self.assertIn('internal.shared-secrets', check_config(model))

    def test_https_and_wss_are_not_inferred_from_an_enabled_proxy(self):
        for key, value in [('APP_URL', 'http://chat.example.org'),
                           ('APP_URL', 'https://chat.example.org/path'),
                           ('WEBSOCKET_URL', 'ws://chat.example.org/ws')]:
            with self.subTest(key=key):
                model = configured_stack()
                model['services']['caddy'] = {'image': 'caddy:2'}
                model['services']['app']['environment'][key] = value
                self.assertIn('app.public-urls', check_config(model))

    def test_public_internal_ports_and_host_network_are_rejected(self):
        for name in ('sqs', 'mongo', 'app', 'ws', 'chatcompletion'):
            for update in ({'ports': [{'target': 9324, 'published': '9324'}]}, {'network_mode': 'host'}):
                with self.subTest(name=name, update=update):
                    model = configured_stack()
                    model['services'][name].update(update)
                    self.assertIn('internal.network-boundaries', check_config(model))

    def test_ipv6_loopback_publish_is_accepted(self):
        model = configured_stack()
        model['services']['sqs']['ports'] = [{'target': 9324, 'published': '9324', 'host_ip': '::1'}]
        self.assertEqual(check_config(model), [])

    def test_selected_profiles_and_explicit_files_are_passed_to_compose_config_only(self):
        result = subprocess.CompletedProcess([], 0, json.dumps(configured_stack()), 'private-warning')
        output = io.StringIO()
        with patch('selfhost_production_preflight.subprocess.run', return_value=result) as run, redirect_stdout(output):
            code = main(['-f', 'base.yaml', '-f', 'prod.yaml', '--env-file', 'prod.env', '--profile', 'proxy'])
        self.assertEqual(code, 0)
        self.assertEqual(run.call_args.args[0], ['docker', 'compose', '-f', 'base.yaml', '-f', 'prod.yaml',
                                               '--env-file', 'prod.env', '--profile', 'proxy',
                                               'config', '--format', 'json'])
        self.assertIn('preflight checks passed; live TLS/mail/auth/restore not proven', output.getvalue())
        self.assertNotIn('private-warning', output.getvalue())
        self.assertNotIn('smtp-password', output.getvalue())

    def test_compose_errors_and_invalid_json_never_print_the_resolved_config(self):
        for code, stdout in [(1, 'super-private-config'), (0, 'super-private-invalid-json')]:
            with self.subTest(code=code):
                output = io.StringIO()
                result = subprocess.CompletedProcess([], code, stdout, 'super-private-error')
                with patch('selfhost_production_preflight.subprocess.run', return_value=result), redirect_stdout(output):
                    self.assertEqual(main(['-f', 'base.yaml', '--env-file', 'prod.env']), 2)
                self.assertNotIn('super-private', output.getvalue())


@unittest.skipUnless(os.environ.get('B4M_PREFLIGHT_COMPOSE_TESTS') == '1' and shutil.which('docker'),
                     'Set B4M_PREFLIGHT_COMPOSE_TESTS=1 to check real Compose config resolution')
class ComposeIntegrationTests(unittest.TestCase):
    def test_current_base_and_caddy_still_fail_the_production_checks(self):
        root = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as directory:
            env_file = Path(directory) / '.env.selfhost'
            env_file.write_text((root / '.env.selfhost.example').read_text()
                                + '\nB4M_DOMAIN=chat.example.org\n')
            for caddy in (False, True):
                with self.subTest(caddy=caddy):
                    args = ['-f', str(root / 'compose.selfhost.yaml'), '--env-file', str(env_file),
                            '--project-directory', directory]
                    if caddy:
                        args += ['-f', str(root / 'compose.caddy.yaml'), '--profile', 'proxy']
                    output = io.StringIO()
                    with redirect_stdout(output):
                        self.assertEqual(main(args), 1)
                    for rule in ('mongo.auth-config', 'mongo.client-auth', 'mail.catcher',
                                 'mail.configuration', 'storage.credentials', 'app.secrets', 'app.public-urls'):
                        self.assertIn('FAIL ' + rule + ':', output.getvalue())
                    self.assertEqual('FAIL internal.network-boundaries:' in output.getvalue(), not caddy)
                    self.assertNotIn('minioadmin', output.getvalue())

    def test_compose_selects_only_active_profile_services(self):
        model = configured_stack()
        model['services']['catcher'] = {'image': 'axllent/mailpit:v1.20', 'profiles': ['development']}
        # Compose requires an image/build even for config-only service fixtures.
        for service in model['services'].values():
            service.setdefault('image', 'example/service:1')
        with tempfile.TemporaryDirectory() as directory:
            compose_file = Path(directory) / 'compose.json'
            compose_file.write_text(json.dumps(model))
            env_file = Path(directory) / 'empty.env'
            env_file.touch()
            args = ['-f', str(compose_file), '--env-file', str(env_file)]
            with redirect_stdout(io.StringIO()):
                self.assertEqual(main(args), 0)
            output = io.StringIO()
            with redirect_stdout(output):
                self.assertEqual(main(args + ['--profile', 'development']), 1)
            self.assertIn('FAIL mail.catcher:', output.getvalue())


if __name__ == '__main__':
    unittest.main()
