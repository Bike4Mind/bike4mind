#!/usr/bin/env python3
"""Back up and restore self-host Compose state: MongoDB plus every MinIO user-data bucket.

Online and logical: `mongodump --oplog` (point-in-time consistent) then `mc mirror`
per bucket. Mongo is dumped first, so an object may exist without a database row
(harmless); the reverse is rare and needs an object deleted or expired during the
backup window. Python stdlib only; see SELF_HOST.md#backup-and-restore.
"""

import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

BUCKET_KEYS = [
    'APP_FILES_BUCKET', 'EMAIL_INGESTION_BUCKET', 'FAB_FILE_BUCKET',
    'GENERATED_IMAGES_BUCKET', 'HISTORY_IMPORT_BUCKET',
    'PUBLISHED_ARTIFACTS_BUCKET', 'SLACK_EXPORT_BUCKET',
]
MONGO_ARCHIVE = 'mongo.archive.gz'
URI_ENV = 'B4M_BACKUP_MONGODB_URI'  # passed to docker by name; inside the container it is only read by shell builtins and a 0600 config file, never an argv
SYSTEM_DBS = {'admin', 'local', 'config'}
MONGO_HOST = 'mongo'
S3_HOST = 'minio'
MC_ALIAS = 'mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null'


def resolve_targets(config):
    """Return (mongo_uri, {bucket_key: name}) from `docker compose config --format json`."""
    services = config['services']
    env = services['createbuckets'].get('environment') or {}
    buckets = {key: env.get(key) for key in BUCKET_KEYS}
    missing = [key for key, name in buckets.items() if not name]
    if missing:
        raise ValueError('Bucket names not configured: ' + ', '.join(missing))
    app_env = services.get('app', {}).get('environment') or {}
    uri = app_env.get('MONGODB_URI') or env.get('MONGODB_URI')
    if not uri:
        raise ValueError('MONGODB_URI is not configured')
    hosts = urlsplit(uri).netloc.rpartition('@')[2].split(',')
    if any(host.rsplit(':', 1)[0] != MONGO_HOST for host in hosts):
        raise ValueError(f'MONGODB_URI does not point at the Compose {MONGO_HOST} service; '
                         'back up external MongoDB with your provider tooling')
    endpoint = app_env.get('AWS_ENDPOINT_URL_S3') or env.get('AWS_ENDPOINT_URL_S3')
    if urlsplit(endpoint or '').hostname != S3_HOST:
        raise ValueError(f'AWS_ENDPOINT_URL_S3 is not the Compose {S3_HOST} service; '
                         'back up external object storage with your provider tooling')
    return uri, buckets


def instance_uri(uri):
    """Drop the database path: --oplog only works on a whole-instance dump.

    With credentials and no authSource, the path database is the auth database, so keep it.
    """
    parts = urlsplit(uri)
    query = parse_qsl(parts.query, keep_blank_values=True)
    database = parts.path.lstrip('/')
    if '@' in parts.netloc and database and 'authSource' not in dict(query):
        query.append(('authSource', database))
    return urlunsplit((parts.scheme, parts.netloc, '/', urlencode(query), ''))


def exec_cmd(compose, *inner):
    return [*compose, 'exec', '-T', '-e', URI_ENV, 'mongo', 'sh', '-c', *inner]


def with_config(tool):
    """Run `tool` with the URI read from a 0600 temp config file.

    printf is a shell builtin and sed gets the URI on stdin, so the password is never
    in the argv of a process in the container (visible to `ps` on the host).
    """
    return ("umask 077; f=$(mktemp); trap 'rm -f \"$f\"' EXIT; "
            f"printf \"uri: '%s'\\n\" \"$(printf %s \"${URI_ENV}\" | sed \"s/'/''/g\")\" > \"$f\"; "
            f'{tool} --config "$f"')


def mongodump_cmd(compose):
    return exec_cmd(compose, with_config('mongodump --oplog --archive --gzip'))


def mongorestore_cmd(compose):
    """Never --drop: it replaces the admin users mid-restore, and the oplog replay that
    follows then runs unauthenticated whenever the target's root user is not the dump's.
    Overwriting existing data drops the user databases first (mongo_drop_dbs_cmd)."""
    return exec_cmd(compose, with_config('mongorestore --oplogReplay --stopOnError --archive --gzip'))


