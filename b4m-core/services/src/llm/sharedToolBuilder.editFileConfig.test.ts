import { describe, it, expect, vi } from 'vitest';
import { Logger } from '@bike4mind/observability';
import type { ICompletionBackend } from '@bike4mind/llm-adapters';
import type { IUserDocument } from '@bike4mind/common';
import { buildSharedTools, type ToolBuilderDeps, type ToolBuilderCallbacks } from './sharedToolBuilder';
import { editFileTool } from './tools/implementation/editFile';

vi.mock('@bike4mind/llm-adapters', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/llm-adapters')>()),
  getLlmByModel: vi.fn(() => ({ complete: vi.fn(), currentModel: '' })),
}));

const fakeStorage = {
  upload: vi.fn(),
  getSignedUrl: vi.fn(),
  getPublicUrl: vi.fn(),
} as unknown as ToolBuilderDeps['storage'];

const deps: ToolBuilderDeps = {
  userId: 'test-user',
  user: { _id: 'test-user', id: 'test-user' } as unknown as IUserDocument,
  logger: new Logger(),
  db: {} as ToolBuilderDeps['db'],
  storage: fakeStorage,
  imageGenerateStorage: fakeStorage,
  llm: { complete: vi.fn(), currentModel: 'test-model' } as unknown as ICompletionBackend,
  model: 'test-model',
  authOrigin: 'session',
};

const callbacks: ToolBuilderCallbacks = {
  onStatusUpdate: async () => {},
  onToolStart: async () => {},
  onToolFinish: async () => {},
};

describe('buildSharedTools: edit_file config', () => {
  it('forwards the configured execution model to the edit_file generator', () => {
    const implementation = vi.spyOn(editFileTool, 'implementation');
    try {
      buildSharedTools(deps, callbacks, {
        enabledTools: ['edit_file'],
        config: { edit_file: { model: 'restricted-model' } },
      });
      expect(implementation).toHaveBeenCalledWith(expect.anything(), { model: 'restricted-model' });
    } finally {
      implementation.mockRestore();
    }
  });
});
