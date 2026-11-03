import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockExpirePreviousKey = vi.fn().mockResolvedValue(undefined);
const mockFind = vi.fn().mockResolvedValue([]);

vi.mock('@bike4mind/database', () => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
  adminSettingsRepository: {},
}));

vi.mock('@bike4mind/database/infra', () => ({
  secretRotationRepository: {
    expirePreviousKey: (...args: unknown[]) => mockExpirePreviousKey(...args),
    find: (...args: unknown[]) => mockFind(...args),
  },
}));

vi.mock('@bike4mind/utils', () => ({
  postMessageToSlack: vi.fn(),
  getSettingsMap: vi.fn().mockResolvedValue({}),
}));

vi.mock('@bike4mind/server-utils/integrations/slack/slack', () => ({
  resolveSlackWebhookUrl: vi.fn().mockReturnValue(''),
}));

vi.mock('@bike4mind/server-utils/utils/config', () => ({
  Config: { MONGODB_URI: 'mongodb://localhost:27017/%STAGE%' },
}));

vi.mock('@bike4mind/server-utils/lib/secretRotation/constants', () => ({
  getSecretRotationConfig: () => ({}),
}));

vi.mock('sst', () => ({
  Resource: { App: { stage: 'dev' } },
}));

import { handler } from './secretRotationNotifier';

describe('secretRotationNotifier', () => {
  beforeEach(() => {
    mockExpirePreviousKey.mockClear();
    mockFind.mockClear();
  });

  it('retires a rotated-out JWT secret once its grace window has closed', async () => {
    await handler();

    expect(mockExpirePreviousKey).toHaveBeenCalledWith('JWT_SECRET', 24 * 60 * 60 * 1000);
  });
});