def user_dbs_cmd(compose, action):
    names = ('m.getDBNames().filter(n => !' + json.dumps(sorted(SYSTEM_DBS)) + '.includes(n))')
    js = f'const m = new Mongo(process.env.{URI_ENV}); const names = {names}; {action}'
    return exec_cmd(compose, f'mongosh --nodb --quiet --eval {shlex.quote(js)}')


def mongo_user_dbs_cmd(compose):
    return user_dbs_cmd(compose, 'print(names.join(","))')


def mongo_drop_dbs_cmd(compose):
    return user_dbs_cmd(compose, 'names.forEach(n => m.getDB(n).dropDatabase())')


def mc_cmd(compose, objects_dir, script, read_only):
    """Backup runs as the invoking user so the operator owns (and can rotate) the output."""
    mount = f'{objects_dir}:/backup' + (':ro' if read_only else '')
    user = [] if read_only else ['--user', f'{os.getuid()}:{os.getgid()}', '-e', 'MC_CONFIG_DIR=/tmp/.mc']
    return [*compose, 'run', '--rm', '--no-deps', *user, '-v', mount,
            '--entrypoint', '/bin/sh', 'createbuckets', '-ec', script]


def mirror_script(buckets, restore, remove=False):
    lines = [MC_ALIAS]
    for name in buckets:
        q = shlex.quote(name)
        if restore:
            lines.append(f'mc mirror --quiet --overwrite{" --remove" if remove else ""} /backup/{q} local/{q}')
        else:
            lines.append(f'mkdir -p /backup/{q} && mc mirror --quiet local/{q} /backup/{q}')
    return '; '.join(lines)


def count_script(buckets):
    """Print `<bucket> <object count>` per bucket; a bucket that does not exist yet counts 0."""
    lines = [MC_ALIAS]
    for name in buckets:
        q = shlex.quote(name)
        lines.append(f'echo {q} $(mc ls --recursive local/{q} 2>/dev/null | wc -l | tr -d " ")')
    return '; '.join(lines)


def parse_counts(text):
    counts = {}
    for line in (text or '').splitlines():
        name, _, number = line.rpartition(' ')
        if name and number.isdigit():
            counts[name] = int(number)
    return counts


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
    if manifest['mongo']['file'] != MONGO_ARCHIVE:
        raise ValueError('Unexpected Mongo archive name in manifest')
    if sha256(Path(dest) / MONGO_ARCHIVE) != manifest['mongo']['sha256']:
        raise ValueError('Mongo archive checksum mismatch')
    for name, info in manifest['buckets'].items():
        if count_files(Path(dest) / 'objects' / name) != info['objects']:
            raise ValueError(f'Object count mismatch for bucket {name}')
    return manifest


def run(cmd, env=None, redact_stderr=False, **kwargs):
    """subprocess.run, or with redact_stderr, stream stderr line by line with URI passwords masked.

    Streaming keeps progress visible and survives an interrupt. A PIPE stdout is read after
    stderr closes, which is fine for the few bytes the mongosh helpers print.
    """
    if not redact_stderr:
        return subprocess.run(cmd, check=True, text=True, env=env, **kwargs)
    with subprocess.Popen(cmd, env=env, text=True, errors='replace', stderr=subprocess.PIPE, **kwargs) as proc:
        for line in proc.stderr:
            print(redact(line), end='', file=sys.stderr, flush=True)
        stdout = proc.stdout.read() if proc.stdout else None
        code = proc.wait()
    if code:
        raise subprocess.CalledProcessError(code, cmd, output=stdout)
    return subprocess.CompletedProcess(cmd, code, stdout=stdout)


URI_PASSWORD = re.compile(r'(mongodb(?:\+srv)?://[^:/@\s]+:)[^@\s]*@')


def redact(text):
    """Database tools echo the full connection URI in some errors."""
    return URI_PASSWORD.sub(r'\1***@', text or '')


