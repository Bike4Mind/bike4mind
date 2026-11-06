"""Delete the unpublished distribution drafts of a version the version job reclaimed."""

import json
import os
import subprocess


def main():
    repository = os.environ['GH_REPO']
    if repository.lower() == os.environ['GITHUB_REPOSITORY'].lower():
        raise SystemExit('Distribution must not use the source repository')
    tag = 'desktop-v' + os.environ['DESKTOP_VERSION']
    pages = json.loads(subprocess.check_output(
        ['gh', 'api', '--paginate', '--slurp', f'repos/{repository}/releases?per_page=100'], text=True))
    # Drafts have no tag ref, so one failed create can leave several drafts under the same name.
    drafts = [release for page in pages for release in page if release['tag_name'] == tag]
    if any(not release['draft'] for release in drafts):
        raise SystemExit(f'{tag} is already published; refusing to reclaim it')
    for release in drafts:
        subprocess.run(['gh', 'api', '--method', 'DELETE', f'repos/{repository}/releases/{release["id"]}'],
                       check=True)
        print(f'Deleted orphaned draft {tag} (release {release["id"]}, {len(release.get("assets", []))} assets)')


if __name__ == '__main__':
    main()
