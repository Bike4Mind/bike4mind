import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  extractAndSaveEntitiesFromUserMessage,
  getConversationContextSystemMessage,
} from '../../conversationContextService';
import { ToolBuilder, type ToolBuilderConfig } from './ToolBuilder';

vi.mock('../../conversationContextService', () => ({
  extractAndSaveEntitiesFromUserMessage: vi.fn(),
  getConversationContextSystemMessage: vi.fn(),
}));

const makeBuilder = (): ToolBuilder =>
  new ToolBuilder({
    user: { id: 'user-1' },
    db: { sessions: {} },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), updateMetadata: vi.fn() },
    storage: {},
    imageGenerateStorage: {},
    toolCreditsMap: new Map(),
    subagentTelemetryData: [],
    sendStatusUpdate: vi.fn(),
  } as unknown as ToolBuilderConfig);

describe('buildToolPrompt conversation context', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  const build = () =>
    makeBuilder().buildToolPrompt({
      hasContentTransform: false,
      hasChessEngine: false,
      hasCurrentDateTime: false,
      hasWebSearch: false,
      hasKnowledgeBase: false,
      mcpTools: [],
      sessionId: 'session-1',
      message: 'review that PR',
      logger: logger as never,
      processStartTime: Date.now(),
      extraContextMessages: [],
    });

  it('includes conversation context even when no MCP tools are offered', async () => {
    vi.mocked(extractAndSaveEntitiesFromUserMessage).mockResolvedValue(undefined);
    vi.mocked(getConversationContextSystemMessage).mockResolvedValue({
      role: 'system',
      content: 'The referenced PR is Bike4Mind/bike4mind#2981.',
    });

    const prompt = await build();

    expect(extractAndSaveEntitiesFromUserMessage).toHaveBeenCalledWith('session-1', 'review that PR', {});
    expect(prompt?.content).toContain('Bike4Mind/bike4mind#2981');
  });

  it('keeps prompt construction non-fatal when conversation context persistence fails', async () => {
    const failure = new Error('session store unavailable');
    vi.mocked(extractAndSaveEntitiesFromUserMessage).mockRejectedValue(failure);

    await expect(build()).resolves.toBeNull();
    expect(logger.debug).toHaveBeenCalledWith('[ConversationContext] Failed to add context:', failure);
  });
});
