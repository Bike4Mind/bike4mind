import { describe, it, expect } from 'vitest';
import { resolveProxyTarget } from './appFileProxy';

describe('resolveProxyTarget', () => {
  it('routes generated images to the generated bucket and strips the prefix', () => {
    expect(resolveProxyTarget('generated/abc-123.png')).toEqual({
      bucket: 'generated',
      key: 'abc-123.png',
    });
  });

  it('maps org-files back to the organizations key prefix in appFiles', () => {
    expect(resolveProxyTarget('org-files/org123/logo.png')).toEqual({
      bucket: 'appFiles',
      key: 'organizations/org123/logo.png',
    });
  });

  it.each([
    ['proxied-images/hash.jpg', 'proxied-images/hash.jpg'],
    ['admin/logos/custom-light.png', 'admin/logos/custom-light.png'],
    ['profile-photos/u1/p.png', 'profile-photos/u1/p.png'],
    ['tavern-sounds/custom/u1/slot.mp3', 'tavern-sounds/custom/u1/slot.mp3'],
    ['tavern-icons/pack/bg/1.png', 'tavern-icons/pack/bg/1.png'],
    ['app-config/public-settings.json', 'app-config/public-settings.json'],
  ])('passes through %s unchanged to appFiles', (input, expectedKey) => {
    expect(resolveProxyTarget(input)).toEqual({ bucket: 'appFiles', key: expectedKey });
  });

  it.each([
    'transcripts/job.json',
    'transcribe-uploads/x',
    'cc-bridge-downloads/u/z.zip',
    'cc-bridge/artifacts/bin',
    'organizations/123/x.png',
    'random/foo',
    '',
  ])('returns null for blocked prefix: %s', input => {
    expect(resolveProxyTarget(input)).toBeNull();
  });
});
