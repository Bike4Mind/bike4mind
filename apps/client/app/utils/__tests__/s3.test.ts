import { describe, it, expect, vi } from 'vitest';

// Mock the hooks module to avoid importing React/settings dependencies
vi.mock('@client/app/hooks/data/settings', () => ({
  useConfig: () => ({ data: null }),
}));

import { toCdnPath, getAppFileUrl } from '../s3';

describe('toCdnPath', () => {
  it('rewrites organizations/ prefix to org-files/', () => {
    expect(toCdnPath('organizations/abc123/uuid.png')).toBe('org-files/abc123/uuid.png');
  });

  it('rewrites organizations/ at the start only', () => {
    expect(toCdnPath('organizations/nested/path/file.jpg')).toBe('org-files/nested/path/file.jpg');
  });

  it('rewrites admin/logos/ prefix to admin-logos/', () => {
    expect(toCdnPath('admin/logos/logo.svg')).toBe('admin-logos/logo.svg');
    expect(toCdnPath('admin/logos/nested/dark-logo.png')).toBe('admin-logos/nested/dark-logo.png');
  });

  it('does not rewrite paths that do not start with organizations/ or admin/logos/', () => {
    expect(toCdnPath('profile-photos/user1/photo.png')).toBe('profile-photos/user1/photo.png');
    expect(toCdnPath('proxied-images/img.webp')).toBe('proxied-images/img.webp');
  });

  it('does not rewrite organizations embedded in other paths', () => {
    expect(toCdnPath('some/organizations/file.png')).toBe('some/organizations/file.png');
  });
});

describe('getAppFileUrl', () => {
  it('applies toCdnPath to the key', () => {
    process.env.NEXT_PUBLIC_CDN_URL = 'https://cdn.example.com';
    expect(getAppFileUrl({ key: 'organizations/abc/logo.png' })).toBe('https://cdn.example.com/org-files/abc/logo.png');
  });

  it('passes through non-rewritten keys unchanged', () => {
    process.env.NEXT_PUBLIC_CDN_URL = 'https://cdn.example.com';
    expect(getAppFileUrl({ key: 'profile-photos/user1/photo.png' })).toBe(
      'https://cdn.example.com/profile-photos/user1/photo.png'
    );
  });
});
