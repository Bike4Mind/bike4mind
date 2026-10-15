"""Select a macOS signing path without treating missing configuration as consent."""

import os
import re


def signing_mode(version, signing, adhoc, preview=False):
    if not re.fullmatch(r'0\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-pr\.[1-9]\d*\.[1-9]\d*)?', version):
        raise ValueError('Desktop publication requires a valid 0.x beta version')
    if preview:
        return 'adhoc'
    if signing not in ('', 'false', 'true') or adhoc not in ('', 'false', 'true'):
        raise ValueError('Signing opt-ins must be exactly true, false, or unset')
    if signing == 'true':
        return 'signed'
    if adhoc == 'true':
        return 'adhoc'
    raise ValueError('Set DESKTOP_MAC_SIGNING=true or explicitly opt into DESKTOP_MAC_ADHOC_BETA=true')


if __name__ == '__main__':
    mode = signing_mode(os.environ['DESKTOP_VERSION'], os.environ.get('SIGNING', ''),
                        os.environ.get('ADHOC_BETA', ''), os.environ.get('GITHUB_EVENT_NAME') == 'pull_request')
    if 'EXPECTED_MAC_MODE' in os.environ and mode != os.environ['EXPECTED_MAC_MODE']:
        raise ValueError('Signing policy changed after build; rerun with consistent configuration')
    print(f'macOS signing mode: {mode}')
    with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
        output.write(f'mode={mode}\n')
