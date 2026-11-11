import { describe, expect, it } from 'vitest';
import { AdminSettings } from '@bike4mind/database';
import type { IUserDocument } from '@bike4mind/common';
import defineAbilitiesFor from './ability';

const member = { id: 'user-1', isAdmin: false, tags: [] } as unknown as IUserDocument;
const setting = (settingName: string) => new AdminSettings({ settingName, settingValue: 'x' });

describe('AdminSettings read ability for a non-admin', () => {
  it('reads the model-list revision, which wakes an open model picker', () => {
    expect(defineAbilitiesFor(member).can('read', setting('modelListRevision'))).toBe(true);
  });

  it('still cannot read a setting outside the allowlist', () => {
    expect(defineAbilitiesFor(member).can('read', setting('enforceCredits'))).toBe(false);
  });
});
