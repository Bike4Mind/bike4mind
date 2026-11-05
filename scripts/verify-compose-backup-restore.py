#!/usr/bin/env python3
"""Drill: back up a disposable Compose project, destroy it, restore into a fresh one.

Seeds a sentinel user and a sentinel file in the real mongo + minio services, runs
scripts/selfhost_backup.py backup and restore, and checks the same user and the same
file sha256 come back, while a writer keeps the oplog non-empty during the dump.
--auth runs the same drill against a Mongo started with a root user and keyFile.
Needs built minio/createbuckets images (see SELF_HOST.md) and .env.selfhost.
Python stdlib only. Removes only the projects it creates.
"""

import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parent.parent
BACKUP = ROOT / 'scripts' / 'selfhost_backup.py'
MC_ALIAS = 'mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null; '


MONGO_AUTH = '''    environment:
      MONGO_INITDB_ROOT_USERNAME: root
      MONGO_INITDB_ROOT_PASSWORD: {password}
      KEYFILE_CONTENT: {key}
    entrypoint:
      - sh
      - -c
      - printf %s "$$KEYFILE_CONTENT" > /tmp/keyfile && chown mongodb /tmp/keyfile && chmod 400 /tmp/keyfile && exec docker-entrypoint.sh "$$@"
      - sh
    command: [mongod, --replSet, rs0, --bind_ip_all, --keyFile, /tmp/keyfile]
    healthcheck:
      test:
        - CMD-SHELL
        - >-
          mongosh --quiet -u root -p "$$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin
          --eval "try {{ rs.status().ok }} catch (e) {{ rs.initiate({{_id:'rs0',members:[{{_id:0,host:'mongo:27017'}}]}}).ok }}"
'''


