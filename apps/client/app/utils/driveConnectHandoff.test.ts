import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  consumeDriveConnectHandoff,
  DRIVE_CONNECT_HANDOFF_TTL_MS,
  requestDrivePickerResume,
  saveDriveConnectHandoff,
  takeDrivePickerResume,
  type DriveConnectHandoffInput,
} from './driveConnectHandoff';

const KEY = 'b4m:drive-connect-handoff';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x&state=st-1';
const T0 = 1_700_000_000_000;

const wizardDraft: DriveConnectHandoffInput = {
  kind: 'createWizard',
  userId: 'user-1',
  organizationId: 'org-1',
  config: {
    name: 'Research',
    description: 'notes',
    tagPrefix: 'research',
    requiredUserTag: '',
    requiredEntitlement: '',
    conflictResolution: 'skip',
  },
  autoDerivedTagPrefix: 'research',
  optionalSteps: { preview: true, taxonomy: false },
};

const match = { userId: 'user-1', organizationId: 'org-1', oauthState: 'st-1', now: T0 + 1000 };

afterEach(() => {
  sessionStorage.clear();
  vi.restoreAllMocks();
  takeDrivePickerResume();
});

describe('driveConnectHandoff', () => {
  it('round-trips a create-wizard draft bound to the authorize URL state', () => {
    saveDriveConnectHandoff(wizardDraft, AUTH_URL, T0);
    expect(consumeDriveConnectHandoff(match)).toEqual({ ...wizardDraft, v: 1, oauthState: 'st-1', savedAt: T0 });
  });

  it('round-trips an existing-lake handoff', () => {
    saveDriveConnectHandoff(
      { kind: 'lake', userId: 'user-1', organizationId: null, dataLakeId: 'lake-1' },
      AUTH_URL,
      T0
    );
    expect(consumeDriveConnectHandoff({ ...match, organizationId: null })).toMatchObject({
      kind: 'lake',
      dataLakeId: 'lake-1',
    });
  });

  it('clears after the first consume, so a draft resumes at most once', () => {
    saveDriveConnectHandoff(wizardDraft, AUTH_URL, T0);
    expect(consumeDriveConnectHandoff(match)).not.toBeNull();
    expect(sessionStorage.getItem(KEY)).toBeNull();
    expect(consumeDriveConnectHandoff(match)).toBeNull();
  });

  it('does not save when the authorize URL carries no state', () => {
    saveDriveConnectHandoff(wizardDraft, 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x', T0);
    expect(sessionStorage.getItem(KEY)).toBeNull();
    saveDriveConnectHandoff(wizardDraft, 'not a url', T0);
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it('accepts a draft exactly at the TTL and rejects one a millisecond past it', () => {
    saveDriveConnectHandoff(wizardDraft, AUTH_URL, T0);
    expect(consumeDriveConnectHandoff({ ...match, now: T0 + DRIVE_CONNECT_HANDOFF_TTL_MS })).not.toBeNull();
    saveDriveConnectHandoff(wizardDraft, AUTH_URL, T0);
    expect(consumeDriveConnectHandoff({ ...match, now: T0 + DRIVE_CONNECT_HANDOFF_TTL_MS + 1 })).toBeNull();
  });

  it.each([
    ['another user', { userId: 'user-2' }],
    ['another org', { organizationId: 'org-2' }],
    ['the personal scope', { organizationId: null }],
    ['another OAuth attempt', { oauthState: 'st-2' }],
    ['a clock before savedAt', { now: T0 - 1 }],
  ])('ignores the draft for %s and still clears it', (_label, override) => {
    saveDriveConnectHandoff(wizardDraft, AUTH_URL, T0);
    expect(consumeDriveConnectHandoff({ ...match, ...override })).toBeNull();
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it('rejects non-JSON, a future version, and a wrong shape', () => {
    for (const raw of ['{nope', JSON.stringify({ v: 2, kind: 'lake' }), JSON.stringify({ v: 1, kind: 'other' })]) {
      sessionStorage.setItem(KEY, raw);
      expect(consumeDriveConnectHandoff(match)).toBeNull();
      expect(sessionStorage.getItem(KEY)).toBeNull();
    }
  });

  it('keeps an empty name and defaults missing optionalSteps', () => {
    const { optionalSteps: _omit, ...rest } = wizardDraft as Extract<
      DriveConnectHandoffInput,
      { kind: 'createWizard' }
    >;
    sessionStorage.setItem(
      KEY,
      JSON.stringify({ ...rest, config: { ...rest.config, name: '' }, v: 1, oauthState: 'st-1', savedAt: T0 })
    );
    expect(consumeDriveConnectHandoff(match)).toMatchObject({
      config: { name: '' },
      optionalSteps: { preview: false, taxonomy: false },
    });
  });

  it('never throws when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => saveDriveConnectHandoff(wizardDraft, AUTH_URL, T0)).not.toThrow();
    expect(consumeDriveConnectHandoff(match)).toBeNull();
  });

  it('hands out the picker-resume signal once', () => {
    expect(takeDrivePickerResume()).toBe(false);
    requestDrivePickerResume();
    expect(takeDrivePickerResume()).toBe(true);
    expect(takeDrivePickerResume()).toBe(false);
  });
});
