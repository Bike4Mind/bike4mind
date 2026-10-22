/**
 * The job tools (video_generation, music_generation) are inert without a usable config, so
 * buildSharedTools is the only thing keeping them away from the LLM. Build-only stubs, as in sharedToolBuilder.mcpNarrowing.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import { Logger } from '@bike4mind/observability';
import type { ICompletionBackend } from '@bike4mind/llm-adapters';
import type { IUserDocument } from '@bike4mind/common';
import { buildSharedTools, type ToolBuilderDeps, type ToolBuilderCallbacks } from './sharedToolBuilder';
import { resolveToolConfigSafely } from './resolveToolConfigSafely';

vi.mock('@bike4mind/llm-adapters', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/llm-adapters')>()),
  getLlmByModel: vi.fn(() => ({ complete: vi.fn(), currentModel: '' })),
}));

const rejectIfExecuted = (surface: string) => () => {
  throw new Error(`${surface} was called - these tests are build-only and must never execute a tool.`);
};

const fakeStorage = {
  upload: rejectIfExecuted('storage.upload'),
  getSignedUrl: rejectIfExecuted('storage.getSignedUrl'),
  getPublicUrl: rejectIfExecuted('storage.getPublicUrl'),
} as unknown as ToolBuilderDeps['storage'];

const deps: ToolBuilderDeps = {
  userId: 'test-user',
  user: { _id: 'test-user', id: 'test-user' } as unknown as IUserDocument,
  logger: new Logger(),
  db: {
    apiKeys: {
      findByUserIdAndType: rejectIfExecuted('db.apiKeys.findByUserIdAndType'),
      findByUserIdAndTypes: rejectIfExecuted('db.apiKeys.findByUserIdAndTypes'),
    },
    adminSettings: {
      findBySettingName: rejectIfExecuted('db.adminSettings.findBySettingName'),
      findBySettingNames: rejectIfExecuted('db.adminSettings.findBySettingNames'),
      findAll: rejectIfExecuted('db.adminSettings.findAll'),
    },
  } as unknown as ToolBuilderDeps['db'],
  storage: fakeStorage,
  imageGenerateStorage: fakeStorage,
  llm: { complete: rejectIfExecuted('llm.complete') } as unknown as ICompletionBackend,
};

const callbacks: ToolBuilderCallbacks = {
  onStatusUpdate: async () => {},
  onToolStart: async () => {},
  onToolFinish: async () => {},
};

const JOB_TOOLS = [
  { tool: 'video_generation', validConfig: { usableModels: ['test-video'], createJob: vi.fn() } },
  { tool: 'music_generation', validConfig: { usableModels: ['test-music'], createJob: vi.fn() } },
] as const;

describe.each(JOB_TOOLS)('buildSharedTools: $tool gate', ({ tool, validConfig }) => {
  const offered = (options: Parameters<typeof buildSharedTools>[2]) =>
    (buildSharedTools(deps, callbacks, { enabledTools: [tool], ...options }) ?? []).map(built => built.toolSchema.name);

  it('offers the tool with a populated config', () => {
    expect(offered({ config: { [tool]: validConfig } })).toContain(tool);
  });

  it('does not offer the tool without a config', () => {
    expect(offered({})).not.toContain(tool);
  });

  it('does not offer the tool when the usable model list is empty', () => {
    expect(offered({ config: { [tool]: { ...validConfig, usableModels: [] } } })).not.toContain(tool);
  });

  it('does not offer the tool when availability claims true but no config is passed', () => {
    expect(offered({ toolAvailability: { [tool]: true } })).not.toContain(tool);
  });

  it('does not offer the tool when the capability resolver throws', async () => {
    const resolved = await resolveToolConfigSafely(
      tool,
      async () => {
        throw new Error('db down');
      },
      { warn: vi.fn() } as never
    );
    expect(offered({ config: { [tool]: resolved ?? undefined } })).not.toContain(tool);
  });
});
