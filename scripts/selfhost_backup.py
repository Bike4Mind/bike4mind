#!/usr/bin/env python3
"""Back up and restore self-host Compose state: MongoDB plus every MinIO user-data bucket.

Online and logical: `mongodump --oplog` (point-in-time consistent) then `mc mirror`
per bucket. Mongo is dumped first, so an object may exist without a database row
(harmless) but never the reverse. Python stdlib only; see SELF_HOST.md#backup-and-restore.
"""

import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
from urllib.parse import urlsplit, urlunsplit

BUCKET_KEYS = [
    'APP_FILES_BUCKET', 'EMAIL_INGESTION_BUCKET', 'FAB_FILE_BUCKET',
    'GENERATED_IMAGES_BUCKET', 'HISTORY_IMPORT_BUCKET',
    'PUBLISHED_ARTIFACTS_BUCKET', 'SLACK_EXPORT_BUCKET',
]
MONGO_ARCHIVE = 'mongo.archive.gz'
URI_ENV = 'B4M_BACKUP_MONGODB_URI'  # passed by name, so the value never lands in argv
SYSTEM_DBS = {'admin', 'local', 'config'}
MC_ALIAS = 'mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null'


def resolve_targets(config):
    """Return (mongo_uri, {bucket_key: name}) from `docker compose config --format json`."""
    services = config['services']
    env = services['createbuckets'].get('environment') or {}
    buckets = {key: env.get(key) for key in BUCKET_KEYS}
    missing = [key for key, name in buckets.items() if not name]
    if missing:
        raise ValueError('Bucket names not configured: ' + ', '.join(missing))
    uri = (services.get('app', {}).get('environment') or {}).get('MONGODB_URI') or env.get('MONGODB_URI')
    if not uri:
        raise ValueError('MONGODB_URI is not configured')
    return uri, buckets


def instance_uri(uri):
    """Drop the database path: --oplog only works on a whole-instance dump."""
    parts = urlsplit(uri)
    return urlunsplit((parts.scheme, parts.netloc, '/', parts.query, ''))


def exec_cmd(compose, *inner):
    return [*compose, 'exec', '-T', '-e', URI_ENV, 'mongo', 'sh', '-c', *inner]


def mongodump_cmd(compose):
    return exec_cmd(compose, f'mongodump --uri "${URI_ENV}" --oplog --archive --gzip --quiet')


def mongorestore_cmd(compose):
    return exec_cmd(compose, f'mongorestore --uri "${URI_ENV}" --drop --oplogReplay --archive --gzip --quiet')


def mongo_user_dbs_cmd(compose):
    js = 'db.getMongo().getDBNames().filter(n => !' + json.dumps(sorted(SYSTEM_DBS)) + '.includes(n)).join(",")'
    return exec_cmd(compose, f'mongosh "${URI_ENV}" --quiet --eval {shlex.quote(js)}')


def mc_cmd(compose, objects_dir, script, read_only):
    mount = f'{objects_dir}:/backup' + (':ro' if read_only else '')
    return [*compose, 'run', '--rm', '--no-deps', '-v', mount,
            '--entrypoint', '/bin/sh', 'createbuckets', '-ec', script]


def mirror_script(buckets, restore):
    lines = [MC_ALIAS]
    for name in buckets:
        q = shlex.quote(name)
        if restore:
            lines.append(f'mc mirror --quiet --overwrite /backup/{q} local/{q}')
        else:
            lines.append(f'mkdir -p /backup/{q} && mc mirror --quiet local/{q} /backup/{q}')
    return '; '.join(lines)


def count_files(directory):
    return sum(1 for p in Path(directory).rglob('*') if p.is_file())


def sha256(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b''):
            digest.update(chunk)
    return digest.hexdigest()


def utcnow():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def build_manifest(dest, buckets, started, finished, revision):
    archive = Path(dest) / MONGO_ARCHIVE
    return {
        'version': 1, 'started': started, 'finished': finished, 'revision': revision,
        'mongo': {'file': MONGO_ARCHIVE, 'bytes': archive.stat().st_size, 'sha256': sha256(archive)},
        'buckets': {name: {'objects': count_files(Path(dest) / 'objects' / name)}
                    for name in buckets.values()},
    }


