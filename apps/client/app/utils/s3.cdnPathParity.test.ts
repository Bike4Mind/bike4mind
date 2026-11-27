import { describe, it, expect, vi } from 'vitest';
import { appFileKeyToCdnPath } from '@bike4mind/server-utils/utils/appFileProxy';

vi.mock('@client/app/hooks/data/settings', () => ({ useConfig: () => ({ data: undefined }) }));

import { toCdnPath } from './s3';

describe('appFileKeyToCdnPath parity with toCdnPath', () => {
  it.each([
    'organizations/org-1/logo.png',
    'admin/logos/site.png',
    'profile-photos/user-1/photo.jpg',
    'proxied-images/abc.png',
    '6f1c2b0e-9d7a-4c1e-8f00-1234567890ab',
  ])('maps %s the same way the client builds the URL', key => {
    expect(appFileKeyToCdnPath(key)).toBe(toCdnPath(key));
  });
});
