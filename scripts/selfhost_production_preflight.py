#!/usr/bin/env python3
"""Read-only checks for an explicitly selected self-host Compose configuration."""

import argparse
import ipaddress
import json
import re
import shlex
import subprocess
from urllib.parse import urlsplit


INTERNAL_SERVICES = {
    'app', 'ws', 'worker', 'chatcompletion', 'agentexecutor', 'subscriber-fanout',
    'mongo', 'minio', 'sqs', 'mail', 'opensearch', 'ollama', 'searxng', 'imagegen',
}
INTERNAL_IMAGES = {'mongo', 'minio', 'elasticmq', 'elasticmq-native', 'mailpit', 'mailhog',
                   'opensearch', 'ollama', 'searxng'}
MESSAGES = {
    'app.selected': 'Select the app service with B4M_SELF_HOST=true.',
    'app.public-urls': 'Configure an HTTPS APP_URL origin and WSS WEBSOCKET_URL for browsers.',
    'app.secrets': 'Replace missing/template signing secrets and configure valid encryption keys.',
    'mail.catcher': 'Remove active development mail catchers from the selected deployment.',
    'mail.configuration': 'Configure the actual app SMTP settings instead of development defaults.',
    'mongo.auth-config': 'Active Mongo needs an explicit supported mongod auth command; custom entrypoints/config files require separate verification.',
    'mongo.client-auth': 'Configure credentials in the local Mongo connection URI; non-password authentication needs separate verification.',
    'mongo.connection': 'Configure a Mongo connection URI; external database authentication remains unverified.',
    'storage.credentials': 'Replace local MinIO default credentials and configure non-template credentials for local storage clients.',
    'internal.shared-secrets': 'Configure matching non-template secrets on the app and selected runtime services.',
    'internal.network-boundaries': 'Keep application and backing-service host publishes on loopback; host networking is not checked as an isolated deployment.',
}


def placeholder(value):
    text = str(value or '').strip().lower()
    return (not text or text in {'selfhost', 'minioadmin', 'not-configured'}
            or any(token in text for token in ('change-me', 'replace-with', 'replace-me')))


def image_name(service):
    return service.get('image', '').split('@')[0].split('/')[-1].split(':')[0].lower()


def loopback(host):
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return host.lower().rstrip('.') == 'localhost'


def public_url(value, scheme, origin=False):
    try:
        url = urlsplit(value or '')
        return (url.scheme == scheme and bool(url.hostname) and not loopback(url.hostname)
                and url.username is None and url.password is None and not url.query and not url.fragment
                and (not origin or not url.path) and (url.port is None or 0 < url.port < 65536))
    except ValueError:
        return False


def service_hosts(name, service):
    hosts = {name, service.get('hostname'), service.get('container_name')}
    for network in (service.get('networks') or {}).values():
        if network:
            hosts.update(network.get('aliases', []))
    return {host.lower() for host in hosts if isinstance(host, str)}


def mongo_hosts(uri):
    # Mongo seed lists can contain multiple hosts, unlike an ordinary URL authority.
    authority = uri.split('://', 1)[1].split('/', 1)[0].rsplit('@', 1)[-1]
    return {urlsplit('//' + host).hostname for host in authority.split(',')}


