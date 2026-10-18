"""Decide Latest from published stable desktop releases, not run creation order."""

import json
import re
import sys


STABLE = re.compile(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?')


def promote_latest(version, pages):
    match = STABLE.fullmatch(version)
    if not match:
        raise ValueError('Latest requires a stable desktop SemVer')
    current = tuple(map(int, match.groups()))
    for page in pages:
        for release in page:
            if release['draft'] or release['prerelease']:
                continue
            tag = release['tag_name']
            published = STABLE.fullmatch(tag.removeprefix('desktop-v')) if tag.startswith('desktop-v') else None
            if published and tuple(map(int, published.groups())) > current:
                return False
    return True


if __name__ == '__main__':
    print(str(promote_latest(sys.argv[1], json.load(sys.stdin))).lower())
