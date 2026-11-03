import type { Logger } from '@bike4mind/observability';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getSettingsMap = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  getSettingsMap,
}));

const runWithProviderCapacity = vi.hoisted(() => vi.fn());
vi.mock('./runWithProviderCapacity', async importOriginal => ({
  ...(await importOriginal<typeof import('./runWithProviderCapacity')>()),
  runWithProviderCapacity,
}));

import { runElevenLabsWithCapacity } from './runElevenLabsWithCapacity';

const logger = { warn: vi.fn() } as unknown as Logger;
const caches = { tryAcquireLease: vi.fn(), releaseLease: vi.fn() };
const adminSettings = { findAll: vi.fn(), findBySettingNames: vi.fn() };
const attempt = vi.fn();

describe('runElevenLabsWithCapacity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runWithProviderCapacity.mockResolvedValue('audio');
  });

  it('slots a call on the server key under the configured music limit', async () => {
    getSettingsMap.mockResolvedValue({ elevenLabsServerApiKey: 'server-key', elevenLabsMusicConcurrencyLimit: '4' });

    await runElevenLabsWithCapacity(
      { operation: 'music', apiKey: 'server-key', db: { adminSettings, caches }, logger },
      attempt
    );

    expect(getSettingsMap).toHaveBeenCalledWith(
      { adminSettings, caches },
      { names: ['elevenLabsServerApiKey', 'elevenLabsMusicConcurrencyLimit'], skipCache: true }
    );
    expect(runWithProviderCapacity).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'elevenlabs',
        slots: { store: caches, key: 'provider-slots:elevenlabs:music', limit: 4 },
      }),
      attempt
    );
  });

  it('falls back to the plan-default limit when the setting is unset', async () => {
    getSettingsMap.mockResolvedValue({ elevenLabsServerApiKey: 'server-key' });

    await runElevenLabsWithCapacity(
      { operation: 'sound', apiKey: 'server-key', db: { adminSettings, caches }, logger },
      attempt
    );

    expect(runWithProviderCapacity.mock.calls[0][0].slots).toEqual({
      store: caches,
      key: 'provider-slots:elevenlabs:sound',
      limit: 5,
    });
  });

  it("does not count a user's own key against the shared slots", async () => {
    getSettingsMap.mockResolvedValue({ elevenLabsServerApiKey: 'server-key' });

    await runElevenLabsWithCapacity(
      { operation: 'music', apiKey: 'personal-key', db: { adminSettings, caches }, logger },
      attempt
    );

    expect(runWithProviderCapacity.mock.calls[0][0].slots).toBeUndefined();
  });

  it('runs unslotted when no server key is configured', async () => {
    getSettingsMap.mockResolvedValue({ elevenLabsServerApiKey: '' });

    await runElevenLabsWithCapacity({ operation: 'music', apiKey: '', db: { adminSettings, caches }, logger }, attempt);

    expect(runWithProviderCapacity.mock.calls[0][0].slots).toBeUndefined();
  });

  it('runs unslotted on a host that wires no slot store', async () => {
    getSettingsMap.mockResolvedValue({ elevenLabsServerApiKey: 'server-key' });

    await runElevenLabsWithCapacity(
      { operation: 'music', apiKey: 'server-key', db: { adminSettings }, logger },
      attempt
    );

    expect(runWithProviderCapacity.mock.calls[0][0].slots).toBeUndefined();
  });
});
