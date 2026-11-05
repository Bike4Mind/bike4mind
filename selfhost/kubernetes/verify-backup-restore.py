#!/usr/bin/env python3
"""Backup/restore drill for the Kubernetes chart, on a disposable local cluster.

Installs a source release, seeds one user and one file, backs it up with backup.py,
deletes the source, installs a fresh release, restores, and checks that the same user
and the same file sha256 come back. Only touches namespaces it creates itself.

  python3 selfhost/kubernetes/verify-backup-restore.py --images images.yaml

images.yaml is a Helm values file with images.{app,chatcompletion,ws,subscriberFanout,
minio,mc}. The app-role images are scaled to 0 and never run, so any tagged image works
for them; minio and mc must be the real source-built images.
"""
import argparse
import hashlib
import json
import os
import pathlib
import secrets
import subprocess
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import backup  # noqa: E402

LOCAL_CONTEXTS = ('kind', 'k3d', 'minikube', 'docker-desktop')
OBJECT_BUCKET, OBJECT_KEY = 'b4m-fab-file', 'drill/sentinel.bin'


def sh(cmd, **kw):
    result = subprocess.run(cmd, text=True, capture_output=True, **kw)
    if result.returncode != 0:
        raise SystemExit('FAIL: %s\n%s' % (' '.join(cmd[:4]), result.stderr[-600:]))
    return result.stdout


def runtime_env():
    user = 'drill' + secrets.token_hex(4)
    password = secrets.token_hex(16)
    values = {
        'JWT_SECRET': secrets.token_hex(32), 'SESSION_SECRET': secrets.token_hex(32),
        'SECRET_ENCRYPTION_KEY': secrets.token_hex(32), 'MEMORY_KEY_SECRET': secrets.token_hex(32),
        'INTERNAL_WS_SECRET': secrets.token_hex(32), 'INTERNAL_S3_WEBHOOK_SECRET': secrets.token_hex(32),
        'CHAT_COMPLETION_INTERNAL_SECRET': secrets.token_hex(32), 'MINIO_ROOT_USER': user,
        'MINIO_ROOT_PASSWORD': password, 'AWS_ACCESS_KEY_ID': user, 'AWS_SECRET_ACCESS_KEY': password,
    }
    return ''.join('%s=%s\n' % item for item in values.items())