def sh(cmd, **kwargs):
    print('+', ' '.join(shlex.quote(str(c)) for c in cmd), flush=True)
    return subprocess.run(cmd, cwd=ROOT, check=True, **kwargs)


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def oplog_entries(stderr, verb):
    """Entries a mongodump ("dumped") or mongorestore ("applied") reported on stderr."""
    return sum(int(n) for n in re.findall(verb + r' (\d+) oplog entr', stderr))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--auth', action='store_true', help='Run Mongo with a root user and keyFile')
    args = parser.parse_args(argv)
    env_file = ROOT / '.env.selfhost'
    if not env_file.is_file():
        raise SystemExit('Configure .env.selfhost before running the drill')

    base = ['docker', 'compose', '-f', str(ROOT / 'compose.selfhost.yaml'), '--env-file', str(env_file)]
    config = json.loads(sh([*base, 'config', '--format', 'json'], stdout=subprocess.PIPE, text=True).stdout)
    images = {s: config['services'][s].get('image') or f"{config['name']}-{s}" for s in ('minio', 'createbuckets')}
    bucket = config['services']['createbuckets']['environment']['FAB_FILE_BUCKET']

    tag = secrets.token_hex(4)
    projects = {'src': 'b4m-backup-drill-src-' + tag, 'dst': 'b4m-backup-drill-dst-' + tag}
    email = f'drill-{tag}@example.invalid'
    payload = secrets.token_bytes(64 * 1024)
    expected = hashlib.sha256(payload).hexdigest()
    key = f'drill/{tag}.bin'
    password = secrets.token_hex(16)
    mongo_uri = ('mongodb://root:' + password + '@mongo:27017/bike4mind?replicaSet=rs0&authSource=admin'
                 if args.auth else 'mongodb://mongo:27017/bike4mind?replicaSet=rs0')

    print('UTC:', datetime.datetime.now(datetime.timezone.utc).isoformat())
    print('Revision:', sh(['git', 'rev-parse', 'HEAD'], stdout=subprocess.PIPE, text=True).stdout.strip())

    with tempfile.TemporaryDirectory(prefix='b4m-backup-drill-') as directory:
        override = Path(directory) / 'override.yaml'
        override.write_text(
            'services:\n'
            + ''.join(
                f'  {s}:\n    image: {json.dumps(images[s])}\n    pull_policy: never\n    build: !reset null\n'
                for s in ('createbuckets',))
            + f'  minio:\n    image: {json.dumps(images["minio"])}\n    pull_policy: never\n'
              '    build: !reset null\n    ports: !reset []\n'
            '  mongo:\n    ports: !reset []\n'
            + (MONGO_AUTH.format(password=password, key=secrets.token_hex(24)) if args.auth else '')
            + f'  app:\n    environment:\n      MONGODB_URI: {json.dumps(mongo_uri)}\n')
        backup_dir = Path(directory) / 'backup'

        def compose(project):
            return ['docker', 'compose', '-p', project, '-f', str(ROOT / 'compose.selfhost.yaml'),
                    '-f', str(override), '--env-file', str(env_file)]

        def mc(project, script, **kwargs):
            return sh([*compose(project), 'run', '--rm', '--no-deps', '-T', '--pull', 'never',
                       '--entrypoint', '/bin/sh', 'createbuckets', '-ec', MC_ALIAS + script], **kwargs)

        def mongosh(project, js):
            return sh([*compose(project), 'exec', '-T', 'mongo', 'mongosh', mongo_uri, '--quiet', '--eval', js],
                      stdout=subprocess.PIPE, text=True).stdout.strip()

        def file_sha(project):
            out = mc(project, f'mc cat local/{shlex.quote(bucket)}/{shlex.quote(key)} | sha256sum',
                     stdout=subprocess.PIPE, text=True).stdout
            return out.split()[0]

        try:
            sh([*compose(projects['src']), 'up', '-d', '--no-build', '--wait', 'mongo', 'minio'])
            sh([*compose(projects['src']), 'run', '--rm', '--no-deps', '--pull', 'never', 'createbuckets'])
            user_id = mongosh(projects['src'],
                              f'db.getSiblingDB("bike4mind").users.insertOne({{email: {json.dumps(email)}}}).insertedId.toString()')
            mc(projects['src'], f'mc pipe local/{shlex.quote(bucket)}/{shlex.quote(key)}', input=payload)
            require(file_sha(projects['src']) == expected, 'Seeded file does not read back in the source project')

            cli = [sys.executable, '-I', str(BACKUP), '--env-file', str(env_file),
                   '-f', str(ROOT / 'compose.selfhost.yaml'), '-f', str(override)]
            noise = subprocess.Popen([*compose(projects['src']), 'exec', '-T', 'mongo', 'mongosh', mongo_uri, '--quiet', '--eval',
                                      'for (let i = 0; i < 200; i++) { db.getSiblingDB("bike4mind").noise.insertOne({i}); sleep(100) }'],
                                     cwd=ROOT, stdout=subprocess.DEVNULL)
            time.sleep(2)  # writes land in the oplog slice captured by --oplog
            try:
                dumped = sh([*cli, '-p', projects['src'], 'backup', '--dest', str(backup_dir)],
                            stderr=subprocess.PIPE, text=True).stderr
            finally:
                noise.terminate()
                noise.wait()
            print(dumped, end='', file=sys.stderr)
            require(oplog_entries(dumped, 'dumped') >= 1, 'The dump captured no oplog entries')
            objects = backup_dir / 'objects'
            for path in (objects / bucket, objects / bucket / key):
                owner = path.stat().st_uid
                require(owner == os.getuid(), f'{path} is owned by uid {owner}, not the invoking user')
            manifest = json.loads((backup_dir / 'manifest.json').read_text())
            print('Manifest:', json.dumps(manifest))
            require(manifest['buckets'][bucket]['objects'] >= 1, 'Manifest records no objects for the seeded bucket')

            sh([*compose(projects['src']), 'down', '--volumes', '--remove-orphans'])

            def check_restored(label, restore_args):
                restored = sh([*cli, '-p', projects['dst'], 'restore', '--from', str(backup_dir), *restore_args],
                              stderr=subprocess.PIPE, text=True).stderr
                print(restored, end='', file=sys.stderr)
                require(oplog_entries(restored, 'applied') >= 1, f'{label}: no oplog entries were replayed')
                found = mongosh(projects['dst'],
                                f'JSON.stringify(db.getSiblingDB("bike4mind").users.find({{email: {json.dumps(email)}}}).toArray().map(u => u._id.toString()))')
                require(json.loads(found) == [user_id], f'{label}: user not restored with the same _id: {found}')
                print(f'PASS user ({label}): same _id and email restored', user_id, email)
                require(file_sha(projects['dst']) == expected, f'{label}: restored file sha256 differs')
                print(f'PASS file sha256 ({label}):', expected)

            check_restored('fresh restore', [])
            check_restored('restore --yes over existing data', ['--yes'])
        finally:
            for project in projects.values():
                subprocess.run([*compose(project), 'down', '--volumes', '--remove-orphans'], cwd=ROOT, check=False)


if __name__ == '__main__':
    main()
