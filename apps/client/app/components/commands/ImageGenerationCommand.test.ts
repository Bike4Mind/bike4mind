import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueryClient } from '@tanstack/react-query';

const mockPost = vi.fn();
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { post: (...a: unknown[]) => mockPost(...a) } }));
vi.mock('@client/app/utils/llm', () => ({
  createOptimisticQuest: (_qc: unknown, _id: unknown, _prompt: unknown, cb: () => Promise<unknown>) => cb(),
  updateOptimisticQuest: (_qc: unknown, _id: unknown, _sid: unknown, _q: unknown, cb: () => Promise<unknown>) => cb(),
  createOptimisticSessionId: () => 'tmp-session',
}));
vi.mock('@client/app/hooks/data/useModelInfo', () => ({ getCachedModels: () => [] }));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
vi.mock('@bike4mind/database/infra', () => ({ organizationRepository: {} }));
vi.mock('@server/utils/resolveActiveOrg', () => ({ resolveActiveOrg: vi.fn() }));

import { assertNoStrayBillingOrgKeys } from '@server/utils/orgAccess';
import { handleImageEditCommand, handleImageGenerationCommand } from './ImageGenerationCommand';

// The commands forward every arg they do not destructure (`...rest`) to the public image routes,
// which 422 any billing-shaped key. These stand in for the LLM settings the chat send path adds.
const baseArgs = (extra: Record<string, unknown> = {}) =>
  ({
    params: 'a lighthouse',
    currentSession: { id: 'sess-1' },
    workBenchFiles: [],
    queryClient: {} as QueryClient,
    model: 'gpt-image-1',
    tools: [],
    organizationId: 'org-1',
    temperature: 0.7,
    top_p: 1,
    max_tokens: 1024,
    stream: true,
    thinking: { enabled: false },
    size: '1024x1024',
    quality: 'high',
    ...extra,
  }) as never;

const postedBody = () => mockPost.mock.calls[0][1] as Record<string, unknown>;

describe.each([
  ['handleImageGenerationCommand', handleImageGenerationCommand, '/api/ai/generate-image'],
  ['handleImageEditCommand', handleImageEditCommand, '/api/ai/edit-image'],
])('%s request body vs the stray billing-key guard', (_name, handler, url) => {
  beforeEach(() => {
    mockPost.mockReset();
    mockPost.mockResolvedValue({ data: { session: {}, quest: {} } });
  });

  it('posts a body the guard accepts', async () => {
    await handler(baseArgs());
    expect(mockPost.mock.calls[0][0]).toBe(url);
    expect(postedBody()).toHaveProperty('organizationId', 'org-1');
    expect(() => assertNoStrayBillingOrgKeys(postedBody())).not.toThrow();
  });

  it('a new command arg containing "org" (colorGrade) would be rejected - the guard is live over this body', async () => {
    await handler(baseArgs({ colorGrade: 'warm' }));
    expect(() => assertNoStrayBillingOrgKeys(postedBody())).toThrow(/colorGrade/);
  });
});