def step(name, cmd, **kwargs):
    try:
        return run(cmd, **kwargs)
    except subprocess.CalledProcessError as error:
        raise SystemExit(f'{name} failed (exit {error.returncode})') from None


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
    config = json.loads(step('compose config', [*compose, 'config', '--format', 'json'], stdout=subprocess.PIPE).stdout)
    uri, buckets = resolve_targets(config)
    return compose, buckets, {**os.environ, URI_ENV: instance_uri(uri)}


def source_revision():
    """Git revision of this tool, or None (tarball install, no git) with a warning."""
    try:
        done = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=Path(__file__).parent,
                              capture_output=True, text=True, check=True)
        return done.stdout.strip() or None
    except (OSError, subprocess.CalledProcessError):
        print('Warning: git revision unavailable; manifest records none.', file=sys.stderr)
        return None


def backup(args):
    compose, buckets, env = load(args)
    dest = Path(args.dest).resolve()
    if dest.exists() and any(dest.iterdir()):
        raise SystemExit(f'Refusing to write into non-empty {dest}')
    dest.mkdir(mode=0o700, parents=True, exist_ok=True)
    dest.chmod(0o700)  # the archive holds the whole database, including credential hashes
    (dest / 'objects').mkdir(mode=0o700)
    started = utcnow()
    try:
        with open(dest / MONGO_ARCHIVE, 'wb') as out:
            step('mongodump', mongodump_cmd(compose), redact_stderr=True, env=env, stdout=out)
        step('object mirror', mc_cmd(compose, dest / 'objects', mirror_script(buckets.values(), restore=False), False), env=env)
    except SystemExit as error:
        raise SystemExit(f'{error}; {dest} is incomplete, remove it before retrying') from None
    revision = source_revision()
    manifest = build_manifest(dest, buckets, started, utcnow(), revision)
    (dest / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(f'Backup complete: {dest}')
    print('Not included: .env.selfhost. Store it (especially SECRET_ENCRYPTION_KEY) separately and securely.')


def restore(args):
    compose, buckets, env = load(args)
    dest = Path(args.source).resolve()
    manifest = check_manifest(dest, buckets)
    step('start mongo and minio', [*compose, 'up', '-d', '--no-deps', '--wait', 'mongo', 'minio'])
    existing = step('target check', mongo_user_dbs_cmd(compose), redact_stderr=True, env=env, stdout=subprocess.PIPE).stdout.strip()
    objects = dest / 'objects'

    def target_counts():
        script = count_script(buckets.values())
        out = step('count objects', mc_cmd(compose, objects, script, True), env=env, stdout=subprocess.PIPE).stdout
        return parse_counts(out)

    stored = [name for name, count in target_counts().items() if count]
    if (existing or stored) and not args.yes:
        found = existing or 'objects in ' + ', '.join(stored)
        raise SystemExit(f'Target already has data ({found}); restore into a fresh project or pass --yes to overwrite')
    if existing:
        step('drop user databases', mongo_drop_dbs_cmd(compose), redact_stderr=True, env=env)
    step('mongorestore', mongorestore_cmd(compose), redact_stderr=True, env=env, stdin=open(dest / MONGO_ARCHIVE, 'rb'))
    step('createbuckets', [*compose, 'run', '--rm', '--no-deps', 'createbuckets'], env=env)  # buckets, webhooks, lifecycle
    script = mirror_script(buckets.values(), restore=True, remove=args.yes)
    step('object mirror', mc_cmd(compose, objects, script, True), env=env)
    restored = target_counts()
    wrong = {name: (info['objects'], restored.get(name)) for name, info in manifest['buckets'].items()
             if restored.get(name) != info['objects']}
    if wrong:
        detail = ', '.join(f'{name} (backup {want}, target {got})' for name, (want, got) in wrong.items())
        raise SystemExit(f'Restore verification failed, object counts differ: {detail}')
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
    r.add_argument('--yes', action='store_true', help='Overwrite a target that already has data (Mongo or any bucket object): drops every non-system database and removes objects not in the backup')
    return p


def main(argv=None):
    args = parser().parse_args(argv)
    try:
        {'backup': backup, 'restore': restore}[args.command](args)
    except (ValueError, OSError) as error:
        raise SystemExit(f'Error: {error}') from None
    return 0


if __name__ == '__main__':
    sys.exit(main())
