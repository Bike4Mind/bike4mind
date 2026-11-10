import { describe, it, expect, vi, beforeEach } from 'vitest';

const { recordAdminActionFromRequest, userAuditTarget } = vi.hoisted(() => ({
  recordAdminActionFromRequest: vi.fn(),
  userAuditTarget: vi.fn(),
}));
vi.mock('@bike4mind/server-utils/utils/adminAudit', () => ({ recordAdminActionFromRequest, userAuditTarget }));

import { recordFeedbackRead } from './feedbackReadAudit';

const req = { user: { id: 'admin-1' } } as unknown as Parameters<typeof recordFeedbackRead>[0];

beforeEach(() => {
  vi.clearAllMocks();
  recordAdminActionFromRequest.mockResolvedValue(null);
  userAuditTarget.mockImplementation(async (id: string) => ({ kind: 'user', id, displayName: `${id}@example.com` }));
});

describe('recordFeedbackRead', () => {
  it('writes one feedback.viewed entry targeting the single reporter, with ids and caller details', async () => {
    await recordFeedbackRead(
      req,
      [
        { id: 'f1', userId: 'user-2' },
        { id: 'f2', userId: 'user-2' },
      ],
      { page: 1 }
    );

    expect(recordAdminActionFromRequest).toHaveBeenCalledTimes(1);
    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(req, {
      action: 'feedback.viewed',
      target: { kind: 'user', id: 'user-2', displayName: 'user-2@example.com' },
      summary: 'viewed 2 feedback report(s) from 1 user(s)',
      details: { page: 1, feedbackIds: ['f1', 'f2'] },
    });
  });

  it('targets the feedback collection when the reports have several owners', async () => {
    await recordFeedbackRead(req, [
      { id: 'f1', userId: 'user-2' },
      { id: 'f2', userId: 'user-3' },
    ]);

    expect(userAuditTarget).not.toHaveBeenCalled();
    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      req,
      expect.objectContaining({ target: { kind: 'system', id: 'feedback', displayName: 'feedback reports' } })
    );
  });

  it('lists only other users reports when the page mixes in the caller own', async () => {
    await recordFeedbackRead(req, [
      { id: 'mine', userId: 'admin-1' },
      { id: 'theirs', userId: 'user-2' },
    ]);

    const [, input] = recordAdminActionFromRequest.mock.calls[0];
    expect(input.details.feedbackIds).toEqual(['theirs']);
    expect(input.target.id).toBe('user-2');
  });

  it('writes nothing when the caller reads only their own reports', async () => {
    await recordFeedbackRead(req, [{ id: 'mine', userId: 'admin-1' }]);
    expect(recordAdminActionFromRequest).not.toHaveBeenCalled();
  });

  it('writes nothing for an empty page', async () => {
    await recordFeedbackRead(req, []);
    expect(recordAdminActionFromRequest).not.toHaveBeenCalled();
  });

  it('propagates an audit failure so the read fails', async () => {
    recordAdminActionFromRequest.mockRejectedValue(new Error('audit store down'));
    await expect(recordFeedbackRead(req, [{ id: 'f1', userId: 'user-2' }])).rejects.toThrow('audit store down');
  });
});