class Release:
    def __init__(self, args, role, env_file):
        suffix = secrets.token_hex(3)
        self.name = 'b4m-drill-%s-%s' % (role, suffix)
        self.ns = self.name
        self.args, self.env_file = args, env_file
        self.kube = backup.Kube(self.ns, args.context)

    def install(self):
        sh(['kubectl', '--context', self.args.context, 'create', 'namespace', self.ns])
        sh(['kubectl', '--context', self.args.context, '-n', self.ns, 'create', 'secret', 'generic', 'runtime',
            '--from-env-file', self.env_file])
        cmd = ['helm', '--kube-context', self.args.context, 'install', self.name, str(HERE), '-n', self.ns,
               '-f', self.args.images, '--set', 'existingSecret=runtime',
               '--set', 'config.APP_URL=http://localhost:3000', '--set', 'config.WEBSOCKET_URL=ws://localhost:3001',
               '--set', 'config.CHAT_COMPLETION_PUBLIC_URL=http://localhost:8788']
        if self.args.storage_class:
            cmd += ['--set', 'storage.className=' + self.args.storage_class]
        sh(cmd)
        # Placeholder app images must never run; scale them down before they matter.
        roles = backup.app_role_deployments(self.kube.json(['get', 'deploy']), self.name)
        backup.scale(self.kube, {name: 0 for name in roles}, True)
        self.kube.run(['rollout', 'status', 'statefulset/%s-mongo' % self.name, '--timeout=600s'])
        self.kube.run(['rollout', 'status', 'deployment/%s-minio' % self.name, '--timeout=600s'])
        job = backup.latest_init_job(self.kube.json(['get', 'jobs']), self.name)['metadata']['name']
        self.kube.run(['wait', '--for=condition=complete', 'job/' + job, '--timeout=600s'])

    def mongosh(self, js):
        return backup.mongo_exec(self.kube, self.name, ['mongosh', '--quiet', backup.MONGO_URI, '--eval', js]).stdout.strip()

    def destroy(self):
        subprocess.run(['helm', '--kube-context', self.args.context, 'uninstall', self.name, '-n', self.ns],
                       capture_output=True)
        subprocess.run(['kubectl', '--context', self.args.context, 'delete', 'namespace', self.ns, '--wait=false'],
                       capture_output=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--images', required=True)
    parser.add_argument('--context', default=None)
    parser.add_argument('--storage-class')
    parser.add_argument('--keep', action='store_true', help='skip cleanup')
    parser.add_argument('--context-ok', action='store_true', help='allow a non-local kube context')
    args = parser.parse_args()
    args.context = args.context or sh(['kubectl', 'config', 'current-context']).strip()
    if not args.context_ok and not any(name in args.context for name in LOCAL_CONTEXTS):
        raise SystemExit('refusing to run on context %r; pass --context-ok if it is disposable' % args.context)

    payload = os.urandom(64 * 1024)
    want_sha = hashlib.sha256(payload).hexdigest()
    user_id, email = secrets.token_hex(12), 'drill-%s@example.invalid' % secrets.token_hex(4)
    releases = []
    with tempfile.TemporaryDirectory() as work:
        env_file = pathlib.Path(work) / 'runtime.env'
        env_file.touch(mode=0o600)
        env_file.write_text(runtime_env())
        try:
            src = Release(args, 'src', str(env_file))
            releases.append(src)
            src.install()
            src.mongosh('db.getSiblingDB("bike4mind").users.insertOne({_id: ObjectId("%s"), email: "%s"})' % (user_id, email))
            with backup.Helper(src.kube, src.name, None) as helper:
                with open(pathlib.Path(work) / 'payload.bin', 'wb') as handle:
                    handle.write(payload)
                with open(pathlib.Path(work) / 'payload.bin', 'rb') as handle:
                    helper.sh('mc alias set local "$LOCAL_OBJECTSTORE_ENDPOINT" "$MINIO_ROOT_USER" '
                              '"$MINIO_ROOT_PASSWORD" >/dev/null && mc pipe local/%s/%s' % (OBJECT_BUCKET, OBJECT_KEY),
                              stdin=handle)
            dump = str(pathlib.Path(work) / 'dump')
            common = ['--namespace', src.ns, '--release', src.name, '--context', args.context]
            if backup.main(['backup'] + common + ['--dest', dump]) != 0:
                raise SystemExit('FAIL: backup')
            src.destroy()
            releases.remove(src)

            dst = Release(args, 'dst', str(env_file))
            releases.append(dst)
            dst.install()
            common = ['--namespace', dst.ns, '--release', dst.name, '--context', args.context]
            if backup.main(['restore'] + common + ['--from', dump]) != 0:
                raise SystemExit('FAIL: restore')

            got = dst.mongosh('JSON.stringify(db.getSiblingDB("bike4mind").users.findOne({_id: ObjectId("%s")}))' % user_id)
            record = json.loads(got) if got and got != 'null' else {}
            if record.get('email') != email:
                raise SystemExit('FAIL user: expected %s, got %s' % (email, got))
            print('PASS user %s %s' % (user_id, email))
            with backup.Helper(dst.kube, dst.name, None) as helper:
                out = helper.text('mc alias set local "$LOCAL_OBJECTSTORE_ENDPOINT" "$MINIO_ROOT_USER" '
                                  '"$MINIO_ROOT_PASSWORD" >/dev/null && mc cat local/%s/%s | sha256sum' % (OBJECT_BUCKET, OBJECT_KEY))
            got_sha = out.split()[0] if out.split() else ''
            if got_sha != want_sha:
                raise SystemExit('FAIL file sha256: expected %s, got %s' % (want_sha, got_sha))
            print('PASS file sha256 %s' % got_sha)
        finally:
            if not args.keep:
                for release in releases:
                    release.destroy()


if __name__ == '__main__':
    main()
