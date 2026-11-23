import { describe, it, expect } from 'vitest';
import { isUntrackedAppFileKey } from './untrackedAppFileKey';

describe('isUntrackedAppFileKey', () => {
  it.each([
    'bob-screenshots/run-1/desktop.png',
    'bob-screenshots/run-1/phone.png',
    'org-feedback-summaries/org-1/job-1.json',
    'tavern-icons/pack/bg/1.png',
    'tavern-sounds/defaults/slot.mp3',
    'app-config/public-settings.json',
    'text-edit-backups/u1/id_notes.txt',
    'files/u1/backups/id_notes.txt',
    'queued-mail/0b6f8a52-3c1e-4f7d-9a0b-2d4c6e8f1a3b.json',
  ])('skips %s', key => {
    expect(isUntrackedAppFileKey(key)).toBe(true);
  });

  it.each([
    '0b6f3c1e-1d2a-4f4e-9a8b-0c1d2e3f4a5b.png',
    'profile-photos/user-1/photo.png',
    'organizations/org-1/logo.png',
    'admin/logos/custom-light-logo-abc.png',
  ])('does not skip AppFile-tracked key %s', key => {
    expect(isUntrackedAppFileKey(key)).toBe(false);
  });
});
