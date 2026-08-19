import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const mockRefs = vi.hoisted(() => ({
  postHandler: null as null | ((req: unknown, res: unknown) => unknown),
}));

vi.mock('@server/middlewares/baseApi', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {
    get: () => chain,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    post: (fn: any) => {
      mockRefs.postHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

const savedFeedback = { id: 'fb1' };
const mockSave = vi.fn().mockResolvedValue(undefined);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function FeedbackModelMock(this: any, data: unknown) {
  Object.assign(this, data, {
    id: savedFeedback.id,
    save: mockSave,
    toJSON: () => ({ id: savedFeedback.id, ...(data as object) }),
  });
}

vi.mock('@bike4mind/database', () => ({
  FeedbackModel: FeedbackModelMock,
  User: { findOne: vi.fn().mockReturnValue({ populate: vi.fn().mockResolvedValue(null) }) },
  adminSettingsRepository: {},
}));

const mockLogEvent = vi.fn().mockResolvedValue(undefined);
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: (...args: unknown[]) => mockLogEvent(...args) }));

vi.mock('@server/integrations/slack/slack', () => ({ postFeedbackToSlack: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@server/utils/eventBus', () => ({ EmailEvents: { Send: { publish: vi.fn().mockResolvedValue(undefined) } } }));
vi.mock('@bike4mind/utils', () => ({
  getSettingsMap: vi.fn().mockResolvedValue({}),
  getSettingsValue: vi.fn(() => false),
}));

import '../index';

describe('POST /api/feedback - logs the authenticated caller, not the request body', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('logs req.user.id even when the body carries a non-ObjectId placeholder userId', async () => {
    const { req, res } = createMocks({
      method: 'POST',
      body: {
        userId: 'Unknown',
        content: 'Coming soon signup',
        tags: ['comingSoon', 'marketing'],
        username: 'tester@example.com',
        userEmail: 'tester@example.com',
      },
    });
    (req as unknown as { isAuthenticated: () => boolean }).isAuthenticated = () => true;
    (req as unknown as { user: { id: string; username: string; email: string } }).user = {
      id: 'real-user-id',
      username: 'real-user',
      email: 'real-user@example.com',
    };

    await mockRefs.postHandler!(req, res);

    expect(mockLogEvent).toHaveBeenCalledTimes(1);
    const [event] = mockLogEvent.mock.calls[0];
    expect(event.userId).toBe('real-user-id');
    expect(event.userId).not.toBe('Unknown');
  });
});
