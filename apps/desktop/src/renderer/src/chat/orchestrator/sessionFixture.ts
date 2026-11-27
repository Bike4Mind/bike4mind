import type { ChatSessionSummary } from '@shared/chat';

/** A listed session; `parentId` makes it an agent of that session. */
export const sessionFixture = (
  id: string,
  parentId?: string,
  overrides: Partial<ChatSessionSummary> = {}
): ChatSessionSummary => ({
  id,
  title: `Title ${id}`,
  model: 'm',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  mode: 'code',
  approvalMode: 'ask',
  reasoningEffort: 'medium',
  messageCount: 1,
  ...(parentId ? { origin: { parentSessionId: parentId, depth: 1, seedPrompt: `seed ${id}` } } : {}),
  ...overrides,
});
