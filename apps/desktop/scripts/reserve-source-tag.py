"""Reserve a source tag only when the ref lookup explicitly returns HTTP 404."""

import json
import os
import re
import subprocess


def main():
    repository = os.environ['GITHUB_REPOSITORY']
    tag = 'desktop-v' + os.environ['DESKTOP_VERSION']
    sha = os.environ['GITHUB_SHA']
    result = subprocess.run(['gh', 'api', '--include', f'repos/{repository}/git/ref/tags/{tag}'],
                            stdout=subprocess.PIPE, text=True)
    if result.returncode:
        if not re.search(r'^HTTP/\S+ 404(?:\s|$)', result.stdout, re.M):
            raise SystemExit(result.returncode)
        subprocess.run(['gh', 'api', f'repos/{repository}/git/refs',
                        '-f', f'ref=refs/tags/{tag}', '-f', f'sha={sha}'], check=True)
    else:
        body = re.split(r'\r?\n\r?\n', result.stdout, maxsplit=1)[1]
        if json.loads(body)['object']['sha'] != sha:
            raise SystemExit('Source version tag belongs to another commit')


if __name__ == '__main__':
    main()
