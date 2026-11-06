#!/usr/bin/env python3
"""Back up and restore the self-host Kubernetes chart's MongoDB and MinIO buckets.

Runs from the operator's machine through kubectl and streams both artifacts off the
cluster into a local directory: mongo.archive.gz (mongodump --oplog) and objects.tar
(mc mirror of the seven buckets, via a helper pod cloned from the init Job), plus a
manifest.json. The Secret (SECRET_ENCRYPTION_KEY and friends) is never written or copied; the
script reads only the bucket names and AWS_ENDPOINT_URL_S3 from the helper's environment, and
both come from the chart's ConfigMap.
The ElasticMQ PVC is excluded on purpose. See README.md "Backup and restore".
"""
import argparse
import copy
import datetime
import hashlib
import json
import pathlib
import secrets
import subprocess
import sys
import tarfile

BUCKET_KEYS = [
    'APP_FILES_BUCKET', 'EMAIL_INGESTION_BUCKET', 'FAB_FILE_BUCKET', 'GENERATED_IMAGES_BUCKET',
    'HISTORY_IMPORT_BUCKET', 'PUBLISHED_ARTIFACTS_BUCKET', 'SLACK_EXPORT_BUCKET',
]
BACKING_COMPONENTS = {'mongo', 'minio', 'sqs', 'mail'}
SYSTEM_DBS = {'admin', 'config', 'local'}
MONGO_URI = 'mongodb://localhost:27017/?replicaSet=rs0'
ARTIFACTS = ('mongo.archive.gz', 'objects.tar')
REMINDER = ('REMINDER: back up the runtime Secret (SECRET_ENCRYPTION_KEY, SECRET_ENCRYPTION_KEY_PREVIOUS, '
            'MEMORY_KEY_SECRET) separately; without it restored data cannot be decrypted.')
# Written by the init Job into APP_FILES_BUCKET; not user data.
MARKER = '.initialized-'


class BackupError(Exception):
    pass


def mongo_dump_cmd():
    return ['mongodump', '--uri', MONGO_URI, '--archive', '--gzip', '--oplog']


def mongo_restore_cmd():
    return ['mongorestore', '--uri', MONGO_URI, '--archive', '--gzip', '--oplogReplay']


def buckets_from_env(text):
    values = {}
    for line in text.splitlines():
        key, _, value = line.partition('=')
        if key in BUCKET_KEYS:
            values[key] = value.strip()
    missing = [key for key in BUCKET_KEYS if not values.get(key)]
    if missing:
        raise BackupError('bucket name missing or empty: ' + ', '.join(missing))
    return [values[key] for key in BUCKET_KEYS]


def is_local_s3(endpoint, release):
    return endpoint.strip() == 'http://%s-minio:9000' % release


def latest_init_job(jobs, release):
    prefix = release + '-buckets-'
    found = [job for job in jobs.get('items', []) if job['metadata']['name'].startswith(prefix)]
    if not found:
        return None
    return max(found, key=lambda job: job['metadata']['creationTimestamp'])


def helper_pod_manifest(job, name, mc_image=None):
    """A sleeping pod with the init Job's mc image, env, pull secrets and no API token."""
    spec = job['spec']['template']['spec']
    source = spec['containers'][0]
    # Long sleep: the pod must outlive any backup or restore; Helper.__exit__ deletes it.
    container = {'name': 'backup', 'command': ['sleep', '604800'],
                 'volumeMounts': [{'name': 'work', 'mountPath': '/work'}]}
    for key in ('image', 'imagePullPolicy', 'env', 'envFrom', 'resources'):
        if key in source:
            container[key] = copy.deepcopy(source[key])
    if mc_image:
        container['image'] = mc_image
    pod_spec = {'automountServiceAccountToken': False, 'restartPolicy': 'Never', 'containers': [container],
                'volumes': [{'name': 'work', 'emptyDir': {}}]}
    if spec.get('imagePullSecrets'):
        pod_spec['imagePullSecrets'] = copy.deepcopy(spec['imagePullSecrets'])
    instance = job['spec']['template']['metadata']['labels']['app.kubernetes.io/instance']
    return {
        'apiVersion': 'v1', 'kind': 'Pod',
        'metadata': {'name': name, 'labels': {
            'app.kubernetes.io/instance': instance, 'app.kubernetes.io/component': 'backup-helper'}},
        'spec': pod_spec,
    }


def fallback_pod_manifest(release, name, mc_image, secret, config):
    """Used when the init Job was garbage collected: same env, built from names."""
    job = {'spec': {'template': {
        'metadata': {'labels': {'app.kubernetes.io/instance': release}},
        'spec': {'containers': [{
            'image': mc_image,
            'envFrom': [{'configMapRef': {'name': config}}, {'secretRef': {'name': secret}}],
            'env': [{'name': 'LOCAL_OBJECTSTORE_ENDPOINT', 'value': 'http://%s-minio:9000' % release}],
        }]}}}}
    return helper_pod_manifest(job, name)


