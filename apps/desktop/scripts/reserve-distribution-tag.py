"""Give distribution releases a tag date without changing their target commit."""

from datetime import datetime, timezone
import json
import os
import re
import subprocess
from urllib.parse import quote


def api(path, method='GET', payload=None):
    command = ['gh', 'api', '--method', method, path]
    if payload is not None:
        command += ['--input', '-']
    return json.loads(subprocess.check_output(
        command, input=json.dumps(payload).encode() if payload is not None else None))


def main():
    repository = os.environ['GH_REPO']
    tag = os.environ.get('RELEASE_TAG_PREFIX', 'desktop-v') + os.environ['DESKTOP_VERSION']
    root = f'repos/{repository}'
    commit = api(f'{root}/commits/{quote(os.environ["RELEASE_TARGET"], safe="")}')['sha']
    path = f'{root}/git/ref/tags/{tag}'
    result = subprocess.run(['gh', 'api', '--include', path], stdout=subprocess.PIPE, text=True)
    exists = result.returncode == 0
    if not exists:
        if not re.search(r'^HTTP/\S+ 404(?:\s|$)', result.stdout, re.M):
            raise SystemExit(result.returncode or 1)
    else:
        reference = json.loads(re.split(r'\r?\n\r?\n', result.stdout, maxsplit=1)[1])['object']
        if reference['type'] == 'tag':
            annotated = api(f'{root}/git/tags/{reference["sha"]}')
            if annotated['object']['type'] != 'commit' or annotated['object']['sha'] != commit:
                raise SystemExit('Distribution version tag belongs to another commit')
            return
        if reference['type'] != 'commit' or reference['sha'] != commit:
            raise SystemExit('Distribution version tag belongs to another commit')
    annotated = api(f'{root}/git/tags', 'POST', {
        'tag': tag, 'message': 'Desktop ' + os.environ['DESKTOP_VERSION'],
        'object': commit, 'type': 'commit',
        'tagger': {'name': 'Desktop release publisher', 'email': 'desktop-release@users.noreply.github.com',
                   'date': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')},
    })
    if exists:
        api(f'{root}/git/refs/tags/{tag}', 'PATCH', {'sha': annotated['sha'], 'force': True})
    else:
        api(f'{root}/git/refs', 'POST', {'ref': f'refs/tags/{tag}', 'sha': annotated['sha']})


if __name__ == '__main__':
    main()
