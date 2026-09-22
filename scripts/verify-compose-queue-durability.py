#!/usr/bin/env python3
"""Exercise the real Compose sqs service in disposable projects (Python stdlib only)."""

import copy
import datetime
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent.parent


def run(*args):
    print('+', ' '.join(str(arg) for arg in args), flush=True)
    return subprocess.check_output(args, cwd=ROOT, text=True).strip()


def request(endpoint, action, **params):
    payload = urllib.parse.urlencode({'Action': action, 'Version': '2012-11-05', **params})
    with urllib.request.urlopen(endpoint, data=payload.encode(), timeout=10) as response:
        return ET.fromstring(response.read())


def field(xml, name):
    return xml.findtext('.//{*}' + name)


def drill(model, directory, disabled):
    label = 'disabled' if disabled else 'durable'
    project = 'b4m-queue-drill-' + label + '-' + uuid.uuid4().hex[:12]
    service = copy.deepcopy(model['services']['sqs'])
    service['ports'] = [{'target': 9324, 'host_ip': '127.0.0.1', 'published': '0'}]
    volumes = {}
    for mount in service.get('volumes', []):
        if mount['type'] == 'volume':
            volumes[mount['source']] = {}
        elif mount['target'] == '/opt/elasticmq.conf' and disabled:
            config = Path(directory) / 'disabled.conf'
            config.write_text(Path(mount['source']).read_text() + '\nmessages-storage.enabled = false\n')
            mount['source'] = str(config)
    compose = Path(directory) / (label + '.json')
    compose.write_text(json.dumps({'services': {'sqs': service}, 'volumes': volumes}))
    command = ['docker', 'compose', '--env-file', '/dev/null', '-p', project, '-f', str(compose)]

    def ready():
        endpoint = 'http://' + run(*command, 'port', 'sqs', '9324')
        deadline = time.monotonic() + 60
        while True:
            try:
                request(endpoint, 'ListQueues')
                return endpoint
            except (urllib.error.URLError, TimeoutError):
                if time.monotonic() >= deadline:
                    raise
                time.sleep(0.5)

    def recreate():
        old = run(*command, 'ps', '-q', 'sqs')
        run(*command, 'up', '-d', '--no-deps', '--force-recreate', '--renew-anon-volumes', 'sqs')
        new = run(*command, 'ps', '-q', 'sqs')
        assert old != new, 'Container was not replaced'
        return ready()

    try:
        run(*command, 'up', '-d', '--no-deps', 'sqs')
        endpoint = ready()
        container = run(*command, 'ps', '-q', 'sqs')
        print('Image:', run('docker', 'inspect', '--format', '{{.Image}}', container))
        queue = field(request(endpoint, 'GetQueueUrl', QueueName='researchEngineQueue'), 'QueueUrl')
        assert queue, 'Main queue declaration missing'
        body = 'compose-durability-' + uuid.uuid4().hex
        message_id = field(request(endpoint, 'SendMessage', QueueUrl=queue, MessageBody=body), 'MessageId')
        assert message_id, 'SendMessage returned no ID'
        print(label, 'enqueued', message_id, flush=True)
        endpoint = recreate()
        received = request(endpoint, 'ReceiveMessage', QueueUrl=queue, WaitTimeSeconds=2, VisibilityTimeout=1)
        if disabled:
            assert field(received, 'MessageId') is None, 'Disabled storage retained a message'
            print('PASS disabled: pending message lost after replacement', message_id, flush=True)
            return
        assert field(received, 'MessageId') == message_id, 'Pending message ID did not survive'
        assert field(received, 'Body') == body, 'Pending message body changed'
        request(endpoint, 'DeleteMessage', QueueUrl=queue, ReceiptHandle=field(received, 'ReceiptHandle'))
        endpoint = recreate()
        time.sleep(2)  # Beyond the receipt visibility window, so invisibility cannot hide resurrection.
        received = request(endpoint, 'ReceiveMessage', QueueUrl=queue, WaitTimeSeconds=2)
        assert field(received, 'MessageId') is None, 'Deleted message resurrected'
        print('PASS durable: identical pending ID survived; acknowledged deletion survived', message_id, flush=True)
    finally:
        run(*command, 'down', '--volumes', '--remove-orphans')


def main():
    print('UTC:', datetime.datetime.now(datetime.timezone.utc).isoformat())
    print('Revision:', run('git', 'rev-parse', 'HEAD'))
    print('Working tree:', run('git', 'status', '--short'))
    for name in ('compose.selfhost.yaml', 'elasticmq.conf'):
        print(name, 'sha256:', hashlib.sha256((ROOT / name).read_bytes()).hexdigest())
    run('docker', 'info', '--format', '{{.ServerVersion}}')
    model = json.loads(run('docker', 'compose', '--env-file', '/dev/null', '-f',
                           str(ROOT / 'compose.selfhost.yaml'), 'config', '--no-env-resolution', '--format', 'json'))
    mounts = model['services']['sqs'].get('volumes', [])
    data = next((mount for mount in mounts if mount['target'] == '/data'), {})
    config = next((mount for mount in mounts if mount['target'] == '/opt/elasticmq.conf'), {})
    if data.get('type') != 'volume' or not data.get('source'):
        raise ValueError('The sqs /data mount must be a named volume for this disposable drill')
    if (config.get('type') != 'bind' or not config.get('read_only')
            or Path(config.get('source', '')).resolve() != ROOT / 'elasticmq.conf'
            or len(mounts) != 2):
        raise ValueError('Expected only the named data volume and read-only repository elasticmq.conf')
    with tempfile.TemporaryDirectory(prefix='b4m-queue-drill-') as directory:
        drill(model, directory, disabled=False)
        drill(model, directory, disabled=True)


if __name__ == '__main__':
    main()