def app_role_deployments(deployments, release):
    roles = {}
    for item in deployments.get('items', []):
        # Pod template labels only: tools such as Argo CD add their own instance label to the Deployment.
        labels = item['spec']['template']['metadata']['labels']
        if labels.get('app.kubernetes.io/instance') != release:
            continue
        if labels.get('app.kubernetes.io/component') in BACKING_COMPONENTS:
            continue
        roles[item['metadata']['name']] = item['spec'].get('replicas', 1)
    return roles


def mirror_script(buckets, direction, replace=False):
    """Shell for the helper pod. Credentials come from its env, never from argv.

    replace (restore only) makes each bucket match the backup: objects missing from it are removed.
    The init Job's marker is left alone so it is not recreated on the next upgrade.
    """
    flags = "--overwrite --remove --exclude '%s*' " % MARKER if replace else ''
    head = ('set -eu\nmc alias set local "$LOCAL_OBJECTSTORE_ENDPOINT" '
            '"$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null\n')
    if direction == 'backup':
        body = ''.join('mkdir -p "/work/%s"\nmc mirror --quiet "local/%s" "/work/%s" >&2\n' % (b, b, b) for b in buckets)
        return head + 'mkdir -p /work\n' + body + 'tar -C /work -cf - .\n'
    body = ''.join('mkdir -p "/work/%s"\nmc mb --ignore-existing "local/%s" >/dev/null\nmc mirror --quiet %s"/work/%s" "local/%s" >&2\n'
                   % (b, b, flags, b, b) for b in buckets)
    return head + 'mkdir -p /work\ntar -C /work -xf -\n' + body


def count_script(buckets):
    # mc ls writes to a file, not into $(...), so set -e sees its failure instead of a count of 0.
    # ' .initialized-' (name column, fixed string) skips only the top-level marker, like tar_counts.
    head = ('set -eu\nmkdir -p /work\nmc alias set local "$LOCAL_OBJECTSTORE_ENDPOINT" "$MINIO_ROOT_USER" '
            '"$MINIO_ROOT_PASSWORD" >/dev/null\n')
    return head + ''.join(
        'mc ls --recursive "local/%s" >/work/ls\necho "%s $(grep -vcF \' %s\' /work/ls || true)"\n' % (b, b, MARKER)
        for b in buckets)


def tar_counts(path, buckets):
    """Objects per bucket in objects.tar, ignoring the init marker."""
    counts = dict.fromkeys(buckets, 0)
    with tarfile.open(path) as archive:
        for member in archive:
            parts = member.name.removeprefix('./').split('/', 1)
            if member.isfile() and len(parts) == 2 and parts[0] in counts and not parts[1].startswith(MARKER):
                counts[parts[0]] += 1
    return counts


def is_local_context(name):
    return name.startswith(('kind-', 'k3d-')) or name in ('minikube', 'docker-desktop')


def read_manifest(src):
    try:
        return json.loads((pathlib.Path(src) / 'manifest.json').read_text())
    except (OSError, ValueError) as error:
        raise BackupError('cannot read manifest.json in %s (incomplete backup?): %s' % (src, error))


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b''):
            digest.update(chunk)
    return digest.hexdigest()


def build_manifest(release, namespace, started, finished, images, buckets, counts, dest):
    return {
        'version': 1, 'release': release, 'namespace': namespace,
        'started_at': started, 'finished_at': finished, 'images': images,
        'buckets': buckets, 'object_counts': counts,
        'artifacts': {name: sha256_file(pathlib.Path(dest) / name) for name in ARTIFACTS},
    }


def check_manifest(manifest, src, buckets):
    """Reject a missing, tampered or bucket-mismatched backup before any write."""
    if manifest.get('version') != 1:
        raise BackupError('unsupported manifest version')
    if sorted(manifest.get('buckets', [])) != sorted(buckets):
        raise BackupError('manifest buckets %s differ from target buckets %s' % (manifest.get('buckets'), buckets))
    for name in ARTIFACTS:
        path = pathlib.Path(src) / name
        if not path.is_file():
            raise BackupError('missing artifact: ' + name)
        if sha256_file(path) != manifest.get('artifacts', {}).get(name):
            raise BackupError('checksum mismatch: ' + name)


def now():
    return datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