def check_config(model):
    services = model['services']
    app = services.get('app', {})
    env = app.get('environment') or {}
    failures = set()
    if not app or env.get('B4M_SELF_HOST') != 'true':
        failures.add('app.selected')
    if not public_url(env.get('APP_URL'), 'https', origin=True) or not public_url(env.get('WEBSOCKET_URL'), 'wss'):
        failures.add('app.public-urls')
    if (any(placeholder(env.get(key)) for key in ('JWT_SECRET', 'SESSION_SECRET'))
            or not re.fullmatch(r'[0-9a-fA-F]{64}', env.get('SECRET_ENCRYPTION_KEY') or '')
            or (env.get('SECRET_ENCRYPTION_KEY_PREVIOUS')
                and not re.fullmatch(r'[0-9a-fA-F]{64}', env['SECRET_ENCRYPTION_KEY_PREVIOUS']))):
        failures.add('app.secrets')

    host_map = {host: name for name, service in services.items() for host in service_hosts(name, service)}
    smtp_host = str(env.get('MAIL_HOST') or '').lower()
    smtp_port = str(env.get('MAIL_PORT') or '')
    username, password = env.get('MAIL_USERNAME'), env.get('MAIL_PASSWORD')
    if (placeholder(smtp_host) or loopback(smtp_host) or (smtp_host == 'mail' and smtp_host not in host_map)
            or not smtp_port.isdigit() or not 0 < int(smtp_port) < 65536
            or (bool(username) != bool(password))
            or (username and (placeholder(username) or placeholder(password)))
            or not env.get('MAIL_FROM') or '@' not in env['MAIL_FROM']
            or env['MAIL_FROM'].lower().endswith('@selfhost.local')):
        failures.add('mail.configuration')

    local_mongo_hosts = {host for name, service in services.items()
                         if name == 'mongo' or image_name(service) == 'mongo'
                         for host in service_hosts(name, service)}
    mongo_uris = {str(env.get('MONGODB_URI') or '')}
    mongo_uris.update(str(service['environment']['MONGODB_URI'] or '')
                      for service in services.values() if 'MONGODB_URI' in (service.get('environment') or {}))
    for uri in mongo_uris:
        if not uri.startswith(('mongodb://', 'mongodb+srv://')):
            failures.add('mongo.connection')
            continue
        try:
            db_hosts = mongo_hosts(uri)
        except ValueError:
            db_hosts = set()
        if not db_hosts or None in db_hosts:
            failures.add('mongo.connection')
        if db_hosts.intersection(local_mongo_hosts):
            credentials = uri.split('://', 1)[1].split('/', 1)[0].rsplit('@', 1)
            if len(credentials) != 2 or ':' not in credentials[0] or not all(credentials[0].split(':', 1)):
                failures.add('mongo.client-auth')

    for name, service in services.items():
        image = image_name(service)
        service_env = service.get('environment') or {}
        if image in {'mailpit', 'mailhog'}:
            failures.add('mail.catcher')
        if name in INTERNAL_SERVICES or image in INTERNAL_IMAGES or service_env.get('B4M_SELF_HOST') == 'true':
            if service.get('network_mode') == 'host' or any(
                port.get('published') and not loopback(port.get('host_ip') or '0.0.0.0')
                for port in service.get('ports', [])
            ):
                failures.add('internal.network-boundaries')
        if name == 'mongo' or image == 'mongo':
            command = service.get('command') or []
            if isinstance(command, str):
                command = shlex.split(command)
            flags = {item.split('=')[0] for item in command}
            if (service.get('entrypoint') or not command or command[0] != 'mongod'
                    or not flags.intersection({'--auth', '--keyFile'})
                    or flags.intersection({'--noauth', '--transitionToAuth', '--config', '-f'})):
                failures.add('mongo.auth-config')
        if name == 'minio' or image == 'minio':
            user, secret = service_env.get('MINIO_ROOT_USER'), service_env.get('MINIO_ROOT_PASSWORD')
            if placeholder(user) or placeholder(secret):
                failures.add('storage.credentials')
            for client in services.values():
                client_env = client.get('environment') or {}
                storage_host = urlsplit(client_env.get('AWS_ENDPOINT_URL_S3') or '').hostname
                if storage_host in service_hosts(name, service) and (
                    placeholder(client_env.get('AWS_ACCESS_KEY_ID')) or placeholder(client_env.get('AWS_SECRET_ACCESS_KEY'))
                ):
                    failures.add('storage.credentials')

    for name, key in (('ws', 'INTERNAL_WS_SECRET'), ('subscriber-fanout', 'INTERNAL_WS_SECRET'),
                      ('chatcompletion', 'CHAT_COMPLETION_INTERNAL_SECRET'),
                      ('agentexecutor', 'AGENT_EXECUTOR_INTERNAL_SECRET')):
        if name in services:
            value = (services[name].get('environment') or {}).get(key)
            if placeholder(value) or value != env.get(key):
                failures.add('internal.shared-secrets')
    for name in ('worker', 'chatcompletion', 'agentexecutor'):
        if name in services:
            worker_env = services[name].get('environment') or {}
            if any(worker_env.get(key) != env.get(key) for key in ('JWT_SECRET', 'SESSION_SECRET', 'SECRET_ENCRYPTION_KEY')):
                failures.add('internal.shared-secrets')
    minio_env = (services.get('minio', {}).get('environment') or {})
    if minio_env.get('MINIO_NOTIFY_WEBHOOK_ENABLE_primary') == 'on':
        key = env.get('INTERNAL_S3_WEBHOOK_SECRET')
        if placeholder(key) or minio_env.get('MINIO_NOTIFY_WEBHOOK_AUTH_TOKEN_primary') != key:
            failures.add('internal.shared-secrets')
    return sorted(failures)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('-f', '--file', action='append', required=True, help='Compose file, in deployment merge order')
    parser.add_argument('--env-file', required=True, help='Explicit interpolation environment file')
    parser.add_argument('--profile', action='append', default=[])
    parser.add_argument('--project-directory')
    args = parser.parse_args(argv)
    command = ['docker', 'compose']
    for file in args.file:
        command.extend(['-f', file])
    command.extend(['--env-file', args.env_file])
    for profile in args.profile:
        command.extend(['--profile', profile])
    if args.project_directory:
        command.extend(['--project-directory', args.project_directory])
    command.extend(['config', '--format', 'json'])
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=60, check=False)
        if result.returncode:
            print('FAIL compose.configuration: Compose could not resolve the selected configuration; diagnostic output suppressed to protect secrets.')
            return 2
        failures = check_config(json.loads(result.stdout))
    except (OSError, subprocess.TimeoutExpired, ValueError, TypeError, KeyError, AttributeError):
        print('FAIL compose.configuration: Could not inspect the selected configuration; diagnostic output suppressed to protect secrets.')
        return 2
    for failure in failures:
        print(f'FAIL {failure}: {MESSAGES[failure]}')
    if failures:
        return 1
    print('preflight checks passed; live TLS/mail/auth/restore not proven')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
