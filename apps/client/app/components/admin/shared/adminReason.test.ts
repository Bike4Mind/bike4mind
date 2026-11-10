import { describe, expect, it } from 'vitest';
import { ADMIN_ACTION_REASON_MAX_LENGTH } from '@bike4mind/common';
import { parseAdminActionReason } from '@bike4mind/server-utils/utils/adminAudit';
import {
  ADMIN_REASON_PRESETS,
  adminReasonHint,
  composeAdminReason,
  isAdminReasonComplete,
  undoAdminReason,
} from './adminReason';

describe('undoAdminReason', () => {
  it('prefixes the original reason', () => {
    expect(undoAdminReason('Repeated abuse reports')).toBe('Undo: Repeated abuse reports');
  });

  it('truncates to the shared maximum so an undo of a long reason is still accepted', () => {
    const undone = undoAdminReason('x'.repeat(ADMIN_ACTION_REASON_MAX_LENGTH));
    expect(undone).toHaveLength(ADMIN_ACTION_REASON_MAX_LENGTH);
    expect(undone.startsWith('Undo: x')).toBe(true);
  });
});

describe('ADMIN_REASON_PRESETS', () => {
  // ReasonPicker sends a preset on its own as the whole reason, so the audit entry must keep it verbatim.
  it.each(Object.values(ADMIN_REASON_PRESETS).flat())('passes parseAdminActionReason unchanged: %j', preset => {
    expect(parseAdminActionReason(preset)).toBe(preset);
    expect(parseAdminActionReason(composeAdminReason({ preset, note: ' ticket 42 ' }))).toBe(`${preset}: ticket 42`);
  });
});

describe('isAdminReasonComplete', () => {
  it('holds the shared minimum by default and a looser one when the endpoint asks for it', () => {
    const shortNote = { preset: null, note: 'ok' };
    expect(isAdminReasonComplete(shortNote)).toBe(false);
    expect(isAdminReasonComplete(shortNote, 1)).toBe(true);
    expect(isAdminReasonComplete({ preset: null, note: '   ' }, 1)).toBe(false);
    expect(isAdminReasonComplete({ preset: null, note: 'x'.repeat(ADMIN_ACTION_REASON_MAX_LENGTH + 1) }, 1)).toBe(
      false
    );
    expect(adminReasonHint(1)).toBe('Pick a reason or write one.');
  });
});
