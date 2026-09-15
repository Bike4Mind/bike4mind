import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies using vi.hoisted
const { mockAdminSettings, mockLogger } = vi.hoisted(() => ({
  mockAdminSettings: {
    findOne: vi.fn(),
    findOneAndUpdate: vi.fn(),
    create: vi.fn(),
  },
  mockLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock database
vi.mock('@bike4mind/database', () => ({
  AdminSettings: mockAdminSettings,
}));

// Mock Logger
vi.mock('@bike4mind/observability', () => ({
  Logger: vi.fn(function () {
    return mockLogger;
  }),
}));

// Use real @bike4mind/common so Zod schema validation is exercised
// (no mock needed - we want actual schema enforcement)

import { WhatsNewConfigService } from './whatsNewConfigService';
import { WHATS_NEW_VALIDATION_LIMITS } from '@bike4mind/common';

// Helper to create a valid config object
function createValidConfig(overrides: Record<string, unknown> = {}) {
  return {
    modelId: 'gpt-4o-mini',
    temperature: 0.7,
    maxTokens: 2000,
    timeoutMs: 120000,
    modalPriority: 10,
    modalExpiryDays: 30,
    maxPreviousModals: 10,
    titleMaxLength: 100,
    subtitleMaxLength: 200,
    descriptionMaxLength: 2000,
    maxCommits: 50,
    maxPullRequests: 20,
    maxReleaseBodyLength: 2000,
    maxCommitMessageLength: 200,
    maxPRBodyLength: 500,
    maxChangelogLength: 1000,
    ...overrides,
  };
}

// Helper to mock AdminSettings.findOne with lean/exec chain
function mockFindOne(result: unknown) {
  mockAdminSettings.findOne.mockReturnValue({
    lean: vi.fn().mockReturnValue({
      exec: vi.fn().mockResolvedValue(result),
    }),
  });
}

describe('WhatsNewConfigService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('clampStoredConfig (via getConfig)', () => {
    it('should clamp timeoutMs from old max (600000) to new max', async () => {
      const config = createValidConfig({ timeoutMs: 600000 });
      mockFindOne({ settingName: 'whatsNewConfig', settingValue: config });

      const result = await WhatsNewConfigService.getConfig();

      expect(result.timeoutMs).toBe(WHATS_NEW_VALIDATION_LIMITS.timeoutMs.max);
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('Clamping timeoutMs from 600000ms'));
    });

    it('should clamp mid-range over-max value (300000)', async () => {
      const config = createValidConfig({ timeoutMs: 300000 });
      mockFindOne({ settingName: 'whatsNewConfig', settingValue: config });

      const result = await WhatsNewConfigService.getConfig();

      expect(result.timeoutMs).toBe(WHATS_NEW_VALIDATION_LIMITS.timeoutMs.max);
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('Clamping timeoutMs from 300000ms'));
    });

    it('should pass through value at exact new max (180000)', async () => {
      const config = createValidConfig({ timeoutMs: 180000 });
      mockFindOne({ settingName: 'whatsNewConfig', settingValue: config });

      const result = await WhatsNewConfigService.getConfig();

      expect(result.timeoutMs).toBe(180000);
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('should pass through value within range (120000)', async () => {
      const config = createValidConfig({ timeoutMs: 120000 });
      mockFindOne({ settingName: 'whatsNewConfig', settingValue: config });

      const result = await WhatsNewConfigService.getConfig();

      expect(result.timeoutMs).toBe(120000);
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('should handle missing timeoutMs (Zod applies default)', async () => {
      const config = createValidConfig();
      delete (config as Record<string, unknown>).timeoutMs;
      mockFindOne({ settingName: 'whatsNewConfig', settingValue: config });

      const result = await WhatsNewConfigService.getConfig();

      expect(result.timeoutMs).toBe(WHATS_NEW_VALIDATION_LIMITS.timeoutMs.default);
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('should return defaults when no record exists', async () => {
      mockFindOne(null);

      const result = await WhatsNewConfigService.getConfig();

      expect(result.timeoutMs).toBe(120000);
      expect(result.modelId).toBe('gpt-4o-mini');
      expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('not found, using defaults'));
    });

    it('should return defaults on parse error', async () => {
      // Use a value that violates Zod type constraints (string where number expected)
      mockFindOne({ settingName: 'whatsNewConfig', settingValue: { temperature: 'not-a-number' } });

      const result = await WhatsNewConfigService.getConfig();

      expect(result.timeoutMs).toBe(120000);
      expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('Invalid'), expect.anything());
    });
  });

  describe('getCurrentConfig clamping', () => {
    it('should clamp timeoutMs from old max', async () => {
      const config = createValidConfig({ timeoutMs: 600000 });
      mockFindOne({ settingName: 'whatsNewConfig', settingValue: config });

      const result = await WhatsNewConfigService.getCurrentConfig();

      expect(result).not.toBeNull();
      expect(result!.timeoutMs).toBe(WHATS_NEW_VALIDATION_LIMITS.timeoutMs.max);
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('Clamping timeoutMs'));
    });

    it('should return null when no record exists', async () => {
      mockFindOne(null);

      const result = await WhatsNewConfigService.getCurrentConfig();

      expect(result).toBeNull();
    });
  });

  describe('getConfigHistory clamping', () => {
    it('should clamp timeoutMs in history entries for display', async () => {
      const historyEntries = [
        {
          config: createValidConfig({ timeoutMs: 600000 }),
          metadata: { userId: 'user1', username: 'admin', timestamp: new Date() },
        },
        {
          config: createValidConfig({ timeoutMs: 120000 }),
          metadata: { userId: 'user2', username: 'admin2', timestamp: new Date() },
        },
      ];

      mockFindOne({ settingName: 'whatsNewConfigHistory', settingValue: historyEntries });

      const result = await WhatsNewConfigService.getConfigHistory();

      expect(result).toHaveLength(2);
      expect(result[0].config.timeoutMs).toBe(WHATS_NEW_VALIDATION_LIMITS.timeoutMs.max);
      expect(result[1].config.timeoutMs).toBe(120000);
    });

    it('should return empty array when no history exists', async () => {
      mockFindOne(null);

      const result = await WhatsNewConfigService.getConfigHistory();

      expect(result).toEqual([]);
    });
  });

  describe('restoreFromHistory clamping', () => {
    it('should clamp timeoutMs when restoring from history', async () => {
      const historyEntries = [
        {
          config: createValidConfig({ timeoutMs: 600000 }),
          metadata: { userId: 'user1', username: 'admin', timestamp: new Date() },
        },
      ];

      // First call: getConfigHistory (lean/exec chain)
      // Second call: getCurrentConfig (lean/exec chain)
      // Third call: saveToHistory (raw findOne, no lean)
      let callCount = 0;
      mockAdminSettings.findOne.mockImplementation(() => {
        callCount++;
        if (callCount <= 2) {
          // getConfigHistory and getCurrentConfig use lean/exec
          return {
            lean: vi.fn().mockReturnValue({
              exec: vi
                .fn()
                .mockResolvedValue(
                  callCount === 1
                    ? { settingName: 'whatsNewConfigHistory', settingValue: historyEntries }
                    : { settingName: 'whatsNewConfig', settingValue: createValidConfig({ timeoutMs: 600000 }) }
                ),
            }),
          };
        }
        // saveToHistory uses findOne without lean
        return Promise.resolve({
          settingName: 'whatsNewConfigHistory',
          settingValue: historyEntries,
        });
      });
      mockAdminSettings.findOneAndUpdate.mockResolvedValue({});

      const result = await WhatsNewConfigService.restoreFromHistory(0, 'user1', 'admin');

      expect(result.timeoutMs).toBe(WHATS_NEW_VALIDATION_LIMITS.timeoutMs.max);
    });

    it('should throw on invalid history index', async () => {
      mockFindOne({ settingName: 'whatsNewConfigHistory', settingValue: [] });

      await expect(WhatsNewConfigService.restoreFromHistory(5, 'user1', 'admin')).rejects.toThrow(
        'Failed to restore configuration from history'
      );
    });
  });
});
