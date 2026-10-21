import { describe, expect, it } from 'vitest';
import type { SettingKey } from '@bike4mind/common';
import { STUDIO_FLAGS_OFF, resolveStudioFlags } from './studioFlags';

const settingsOn =
  (...keys: SettingKey[]) =>
  (key: SettingKey) =>
    keys.includes(key);

const ALL_ON = settingsOn('EnableStudioCreateV2', 'EnableStudioImage', 'EnableStudioProductions');

describe('resolveStudioFlags', () => {
  it('is all off for an admin when no setting is on', () => {
    expect(resolveStudioFlags({ isAdmin: true, isSettingOn: settingsOn() })).toEqual(STUDIO_FLAGS_OFF);
  });

  it('is all off for a non-admin even with every setting on', () => {
    expect(resolveStudioFlags({ isAdmin: false, isSettingOn: ALL_ON })).toEqual(STUDIO_FLAGS_OFF);
  });

  it('turns every flag on for an admin with every setting on', () => {
    expect(resolveStudioFlags({ isAdmin: true, isSettingOn: ALL_ON })).toEqual({
      createV2: true,
      image: true,
      productions: true,
    });
  });

  it('keeps Image and Productions off without Create v2', () => {
    const isSettingOn = settingsOn('EnableStudioImage', 'EnableStudioProductions');
    expect(resolveStudioFlags({ isAdmin: true, isSettingOn })).toEqual(STUDIO_FLAGS_OFF);
  });

  it('turns on only Create v2 when only its setting is on', () => {
    expect(resolveStudioFlags({ isAdmin: true, isSettingOn: settingsOn('EnableStudioCreateV2') })).toEqual({
      createV2: true,
      image: false,
      productions: false,
    });
  });
});
