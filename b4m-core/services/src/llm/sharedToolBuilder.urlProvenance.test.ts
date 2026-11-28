import { describe, expect, it } from 'vitest';
import { Logger } from '@bike4mind/observability';
import type { ICompletionBackend, ICompletionOptionTools } from '@bike4mind/llm-adapters';
import type { IUserDocument } from '@bike4mind/common';
import { buildSharedTools, type ToolBuilderCallbacks, type ToolBuilderDeps } from './sharedToolBuilder';
import { UrlProvenance } from './tools/base/urlProvenance';

const rejectIfExecuted = (surface: string) => () => {
  throw new Error(`${surface} was called unexpectedly`);
};

const fakeStorage = {
  upload: rejectIfExecuted('storage.upload'),
  getSignedUrl: rejectIfExecuted('storage.getSignedUrl'),
  getPublicUrl: rejectIfExecuted('storage.getPublicUrl'),
} as unknown as ToolBuilderDeps['storage'];

const callbacks: ToolBuilderCallbacks = {
  onStatusUpdate: async () => {},
  onToolStart: async () => {},
  onToolFinish: async () => {},
};

function buildWith(urlProvenance: UrlProvenance) {
  const searchTool: ICompletionOptionTools = {
    toolFn: async () => 'Found https://docs.test/page for https://echo.test/q',
    toolSchema: { name: 'acme__search', description: 'search', parameters: { type: 'object', properties: {} } },
    _isMcpTool: true,
  };
  const deps: ToolBuilderDeps = {
    urlProvenance,
    userId: 'test-user',
    user: { _id: 'test-user', id: 'test-user' } as unknown as IUserDocument,
    logger: new Logger(),
    db: {} as unknown as ToolBuilderDeps['db'],
    storage: fakeStorage,
    imageGenerateStorage: fakeStorage,
    llm: { complete: rejectIfExecuted('llm.complete') } as unknown as ICompletionBackend,
  };
  return buildSharedTools(deps, callbacks, { mcpToolsByServer: { acme: [{ name: 'acme__search', ...searchTool }] } });
}

describe('buildSharedTools URL provenance', () => {
  it('records each tool result into the turn registry, minus the URLs the call passed in', async () => {
    const provenance = new UrlProvenance();
    const tool = buildWith(provenance)?.find(t => t.toolSchema.name === 'acme__search');

    await tool!.toolFn({ query: 'https://echo.test/q' });

    expect(provenance.allows('https://docs.test/page')).toBe(true);
    expect(provenance.allows('https://echo.test/q')).toBe(false);
  });
});