def check_manifest(dest, buckets):
    """Load and verify a backup directory against the target stack's bucket set."""
    manifest = json.loads((Path(dest) / 'manifest.json').read_text())
    if manifest.get('version') != 1:
        raise ValueError('Unsupported manifest version')
    if set(manifest['buckets']) != set(buckets.values()):
        raise ValueError('Backup bucket set does not match the target configuration')
    if sha256(Path(dest) / manifest['mongo']['file']) != manifest['mongo']['sha256']:
        raise ValueError('Mongo archive checksum mismatch')
    for name, info in manifest['buckets'].items():
        if count_files(Path(dest) / 'objects' / name) != info['objects']:
            raise ValueError(f'Object count mismatch for bucket {name}')
    return manifest


def run(cmd, env=None, **kwargs):
    return subprocess.run(cmd, check=True, text=True, env=env, **kwargs)


def load(args):
    compose = ['docker', 'compose']
    for file in args.file or ['compose.selfhost.yaml']:
        compose += ['-f', file]
    if args.env_file:
        compose += ['--env-file', args.env_file]
    if args.project_name:
        compose += ['-p', args.project_name]
    for profile in args.profile:
        compose += ['--profile', profile]
    config = json.loads(run([*compose, 'config', '--format', 'json'], stdout=subprocess.PIPE).stdout)
    uri, buckets = resolve_targets(config)
    return compose, buckets, {**os.environ, URI_ENV: instance_uri(uri)}


def backup(args):
    compose, buckets, env = load(args)
    dest = Path(args.dest).resolve()
    if dest.exists() and any(dest.iterdir()):
        raise SystemExit(f'Refusing to write into non-empty {dest}')
    (dest / 'objects').mkdir(parents=True, exist_ok=True)
    started = utcnow()
    with open(dest / MONGO_ARCHIVE, 'wb') as out:
        run(mongodump_cmd(compose), env=env, stdout=out)
    run(mc_cmd(compose, dest / 'objects', mirror_script(buckets.values(), restore=False), False), env=env)
    revision = subprocess.run(['git', 'rev-parse', 'HEAD'], capture_output=True, text=True).stdout.strip()
    manifest = build_manifest(dest, buckets, started, utcnow(), revision)
    (dest / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(f'Backup complete: {dest}')
    print('Not included: .env.selfhost. Store it (especially SECRET_ENCRYPTION_KEY) separately and securely.')


def restore(args):
    compose, buckets, env = load(args)
    dest = Path(args.source).resolve()
    check_manifest(dest, buckets)
    run([*compose, 'up', '-d', '--no-deps', '--wait', 'mongo', 'minio'])
    existing = run(mongo_user_dbs_cmd(compose), env=env, stdout=subprocess.PIPE).stdout.strip()
    if existing and not args.yes:
        raise SystemExit(f'Target Mongo already has data ({existing}); restore into a fresh project or pass --yes to overwrite')
    run(mongorestore_cmd(compose), env=env, stdin=open(dest / MONGO_ARCHIVE, 'rb'))
    run([*compose, 'run', '--rm', '--no-deps', 'createbuckets'], env=env)  # buckets, webhooks, lifecycle
    run(mc_cmd(compose, dest / 'objects', mirror_script(buckets.values(), restore=True), True), env=env)
    print(f'Restore complete from {dest}')


def parser():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('-f', '--file', action='append', help='Compose file, repeatable (default: compose.selfhost.yaml)')
    p.add_argument('--env-file', default='.env.selfhost')
    p.add_argument('-p', '--project-name')
    p.add_argument('--profile', action='append', default=[])
    sub = p.add_subparsers(dest='command', required=True)
    b = sub.add_parser('backup', help='Dump Mongo and mirror all user-data buckets into an empty directory')
    b.add_argument('--dest', required=True)
    r = sub.add_parser('restore', help='Restore a backup directory into the selected project')
    r.add_argument('--from', dest='source', required=True)
    r.add_argument('--yes', action='store_true', help='Overwrite a target database that already has data')
    return p


def main(argv=None):
    args = parser().parse_args(argv)
    {'backup': backup, 'restore': restore}[args.command](args)
    return 0


if __name__ == '__main__':
    sys.exit(main())
