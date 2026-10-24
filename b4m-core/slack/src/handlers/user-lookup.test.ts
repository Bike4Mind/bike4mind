import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockFindOne } = vi.hoisted(() => ({ mockFindOne: vi.fn() }));

vi.mock('../di/registry', () => ({ getSlackDb: () => ({ User: { findOne: mockFindOne } }) }));
vi.mock('@bike4mind/observability', () => ({
  Logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { VERIFIED_SLACK_IDENTITY_FILTER } from '@bike4mind/common';
import { findUserBySlackId } from './user-lookup';

beforeEach(() => {
  vi.clearAllMocks();
  mockFindOne.mockReturnValue({ maxTimeMS: () => Promise.resolve(null) });
});

describe('findUserBySlackId', () => {
  it('only matches a link bound to a verified workspace', async () => {
    await findUserBySlackId('U1');

    expect(mockFindOne).toHaveBeenCalledWith({
      'slackSettings.slackUserId': 'U1',
      ...VERIFIED_SLACK_IDENTITY_FILTER,
    });
  });
});
