import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock SST Resource
const mockResource = vi.hoisted(() => ({
  MONGODB_URI: { value: 'mongodb+srv://user:pass@cluster.mongodb.net/%STAGE%' },
  App: { stage: 'pr123' },
}));

vi.mock('sst', () => ({ Resource: mockResource }));

// Mock MongoClient
const mockDrop = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockDropDatabase = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockCollections = vi.hoisted(() =>
  vi.fn().mockResolvedValue([
    { collectionName: 'users', drop: mockDrop },
    { collectionName: 'quests', drop: mockDrop },
  ])
);
const mockClose = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockDb = vi.hoisted(() =>
  vi.fn(() => ({
    collections: mockCollections,
    dropDatabase: mockDropDatabase,
  }))
);
const mockConnect = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('mongodb', () => ({
  MongoClient: vi.fn().mockImplementation(function () {
    return {
      connect: mockConnect,
      db: mockDb,
      close: mockClose,
    };
  }),
}));

describe('dropPreviewDatabase handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
    mockResource.MONGODB_URI.value = 'mongodb+srv://user:pass@cluster.mongodb.net/%STAGE%';
    mockResource.App.stage = 'pr123';
  });

  it('refuses to drop non-preview stage', async () => {
    const { handler } = await import('./dropPreviewDatabase');
    const result = await handler({ action: 'cleanup', stage: 'dev' });
    expect(result.statusCode).toBe(400);
    expect(result.error).toContain('non-preview');
  });

  it('refuses to drop production stage', async () => {
    const { handler } = await import('./dropPreviewDatabase');
    const result = await handler({ action: 'cleanup', stage: 'production' });
    expect(result.statusCode).toBe(400);
  });

  it('refuses if MONGODB_URI has no %STAGE% placeholder', async () => {
    mockResource.MONGODB_URI.value = 'mongodb+srv://user:pass@cluster.mongodb.net/hardcoded';
    const { handler } = await import('./dropPreviewDatabase');
    const result = await handler({ action: 'cleanup', stage: 'pr456' });
    expect(result.statusCode).toBe(400);
    expect(result.error).toContain('%STAGE%');
  });

  it('drops all collections and database for valid pr stage', async () => {
    const { MongoClient } = await import('mongodb');
    const { handler } = await import('./dropPreviewDatabase');
    const result = await handler({ action: 'cleanup', stage: 'pr789' });

    expect(result.statusCode).toBe(200);
    expect(MongoClient).toHaveBeenCalledWith('mongodb+srv://user:pass@cluster.mongodb.net/pr789', expect.anything());
    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(mockDrop).toHaveBeenCalledTimes(2);
    expect(mockDropDatabase).toHaveBeenCalledTimes(1);
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it('falls back to Resource.App.stage when event.stage is empty', async () => {
    mockResource.App.stage = 'pr999';
    const { handler } = await import('./dropPreviewDatabase');
    const result = await handler({ action: 'cleanup', stage: '' });
    expect(result.statusCode).toBe(200);
    expect(result.message).toContain('pr999');
  });

  it('returns 500 and closes client when connect throws', async () => {
    mockConnect.mockRejectedValueOnce(new Error('Connection refused'));
    const { handler } = await import('./dropPreviewDatabase');
    const result = await handler({ action: 'cleanup', stage: 'pr100' });
    expect(result.statusCode).toBe(500);
    expect(result.error).toBe('Connection refused');
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it('returns 500 when collection.drop throws', async () => {
    mockDrop.mockRejectedValueOnce(new Error('drop failed'));
    const { handler } = await import('./dropPreviewDatabase');
    const result = await handler({ action: 'cleanup', stage: 'pr200' });
    expect(result.statusCode).toBe(500);
    expect(result.error).toBe('drop failed');
    expect(mockClose).toHaveBeenCalledTimes(1);
  });
});
