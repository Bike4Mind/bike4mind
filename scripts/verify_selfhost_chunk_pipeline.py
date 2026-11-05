#!/usr/bin/env python3
"""Verify, against a RUNNING self-host stack, that an uploaded file is chunked, embedded and searchable.

Three scenarios, each reported as one PASS/FAIL line:
  happy   upload a text file; chunks and vectors appear; semantic search returns the file
  rescue  withhold the MinIO upload webhook; the worker's rescue sweep chunks the file anyway
  replay  re-deliver a chunk message for an already-chunked file; the chunk count is unchanged

Backend asserted: the default self-host retrieval path, vectors stored in Mongo (community
vector backend). The opt-in OpenSearch profile is not asserted.

Prerequisites: stack up from compose.selfhost.yaml with .env.selfhost, an embedding provider
configured (see SELF_HOST.md "Offline RAG"), Enable Auto Chunk on, and an API key in
B4M_API_KEY with the files:write and data-lake write/query scopes. The base URL defaults to
http://127.0.0.1:3000 (B4M_BASE_URL); ElasticMQ is read from 127.0.0.1:$SQS_HOST_PORT (9324).

The rescue scenario removes the FabFile bucket's put webhook for a few minutes and restores it
in a finally block; uploads by other users in that window rely on the sweep too. Use --only to
skip it. The script creates one throwaway data lake (search only reaches lake files) and deletes
it and its files at the end, best effort.

Python stdlib only.
"""

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent.parent
COMPOSE = ['docker', 'compose', '-f', str(ROOT / 'compose.selfhost.yaml'), '--env-file', str(ROOT / '.env.selfhost')]
DB_NAME = 'bike4mind'
CHUNK_QUEUE = 'fabFileChunkQueue'
SCENARIOS = ('happy', 'rescue', 'replay')


def require(condition, message):
    """Assert-like check that isn't stripped under python -O / PYTHONOPTIMIZE."""
    if not condition:
        raise AssertionError(message)


class Timeout(AssertionError):
    pass


def poll(fn, done, timeout, interval=2.0, clock=time.monotonic, sleep=time.sleep, what='condition'):
    """Call fn until done(value) is true; raise Timeout naming the last value seen."""
    deadline = clock() + timeout
    while True:
        value = fn()
        if done(value):
            return value
        if clock() >= deadline:
            raise Timeout(f'timed out after {timeout}s waiting for {what}; last state: {value!r}')
        sleep(interval)


def parse_mongosh_json(stdout):
    """mongosh --quiet prints the eval result; take the last non-empty line as JSON."""
    lines = [line for line in stdout.strip().splitlines() if line.strip()]
    require(lines, 'mongosh printed nothing')
    try:
        return json.loads(lines[-1])
    except ValueError as error:
        raise ValueError(f'mongosh output is not JSON: {stdout.strip()[:200]!r}') from error


def chunk_state_ok(state):
    """Chunked and fully embedded: chunks exist, each has a vector, and one embedding model stamped them."""
    return (
        state.get('chunks', 0) > 0
        and state.get('embedded') == state.get('chunks')
        and len(state.get('models', [])) == 1
    )


def search_hit(response, file_id):
    return any(str(r.get('file_id')) == file_id for r in (response or {}).get('results', []))


def sqs_send_params(queue_url, body):
    return {'Action': 'SendMessage', 'Version': '2012-11-05', 'QueueUrl': queue_url, 'MessageBody': json.dumps(body)}


def replay_verdict(before, after):
    """Return (ok, message). before/after are chunk counts around a replayed chunk message."""
    if after == before:
        return True, f'chunk count unchanged at {before}'
    if after > before:
        return False, f'replay duplicated chunks: {before} -> {after} (+{after - before})'
    return False, f'replay lost chunks: {before} -> {after} ({after - before})'


def counts_match(first, second):
    return first > 0 and first == second


# ---- live-stack plumbing -------------------------------------------------------------------


