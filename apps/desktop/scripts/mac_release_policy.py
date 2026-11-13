"""Select a macOS signing path without treating missing configuration as consent."""

import os
import re


def signing_mode(version, signing, adhoc, preview=False, selfsigned=''):
    match = re.fullmatch(r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-pr\.[1-9]\d*\.[1-9]\d*)?', version)
    if not match:
        raise ValueError('Desktop publication requires a valid version')
    if preview:
        return 'adhoc'
    if any(value not in ('', 'false', 'true') for value in (signing, adhoc, selfsigned)):
        raise ValueError('Signing opt-ins must be exactly true, false, or unset')
    # The strongest signing opted into wins, so turning a stronger mode on needs no other change.
    if signing == 'true':
        return 'signed'
    # Account-free distribution is a beta concession; a 1.x release must be Developer ID signed.
    if selfsigned == 'true' and match[1] == '0':
        return 'selfsigned'
    if selfsigned == 'true':
        raise ValueError('Self-signed macOS publication requires a 0.x beta version')
    if adhoc == 'true' and match[1] == '0':
        return 'adhoc'
    if adhoc == 'true':
        raise ValueError('Ad-hoc macOS publication requires a 0.x beta version')
    raise ValueError('Set DESKTOP_MAC_SIGNING=true or explicitly opt into DESKTOP_MAC_SELFSIGNED_BETA=true '
                     'or DESKTOP_MAC_ADHOC_BETA=true')


if __name__ == '__main__':
    mode = signing_mode(os.environ['DESKTOP_VERSION'], os.environ.get('SIGNING', ''),
                        os.environ.get('ADHOC_BETA', ''), os.environ.get('GITHUB_EVENT_NAME') == 'pull_request',
                        os.environ.get('SELFSIGNED_BETA', ''))
    if 'EXPECTED_MAC_MODE' in os.environ and mode != os.environ['EXPECTED_MAC_MODE']:
        raise ValueError('Signing policy changed after build; rerun with consistent configuration')
    print(f'macOS signing mode: {mode}')
    with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
        output.write(f'mode={mode}\n')
