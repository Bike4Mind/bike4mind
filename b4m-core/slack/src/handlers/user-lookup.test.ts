import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockFindOne } = vi.hoisted(() => ({ mockFindOne: vi.fn() }));

vi.mock('../di/registry', () => ({ getSlackDb: () => ({ User: { findOne: mockFindOne } }) }));
vi.mock('@bike4mind/observability', () => ({
  Logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { findUserBySlackId } from './user-lookup';

beforeEach(() => {
  vi.clearAllMocks();
  mockFindOne.mockReturnValue({ maxTimeMS: () => Promise.resolve(null) });
});

describe('findUserBySlackId', () => {
  it('only matches a link bound to the request workspace', async () => {
    await findUserBySlackId('U1', 'T1');

    expect(mockFindOne).toHaveBeenCalledWith({
      'slackSettings.slackUserId': 'U1',
      'slackSettings.slackTeamId': 'T1',
    });
  });

  it('resolves nobody when the request carries no team', async () => {
    expect(await findUserBySlackId('U1', undefined)).toBeNull();
    expect(mockFindOne).not.toHaveBeenCalled();
  });
});