class Kube:
    def __init__(self, namespace, context=None):
        self.base = ['kubectl'] + (['--context', context] if context else []) + ['-n', namespace]

    def run(self, args, input_text=None, stdout=None, stdin=None, check=True):
        result = subprocess.run(self.base + args, input=input_text, stdin=stdin, stdout=stdout or subprocess.PIPE,
                                stderr=subprocess.PIPE, text=input_text is not None or (stdout is None and stdin is None))
        if check and result.returncode != 0:
            err = result.stderr if isinstance(result.stderr, str) else result.stderr.decode('utf-8', 'replace')
            raise BackupError('kubectl %s failed: %s' % (args[0], err.strip()[-400:]))
        return result

    def json(self, args):
        return json.loads(self.run(args + ['-o', 'json']).stdout)

    def exists(self, kind, name):
        return self.run(['get', kind, name, '-o', 'name'], check=False).returncode == 0


def mongo_exec(kube, release, command, stdin=None, stdout=None):
    return kube.run(['exec'] + (['-i'] if stdin else []) + [release + '-mongo-0', '-c', 'mongo', '--'] + command,
                    stdin=stdin, stdout=stdout)


def user_databases(kube, release):
    js = 'JSON.stringify(db.adminCommand({listDatabases:1,nameOnly:true}).databases.map(d=>d.name))'
    out = mongo_exec(kube, release, ['mongosh', '--quiet', MONGO_URI, '--eval', js]).stdout
    return sorted(set(json.loads(out)) - SYSTEM_DBS)


def require_local_mongo(kube, release):
    if not kube.exists('statefulset', release + '-mongo'):
        raise BackupError('no %s-mongo StatefulSet: external MongoDB mode is not supported; '
                          "use the database provider's own backups" % release)


class Helper:
    """Short-lived mc pod, deleted on exit."""

    def __init__(self, kube, release, mc_image):
        self.kube, self.release, self.mc_image = kube, release, mc_image
        self.name = '%s-backup-%s' % (release, secrets.token_hex(3))

    def __enter__(self):
        job = latest_init_job(self.kube.json(['get', 'jobs']), self.release)
        if job:
            manifest = helper_pod_manifest(job, self.name, self.mc_image)
        elif self.mc_image:
            secret = self.kube.json(['get', 'deploy', self.release + '-app'])
            secret_name = next(e['secretRef']['name'] for e in secret['spec']['template']['spec']['containers'][0]['envFrom']
                               if 'secretRef' in e)
            manifest = fallback_pod_manifest(self.release, self.name, self.mc_image, secret_name, self.release + '-config')
        else:
            raise BackupError('init Job %s-buckets-* is gone; pass --mc-image' % self.release)
        try:
            self.kube.run(['create', '-f', '-'], input_text=json.dumps(manifest))
            self.kube.run(['wait', '--for=condition=Ready', 'pod/' + self.name, '--timeout=300s'])
        except BaseException:
            self.__exit__()
            raise
        return self

    def __exit__(self, *exc):
        self.kube.run(['delete', 'pod', self.name, '--wait=false', '--ignore-not-found'], check=False)

    def sh(self, script, stdin=None, stdout=None):
        return self.kube.run(['exec'] + (['-i'] if stdin else []) + [self.name, '-c', 'backup', '--', 'sh', '-c', script],
                             stdin=stdin, stdout=stdout)

    def text(self, script):
        return self.sh(script).stdout

    def buckets(self):
        if not is_local_s3(self.text('printf %s "${AWS_ENDPOINT_URL_S3:-}"'), self.release):
            raise BackupError('object storage is not the bundled MinIO; back up external S3 with your provider')
        return buckets_from_env(self.text('for k in %s; do printf "%%s=%%s\\n" "$k" "$(printenv "$k")"; done' % ' '.join(BUCKET_KEYS)))

    def counts(self, buckets):
        return {line.split()[0]: int(line.split()[1]) for line in self.text(count_script(buckets)).splitlines()}

    def image(self):
        pod = self.kube.json(['get', 'pod', self.name])
        return pod['spec']['containers'][0]['image']


# Longer than the executor's terminationGracePeriodSeconds (840) so a draining pod finishes first.
DRAIN_TIMEOUT = '900s'


def scale(kube, roles, to_zero, release):
    failed = []
    for name, replicas in roles.items():
        try:
            kube.run(['scale', 'deployment', name, '--replicas', '0' if to_zero else str(replicas)])
        except BackupError as error:
            if to_zero:
                raise
            failed.append('%s: %s' % (name, error))
    if failed:
        raise BackupError('could not scale back up (fix by hand): ' + '; '.join(failed))
    if to_zero and roles:
        selector = 'app.kubernetes.io/instance=%s,app.kubernetes.io/component notin (%s)' % (release, ','.join(
            sorted(BACKING_COMPONENTS | {'backup-helper', 'initialize'})))
        result = kube.run(['wait', '--for=delete', 'pod', '-l', selector, '--timeout=' + DRAIN_TIMEOUT], check=False)
        err = result.stderr if isinstance(result.stderr, str) else result.stderr.decode('utf-8', 'replace')
        if result.returncode != 0 and 'no matching resources' not in err.lower():
            raise BackupError('app pods did not drain: ' + err.strip()[-300:])


