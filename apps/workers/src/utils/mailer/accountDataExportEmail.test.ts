import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildAccountDataExportReadyEmail } from './accountDataExportEmail';

const PAGE_URL = 'https://app.example.com/account-data-export/7d0c1f5e-9a7b-4c1e-8f0a-2b3c4d5e6f70';

describe('buildAccountDataExportReadyEmail', () => {
  const originalBrand = process.env.APP_NAME;

  beforeEach(() => {
    process.env.APP_NAME = 'Acme';
  });

  afterEach(() => {
    process.env.APP_NAME = originalBrand;
  });

  it('links to the app download page, not a storage URL, and states the expiry', () => {
    const { subject, body } = buildAccountDataExportReadyEmail({
      downloadPageUrl: PAGE_URL,
      expiresAt: new Date('2026-03-02T15:30:00Z'),
    });

    expect(subject).toBe('Your Acme data export is ready');
    expect(body).toContain(`href="${PAGE_URL}"`);
    expect(body).toContain('March 2, 2026');
    expect(body).not.toContain('X-Amz-');
  });

  it('escapes the link', () => {
    const { body } = buildAccountDataExportReadyEmail({
      downloadPageUrl: 'https://app.example.com/x"><script>',
      expiresAt: new Date(),
    });

    expect(body).not.toContain('"><script>');
  });

  it('omits the brand cleanly when none is configured', () => {
    process.env.APP_NAME = '';
    expect(buildAccountDataExportReadyEmail({ downloadPageUrl: PAGE_URL, expiresAt: new Date() }).subject).toBe(
      'Your data export is ready'
    );
  });
});
