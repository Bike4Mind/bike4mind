import { describe, expect, it } from 'vitest';
import { ADMIN_ACTION_REASON_MAX_LENGTH } from '@bike4mind/common';
import { undoAdminReason } from './adminReason';

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