class Stack:
    def __init__(self, base_url, api_key, sqs_port):
        self.base_url = base_url.rstrip('/')
        self.api_key = api_key
        self.sqs = f'http://127.0.0.1:{sqs_port}'

    def api(self, method, path, body=None, raw=None, ok=(200, 201, 204)):
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        headers = {'x-api-key': self.api_key}
        if body is not None:
            headers['content-type'] = 'application/json'
        request = urllib.request.Request(self.base_url + path, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                status, text = response.status, response.read().decode()
        except urllib.error.HTTPError as error:
            status, text = error.code, error.read().decode()
        require(status in ok, f'{method} {path} -> {status}: {text[:300]}')
        return json.loads(text) if text.strip() else {}

    def create_lake(self, prefix):
        lake = self.api('POST', '/api/data-lakes', {
            'name': 'verify ' + prefix, 'slug': 'verify-' + prefix.rstrip(':'), 'fileTagPrefix': prefix,
        })
        return lake.get('id') or lake['_id']

    def upload_text(self, name, text, tag):
        payload = text.encode()
        created = self.api('POST', '/api/files/createFabFile', {
            'fileName': name, 'mimeType': 'text/plain', 'fileSize': len(payload), 'type': 'FILE',
            'tags': [{'name': tag, 'strength': 1}],
        })
        file_id = created['id']
        # Self-host hands back the same-origin proxy path; it marks the file complete itself.
        url = created['presignedUrl']
        require(url.startswith('/'), f'expected the self-host upload proxy path, got {url[:80]!r}')
        self.api('PUT', url, raw=payload)
        return file_id

    def search(self, query):
        return self.api('POST', '/api/data-lakes/semantic-search', {'query': query, 'top_k': 10})

    def sqs_call(self, **params):
        payload = urllib.parse.urlencode(params).encode()
        with urllib.request.urlopen(self.sqs, data=payload, timeout=10) as response:
            return ET.fromstring(response.read())

    def send_chunk_message(self, file_id, user_id):
        queue = self.sqs_call(Action='GetQueueUrl', Version='2012-11-05', QueueName=CHUNK_QUEUE)
        queue_url = queue.findtext('.//{*}QueueUrl')
        require(queue_url, f'queue {CHUNK_QUEUE} not found on {self.sqs}')
        # The URL elasticmq reports names its own in-container host; POST to the published port instead.
        path = urllib.parse.urlparse(queue_url).path
        params = sqs_send_params(self.sqs + path, {'fabFileId': file_id, 'userId': user_id})
        self.sqs_call(**params)


def mongo_eval(js):
    out = subprocess.run(
        [*COMPOSE, 'exec', '-T', 'mongo', 'mongosh', '--quiet', DB_NAME, '--eval', js],
        cwd=ROOT, check=True, text=True, stdout=subprocess.PIPE, timeout=60,
    ).stdout
    return parse_mongosh_json(out)


def chunk_state(file_id):
    """FabFile status plus chunk/vector counts, read straight from Mongo (the public API hides them)."""
    return mongo_eval(f"""
        const id = {json.dumps(file_id)};
        const f = db.fabfiles.findOne({{ _id: ObjectId(id) }}, {{ status: 1, userId: 1, isChunking: 1, chunkCount: 1 }});
        const c = db.fabfilechunks;
        const q = {{ fabFileId: id }};
        print(JSON.stringify({{
          status: f && f.status, userId: f && f.userId, isChunking: !!(f && f.isChunking),
          chunks: c.countDocuments(q),
          embedded: c.countDocuments({{ fabFileId: id, 'vector.0': {{ $exists: true }}, embeddingModel: {{ $nin: [null, ''] }} }}),
          models: c.distinct('embeddingModel', {{ fabFileId: id, embeddingModel: {{ $nin: [null, ''] }} }}),
          ids: c.find(q, {{ _id: 1 }}).toArray().map(d => String(d._id)).sort(),
        }}));
    """)


def auto_chunk_enabled():
    # The setting defaults to on; only an explicit false disables it.
    return mongo_eval(
        "const s = db.adminsettings.findOne({ settingName: 'enableAutoChunk' });"
        "print(JSON.stringify(!(s && s.settingValue === false)));"
    )


def mc(command):
    return subprocess.run(
        [*COMPOSE, 'run', '--rm', '--no-deps', '--entrypoint', '/bin/sh', 'createbuckets', '-ec',
         'mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null; ' + command],
        cwd=ROOT, check=True, text=True, stdout=subprocess.PIPE, timeout=180,
    ).stdout


WEBHOOK = 'arn:minio:sqs::primary:webhook'


# ---- scenarios -------------------------------------------------------------------------------


def sentinel_text(sentinel):
    # Identical bodies across scenarios (only the sentinel differs, same length) so counts compare.
    paragraph = 'Self-host knowledge pipelines turn uploaded files into searchable passages. ' * 12
    return f'{sentinel}\n\n' + '\n\n'.join(paragraph for _ in range(6))


class Run:
    def __init__(self, stack, prefix, timeout):
        self.stack, self.prefix, self.timeout = stack, prefix, timeout
        self.files = []
        self.happy = None

    def new_file(self, label):
        sentinel = f'zebra-{uuid.uuid4().hex[:12]}'
        name = f'verify-{label}-{uuid.uuid4().hex[:6]}.txt'
        file_id = self.stack.upload_text(name, sentinel_text(sentinel), self.prefix + label)
        self.files.append(file_id)
        return file_id, sentinel

    def wait_chunked(self, file_id, timeout):
        return poll(lambda: chunk_state(file_id), chunk_state_ok, timeout, what=f'file {file_id} chunked and embedded')

    def happy_path(self):
        file_id, sentinel = self.new_file('happy')
        state = self.wait_chunked(file_id, self.timeout)
        hit = poll(lambda: self.stack.search(sentinel), lambda r: search_hit(r, file_id), self.timeout,
                   what='semantic search to return the file')
        require(search_hit(hit, file_id), 'search did not return the uploaded file')
        self.happy = (file_id, state)
        return f'{state["chunks"]} chunks, all embedded with {state["models"][0]}, found by search'

    def rescue(self):
        bucket = mc('echo "$FAB_FILE_BUCKET"').strip()
        require(bucket, 'FAB_FILE_BUCKET is empty in the createbuckets environment')
        mc(f'mc event remove local/{bucket} {WEBHOOK}')
        try:
            file_id, _ = self.new_file('rescue')
            time.sleep(5)
            state = chunk_state(file_id)
            require(state['status'] == 'complete', f'expected complete after upload, got {state["status"]!r}')
            require(state['chunks'] == 0, f'webhook withheld but file already has {state["chunks"]} chunks')
        finally:
            mc(f'mc event add local/{bucket} {WEBHOOK} --event put --ignore-existing')
        # min age 2 min + 60s sweep tick + chunk/vectorize
        state = self.wait_chunked(file_id, max(self.timeout, 420))
        message = f'rescue sweep chunked and embedded it ({state["chunks"]} chunks)'
        if self.happy:
            require(counts_match(self.happy[1]['chunks'], state['chunks']),
                    f'rescued file has {state["chunks"]} chunks, happy-path file had {self.happy[1]["chunks"]}')
            message += ', matching the happy-path count'
        return message

    def replay(self):
        if not self.happy:
            file_id, _ = self.new_file('replay')
            self.wait_chunked(file_id, self.timeout)
        else:
            file_id = self.happy[0]
        before = chunk_state(file_id)
        self.stack.send_chunk_message(file_id, before['userId'])
        # Settle: not chunking and unchanged across two polls, after giving the worker time to pick it up.
        time.sleep(10)
        previous = []
        def read():
            nonlocal previous
            current = chunk_state(file_id)
            stable = not current['isChunking'] and current['ids'] == previous
            previous = current['ids']
            return {**current, 'stable': stable}
        after = poll(read, lambda s: s['stable'], self.timeout, what='replayed message to settle')
        ok, message = replay_verdict(before['chunks'], after['chunks'])
        require(ok, message)
        path = 'chunk ids unchanged (guard)' if after['ids'] == before['ids'] else 'chunk ids changed (delete and recreate)'
        return f'{message}; {path}'

    def cleanup(self, lake_id):
        for file_id in self.files:
            try:
                self.stack.api('DELETE', f'/api/v1/files/{file_id}')
            except Exception as error:
                print(f'cleanup: could not delete file {file_id}: {error}', file=sys.stderr)
        if lake_id:
            try:
                self.stack.api('DELETE', f'/api/data-lakes/{lake_id}')
            except Exception as error:
                print(f'cleanup: could not delete lake {lake_id}: {error}', file=sys.stderr)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--only', choices=SCENARIOS, help='run a single scenario')
    parser.add_argument('--timeout', type=int, default=180, help='seconds to wait per step (default 180)')
    args = parser.parse_args(argv)

    api_key = os.environ.get('B4M_API_KEY')
    if not api_key:
        raise SystemExit('Set B4M_API_KEY to an API key with files:write and data-lake scopes (see --help)')
    if not (ROOT / '.env.selfhost').is_file():
        raise SystemExit('Configure .env.selfhost and start the stack before running this check')

    stack = Stack(os.environ.get('B4M_BASE_URL', 'http://127.0.0.1:3000'), api_key,
                  os.environ.get('SQS_HOST_PORT', '9324'))
    if not auto_chunk_enabled():
        raise SystemExit('Enable Auto Chunk is off; turn it on in admin settings and re-run')

    prefix = f'verify{uuid.uuid4().hex[:8]}:'
    run = Run(stack, prefix, args.timeout)
    lake_id = stack.create_lake(prefix)
    wanted = [args.only] if args.only else list(SCENARIOS)
    failed = False
    try:
        for name in wanted:
            try:
                print(f'PASS {name}: {getattr(run, "happy_path" if name == "happy" else name)()}', flush=True)
            except Exception as error:
                failed = True
                print(f'FAIL {name}: {error}', flush=True)
    finally:
        run.cleanup(lake_id)
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
