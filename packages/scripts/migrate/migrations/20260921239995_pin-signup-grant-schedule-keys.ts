import mongoose from 'mongoose';
import { AdminSettings } from '@bike4mind/database';
import type { MigrationFile } from './index';
import {
  isStoredToggleOn,
  signupGrantScheduleFromValues,
  storedGrantCredits,
  type LegacySignupGrantCreditKey,
} from './legacySignupGrantSchedule';

export const PIN_MARKER_COLLECTION = 'adminsettings_retiredsignupgrant';

const READ_KEYS: LegacySignupGrantCreditKey[] = [
  'signupGrantInitialCredits',
  'signupGrantDailyCredits',
  'signupGrantDripCap',
  'signupGrantInviteBonusCredits',
  'signupGrantCredits',
  'signupGrantActivityDailyCredits',
  'signupGrantActivityMaxCredits',
  'verifiedUnlockCredits',
];

// The registry default signupGrantDripCap falls back to once the legacy keys stop being read.
const DRIP_CAP_DEFAULT = 9000;

interface PinMarker {
  kind: 'pins';
  pins: { settingName: string; settingValue: string }[];
}

/**
 * Pins every schedule key the legacy fallback still supplies, so the schedule stays the same once the
 * resolver reads only signupGrantInitialCredits, signupGrantDailyCredits, signupGrantDripCap and
 * signupGrantInviteBonusCredits. Stored values are left alone. A drip/unlock split (activity max below
 * verifiedUnlockCredits with no cap stored) cannot be held by one cap, so it throws before writing and an
 * operator sets signupGrantDripCap by hand.
 */
const migration: MigrationFile = {
  id: 20260921239995,
  name: 'pin-signup-grant-schedule-keys',
  up: async () => {
    const rows = await AdminSettings.find({
      settingName: { $in: [...READ_KEYS, 'signupGrantActivityEnabled'] },
    }).lean();
    const raw = new Map<string, unknown>(rows.map(row => [row.settingName, row.settingValue]));
    const stored = (key: LegacySignupGrantCreditKey) => storedGrantCredits(key, raw.get(key));
    // Matches the current runtime read: staging always on, defaultFreeCredits ignored.
    const legacy = signupGrantScheduleFromValues(key => (key === 'defaultFreeCredits' ? undefined : stored(key)), {
      staged: true,
      activity: isStoredToggleOn(raw.get('signupGrantActivityEnabled')),
    });
    if (legacy.unlockCredits !== legacy.dripCap) {
      throw new Error(
        `Signup grant drip cap (${legacy.dripCap}) and verification unlock (${legacy.unlockCredits}) differ and no ` +
          'signupGrantDripCap is stored; set signupGrantDripCap to the intended amount, then rerun.'
      );
    }

    const wanted: [LegacySignupGrantCreditKey, number | undefined][] = [
      ['signupGrantInitialCredits', legacy.initialCredits],
      ['signupGrantDailyCredits', legacy.dailyCredits],
      ['signupGrantInviteBonusCredits', legacy.inviteBonusCredits],
      ['signupGrantDripCap', legacy.dripCap === DRIP_CAP_DEFAULT ? undefined : legacy.dripCap],
    ];
    const pins: PinMarker['pins'] = [];
    for (const [settingName, value] of wanted) {
      if (value === undefined || stored(settingName) !== undefined) continue;
      const settingValue = String(value);
      // A blank or invalid row is overwritten only if it still holds what was read.
      const result = raw.has(settingName)
        ? await AdminSettings.updateOne({ settingName, settingValue: raw.get(settingName) }, { $set: { settingValue } })
        : await AdminSettings.updateOne(
            { settingName },
            { $setOnInsert: { settingName, settingValue } },
            { upsert: true }
          );
      if (result.modifiedCount > 0 || result.upsertedCount > 0) pins.push({ settingName, settingValue });
    }
    if (pins.length > 0) {
      await mongoose.connection
        .collection<PinMarker>(PIN_MARKER_COLLECTION)
        .updateOne({ kind: 'pins' }, { $push: { pins: { $each: pins } } }, { upsert: true });
    }
  },
  // Removes only the rows this migration pinned that still hold the pinned value.
  down: async () => {
    const markers = mongoose.connection.collection<PinMarker>(PIN_MARKER_COLLECTION);
    const marker = await markers.findOne({ kind: 'pins' });
    for (const { settingName, settingValue } of marker?.pins ?? []) {
      await AdminSettings.deleteOne({ settingName, settingValue });
    }
    await markers.deleteOne({ kind: 'pins' });
  },
};

export default migration;
