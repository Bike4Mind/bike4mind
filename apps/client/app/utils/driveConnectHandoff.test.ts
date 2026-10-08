import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  consumeDriveConnectHandoff,
  DRIVE_CONNECT_HANDOFF_TTL_MS,
  DRIVE_PICKER_RESUME_TTL_MS,
  rebindDriveConnectHandoff,
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

  it('hands out the picker-resume signal once, to the user it was raised for', () => {
    expect(takeDrivePickerResume('user-1', T0)).toBe(false);
    requestDrivePickerResume('user-1', T0);
    expect(takeDrivePickerResume('user-1', T0 + 1)).toBe(true);
    expect(takeDrivePickerResume('user-1', T0 + 1)).toBe(false);
  });

  it.each([
    ['another user', 'user-2', T0 + 1],
    ['no signed-in user', undefined, T0 + 1],
    ['a signal past its TTL', 'user-1', T0 + DRIVE_PICKER_RESUME_TTL_MS + 1],
    ['a clock before the signal', 'user-1', T0 - 1],
  ])('refuses and clears the picker-resume signal for %s', (_label, userId, now) => {
    requestDrivePickerResume('user-1', T0);
    expect(takeDrivePickerResume(userId, now)).toBe(false);
    expect(takeDrivePickerResume('user-1', T0 + 1)).toBe(false);
  });

  describe('rebinding to a retry', () => {
    const owner = { userId: 'user-1', organizationId: 'org-1' };
    const RETRY_URL = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x&state=st-2';

    it("moves the failed attempt's draft onto the retry state, keeping its original TTL", () => {
      saveDriveConnectHandoff(wizardDraft, AUTH_URL, T0);
      rebindDriveConnectHandoff({ ...owner, fromState: 'st-1', authUrl: RETRY_URL, now: T0 + 5000 });

      expect(consumeDriveConnectHandoff({ ...match, oauthState: 'st-1' })).toBeNull();
      saveDriveConnectHandoff(wizardDraft, AUTH_URL, T0);
      rebindDriveConnectHandoff({ ...owner, fromState: 'st-1', authUrl: RETRY_URL, now: T0 + 5000 });
      expect(
        consumeDriveConnectHandoff({ ...owner, oauthState: 'st-2', now: T0 + DRIVE_CONNECT_HANDOFF_TTL_MS })
      ).toEqual({ ...wizardDraft, v: 1, oauthState: 'st-2', savedAt: T0 });
    });

    it('cannot extend a draft past its original TTL by retrying', () => {
      saveDriveConnectHandoff(wizardDraft, AUTH_URL, T0);
      rebindDriveConnectHandoff({ ...owner, fromState: 'st-1', authUrl: RETRY_URL, now: T0 + 5000 });
      expect(
        consumeDriveConnectHandoff({ ...owner, oauthState: 'st-2', now: T0 + DRIVE_CONNECT_HANDOFF_TTL_MS + 1 })
      ).toBeNull();
    });

    it.each([
      ['another attempt', { fromState: 'st-other' }],
      ['another user', { userId: 'user-2' }],
      ['another org', { organizationId: null }],
      ['an expired draft', { now: T0 + DRIVE_CONNECT_HANDOFF_TTL_MS + 1 }],
      ['a retry URL without state', { authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x' }],
    ])('drops instead of rebinding a draft for %s', (_label, override) => {
      saveDriveConnectHandoff(wizardDraft, AUTH_URL, T0);
      rebindDriveConnectHandoff({ ...owner, fromState: 'st-1', authUrl: RETRY_URL, now: T0 + 1, ...override });
      expect(sessionStorage.getItem(KEY)).toBeNull();
    });

    it('never throws when storage is blocked', () => {
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('blocked');
      });
      expect(() => rebindDriveConnectHandoff({ ...owner, fromState: 'st-1', authUrl: RETRY_URL })).not.toThrow();
    });
  });
});
