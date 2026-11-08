import { describe, expect, it } from 'vitest';
import { ADMIN_ACTION_REASON_MAX_LENGTH } from '@bike4mind/common';
import { parseAdminActionReason } from '@bike4mind/server-utils/utils/adminAudit';
import { ADMIN_REASON_PRESETS, composeAdminReason, undoAdminReason } from './adminReason';

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
