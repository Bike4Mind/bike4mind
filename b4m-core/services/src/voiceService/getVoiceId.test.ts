import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import { getVoiceId } from './getVoiceId';

describe('voiceService - getVoiceId', () => {
  let mockAdapters: { db: { voices: { findActiveByUserId: Mock } } };

  beforeEach(() => {
    vi.clearAllMocks();
    mockAdapters = { db: { voices: { findActiveByUserId: vi.fn() } } };
  });

  it('returns the active voiceId for the user', async () => {
    mockAdapters.db.voices.findActiveByUserId.mockResolvedValue({ voiceId: 'voice-123' });

    const result = await getVoiceId('user-1', mockAdapters as any);

    expect(mockAdapters.db.voices.findActiveByUserId).toHaveBeenCalledWith('user-1');
    expect(result).toBe('voice-123');
  });

  it('returns null when the user has no active voice', async () => {
    mockAdapters.db.voices.findActiveByUserId.mockResolvedValue(null);

    const result = await getVoiceId('user-1', mockAdapters as any);

    expect(result).toBeNull();
  });
});
