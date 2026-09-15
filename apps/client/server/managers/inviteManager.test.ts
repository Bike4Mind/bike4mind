import { describe, it, expect, vi } from 'vitest';

// inviteManager imports these at module load; stub them so the pure helper loads
// without pulling the real DB graph.
vi.mock('@bike4mind/database', () => ({ FabFile: {}, Group: {}, Organization: {}, Session: {}, User: {} }));

import { filterInviteRecipientsToSelf } from './inviteManager';

const baseInvite = () => ({
  id: 'inv1',
  type: 'FabFile',
  recipients: { pending: ['A@x.com', 'b@x.com'], accepted: ['c@x.com'], refused: ['d@x.com'] },
});

describe('filterInviteRecipientsToSelf', () => {
  it('keeps only the caller entry (case-insensitive) and strips co-recipients', () => {
    const out = filterInviteRecipientsToSelf(baseInvite(), 'a@x.com') as any;
    expect(out.recipients).toEqual({ pending: ['A@x.com'], accepted: [], refused: [] });
    const json = JSON.stringify(out);
    expect(json).not.toContain('b@x.com');
    expect(json).not.toContain('c@x.com');
    expect(json).not.toContain('d@x.com');
  });

  it('normalizes a Mongoose-style doc via toJSON before filtering', () => {
    const doc = { toJSON: () => baseInvite() };
    const out = filterInviteRecipientsToSelf(doc, 'c@x.com') as any;
    expect(out.recipients.accepted).toEqual(['c@x.com']);
    expect(out.recipients.pending).toEqual([]);
  });

  it('returns empty recipient arrays when the caller has no email', () => {
    const out = filterInviteRecipientsToSelf(baseInvite(), null) as any;
    expect(out.recipients).toEqual({ pending: [], accepted: [], refused: [] });
  });

  it('leaves an invite without recipients untouched', () => {
    const out = filterInviteRecipientsToSelf({ id: 'i2', type: 'Session' }, 'a@x.com') as any;
    expect('recipients' in out).toBe(false);
    expect(out.id).toBe('i2');
  });
});
