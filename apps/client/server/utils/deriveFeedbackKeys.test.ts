import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  questFindById: vi.fn(),
  sessionFindById: vi.fn(),
}));

// Both models are read through a `.select().lean()` chain, so the mock has to return that shape.
const chain = (value: unknown) => ({ select: () => ({ lean: async () => value }) });

vi.mock('@bike4mind/database', () => ({
  Quest: { findById: (...a: unknown[]) => h.questFindById(...a) },
  Session: { findById: (...a: unknown[]) => h.sessionFindById(...a) },
}));

import { deriveFeedbackKeys } from './deriveFeedbackKeys';

const logger = { warn: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  h.questFindById.mockReturnValue(chain(null));
  h.sessionFindById.mockReturnValue(chain(null));
});

describe('deriveFeedbackKeys', () => {
  it('links the turn when the quest resolves to a session the caller owns', async () => {
    h.questFindById.mockReturnValue(chain({ sessionId: 'sess-1' }));
    h.sessionFindById.mockReturnValue(chain({ userId: 'user-1' }));

    const out = await deriveFeedbackKeys({ claimedQuestId: 'quest-1', userId: 'user-1', logger });

    expect(out).toEqual({
      sessionId: 'sess-1',
      questId: 'quest-1',
      organizationId: undefined,
      subject: 'turn',
    });
  });

  // The security property this helper exists for: a quest id is a CLAIM, and one pointing at
  // someone else's conversation must not become an authorization key on this record.
  it("DROPS both keys when the claimed quest's session belongs to another user", async () => {
    h.questFindById.mockReturnValue(chain({ sessionId: 'sess-victim' }));
    h.sessionFindById.mockReturnValue(chain({ userId: 'user-victim' }));

    const out = await deriveFeedbackKeys({ claimedQuestId: 'quest-victim', userId: 'attacker', logger });

    expect(out.questId).toBeUndefined();
    // Not just the questId: keeping the sessionId would still attach this to a foreign conversation.
    expect(out.sessionId).toBeUndefined();
    expect(out.subject).toBe('product');
    expect(logger.warn).toHaveBeenCalled();
  });

  it("never trusts a body-supplied organizationId - the caller's own org is what is stored", async () => {
    h.questFindById.mockReturnValue(chain({ sessionId: 'sess-1' }));
    h.sessionFindById.mockReturnValue(chain({ userId: 'user-1' }));

    const out = await deriveFeedbackKeys({
      claimedQuestId: 'quest-1',
      userId: 'user-1',
      organizationId: 'org-server-derived',
      logger,
    });

    expect(out.organizationId).toBe('org-server-derived');
  });

  it('falls back to session scope when only a session is claimed and owned', async () => {
    h.sessionFindById.mockReturnValue(chain({ userId: 'user-1' }));

    const out = await deriveFeedbackKeys({ claimedSessionId: 'sess-1', userId: 'user-1', logger });

    expect(out).toMatchObject({ sessionId: 'sess-1', subject: 'session' });
    expect(out.questId).toBeUndefined();
  });

  it('drops a claimed session the caller does not own', async () => {
    h.sessionFindById.mockReturnValue(chain({ userId: 'someone-else' }));

    const out = await deriveFeedbackKeys({ claimedSessionId: 'sess-x', userId: 'user-1', logger });

    expect(out).toEqual({ organizationId: undefined, subject: 'product' });
  });

  // A record whose promptMeta simply lacks the paths - the common case for product feedback and for
  // pre-existing rows - must resolve cleanly rather than throwing.
  it('resolves to product scope when no keys are claimed at all', async () => {
    const out = await deriveFeedbackKeys({ userId: 'user-1', logger });

    expect(out).toEqual({ organizationId: undefined, subject: 'product' });
    expect(h.questFindById).not.toHaveBeenCalled();
  });

  it('gives an anonymous submission no linkage, without even reading the quest', async () => {
    const out = await deriveFeedbackKeys({ claimedQuestId: 'quest-1', claimedSessionId: 'sess-1', logger });

    expect(out).toEqual({ subject: 'product' });
    expect(h.questFindById).not.toHaveBeenCalled();
    expect(h.sessionFindById).not.toHaveBeenCalled();
  });

  it('treats an unresolvable quest id as no linkage, and says so in the log', async () => {
    h.questFindById.mockReturnValue(chain(null));

    const out = await deriveFeedbackKeys({ claimedQuestId: 'deleted-quest', userId: 'user-1', logger });

    expect(out.subject).toBe('product');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('did not resolve'), expect.anything());
  });

  // A malformed id throws a CastError inside findById rather than returning null.
  it('survives a malformed id instead of 500-ing the submission', async () => {
    h.questFindById.mockImplementation(() => {
      throw new Error('CastError');
    });

    const out = await deriveFeedbackKeys({ claimedQuestId: 'not-an-objectid', userId: 'user-1', logger });

    expect(out.subject).toBe('product');
  });
});