def backup(args):
    kube, release = Kube(args.namespace, args.context), args.release
    dest = pathlib.Path(args.dest)
    if dest.exists() and any(dest.iterdir()):
        raise BackupError('destination %s is not empty' % dest)
    require_local_mongo(kube, release)
    dest.mkdir(parents=True, exist_ok=True)
    started = now()
    # Mongo first: an orphan object is harmless, a row without its bytes is not.
    with open(dest / ARTIFACTS[0], 'wb') as out:
        mongo_exec(kube, release, mongo_dump_cmd(), stdout=out)
    mongo_image = kube.json(['get', 'pod', release + '-mongo-0'])['spec']['containers'][0]['image']
    with Helper(kube, release, args.mc_image) as helper:
        buckets = helper.buckets()
        with open(dest / ARTIFACTS[1], 'wb') as out:
            helper.sh(mirror_script(buckets, 'backup'), stdout=out)
        counts = tar_counts(dest / ARTIFACTS[1], buckets)
        images = {'mongo': mongo_image, 'mc': helper.image()}
    manifest = build_manifest(release, args.namespace, started, now(), images, buckets, counts, dest)
    (dest / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print('backup complete: %s (%s .. %s)' % (dest, started, manifest['finished_at']))
    print(REMINDER)


def check_restored_counts(manifest, restored):
    expected = manifest.get('object_counts', {})
    short = []
    for bucket in manifest['buckets']:
        want, got = expected.get(bucket, 0), restored.get(bucket, 0)
        print('objects %s: backup %d, restored %d' % (bucket, want, got))
        if got < want:
            short.append(bucket)
    if short:
        raise BackupError('restored fewer objects than the backup holds in: ' + ', '.join(short))


def restore(args):
    kube, release = Kube(args.namespace, args.context), args.release
    src = pathlib.Path(args.src)
    manifest = read_manifest(src)
    require_local_mongo(kube, release)
    with Helper(kube, release, args.mc_image) as helper:
        buckets = helper.buckets()
        check_manifest(manifest, src, buckets)
        populated = user_databases(kube, release)
        objects = {b: n for b, n in helper.counts(buckets).items() if n}
        if (populated or objects) and not args.yes:
            raise BackupError('target is not empty (databases: %s; buckets: %s); restore into a fresh release or pass --yes'
                              % (populated or 'none', sorted(objects) or 'none'))
        roles = app_role_deployments(kube.json(['get', 'deploy']), release)
        idle = sorted(name for name, replicas in roles.items() if replicas == 0)
        if idle:
            print('warning: already at 0 replicas, will be left at 0: %s' % ', '.join(idle), file=sys.stderr)
        try:
            scale(kube, roles, True, release)
            # Re-read after the drain: a worker that seeded late is gone now, but its data is not.
            for name in user_databases(kube, release):
                mongo_exec(kube, release, ['mongosh', '--quiet', MONGO_URI, '--eval',
                                           'db.getSiblingDB(%s).dropDatabase()' % json.dumps(name)])
            with open(src / ARTIFACTS[0], 'rb') as handle:
                mongo_exec(kube, release, mongo_restore_cmd(), stdin=handle)
            with open(src / ARTIFACTS[1], 'rb') as handle:
                helper.sh(mirror_script(buckets, 'restore', replace=args.yes), stdin=handle)
            check_restored_counts(manifest, helper.counts(buckets))
        except BaseException as original:
            try:
                scale(kube, roles, False, release)
            except BackupError as error:
                raise BackupError('%s; and: %s' % (str(original) or type(original).__name__, error)) from original
            raise
        scale(kube, roles, False, release)
    print('restore complete from %s' % src)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    sub = parser.add_subparsers(dest='command', required=True)
    for name, func in (('backup', backup), ('restore', restore)):
        p = sub.add_parser(name)
        p.add_argument('--namespace', required=True)
        p.add_argument('--release', required=True)
        p.add_argument('--context')
        p.add_argument('--mc-image', help='mc image; overrides the init Job, required if the Job is gone')
        if name == 'backup':
            p.add_argument('--dest', required=True, help='new or empty directory')
        else:
            p.add_argument('--from', dest='src', required=True, help='directory written by backup')
            p.add_argument('--yes', action='store_true', help='for a target that already has data (a freshly installed release does): drop its user databases and make the buckets match the backup')
        p.set_defaults(func=func)
    args = parser.parse_args(argv)
    try:
        args.func(args)
    except BackupError as error:
        print('error: ' + str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
