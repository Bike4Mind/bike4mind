import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { createMocks } from 'node-mocks-http';

const effects = vi.hoisted(() => ({
  config: vi.fn(),
  history: vi.fn(),
  seed: vi.fn(),
  snapshots: vi.fn(),
  queue: vi.fn(),
  model: vi.fn(),
  embedding: vi.fn(),
}));
vi.mock('./baseApi', () => ({
  baseApi: () => {
    const guards: ((req: Request, res: Response, next: () => void) => unknown)[] = [];
    let endpoint: (req: Request, res: Response) => unknown;
    const chain = async (req: Request, res: Response) => {
      for (const guard of guards) await guard(req, res, () => {});
      return endpoint(req, res);
    };
    chain.use = (guard: (typeof guards)[number]) => {
      guards.push(guard);
      return chain;
    };
    chain.get = (handler: typeof endpoint) => {
      endpoint = handler;
      return chain;
    };
    return chain;
  },
}));
vi.mock('@bike4mind/database', () => ({
  liveopsTriageConfigRepository: { findById: effects.config },
  apiKeyRepository: {},
  adminSettingsRepository: {},
  systemPromptRepository: { findByPromptId: effects.history },
  systemPromptHistoryRepository: { getVersions: effects.history, saveVersion: effects.seed },
  securityDashboardSnapshotRepository: { findLatestByStage: effects.snapshots },
  cacheRepository: {},
}));
vi.mock('@bike4mind/services', () => ({ apiKeyService: {}, cacheService: {} }));
vi.mock('@server/services/githubService', () => ({ GitHubService: vi.fn() }));
vi.mock('@bike4mind/slack', () => ({ SlackClient: vi.fn() }));
vi.mock('@server/services/liveopsTriageService', () => ({ sanitizeErrorMessage: vi.fn(), REQUIRED_GITHUB_LABELS: [] }));
vi.mock('@server/services/issueTrackers/jiraIssueTracker', () => ({ JiraIssueTracker: vi.fn() }));
vi.mock('@server/services/liveopsConnectionResolver', () => ({
  resolveJiraConfig: vi.fn(),
  resolveSlackBotToken: vi.fn(),
}));
vi.mock('@server/utils/systemPrompts/defaults', () => ({ getDefaultSystemPrompts: vi.fn() }));
vi.mock('@client/services/operationsModelService', () => ({ OperationsModelService: effects.model }));
vi.mock('@bike4mind/auth/apiKeyService', () => ({ envKey: {} }));
vi.mock('@bike4mind/fab-pipeline', () => ({
  getProviderFromModel: vi.fn(),
  resolveEmbeddingConfig: effects.embedding,
}));
vi.mock('@server/utils/resolveDefaultEmbeddingModel', () => ({ resolveDefaultEmbeddingModel: vi.fn() }));
vi.mock('@bike4mind/server-utils/utils/dlqRegistry', () => ({ getDlqByLabel: vi.fn(), getDlqUrl: vi.fn() }));
vi.mock('@bike4mind/server-utils/utils/sqs', () => ({ receiveFromQueue: effects.queue }));

import health from '../../pages/api/admin/liveops-triage-configs/[id]/health';
import history from '../../pages/api/admin/system-prompts/[promptId]/history';
import assessment from '../../pages/api/admin/security-dashboard/ai-assessment';
import embedding from '../../pages/api/admin/embedding-limits';
import queue from '../../pages/api/admin/dlq/messages';

beforeEach(() => vi.clearAllMocks());
describe('GET routes with administrative side effects', () => {
  it.each([
    ['GitHub label creation', health],
    ['lazy prompt history migration', history],
    ['LLM assessment spend', assessment],
    ['embedding provider spend', embedding],
    ['queue visibility mutation', queue],
  ])('support cannot trigger %s', async (_name, handler) => {
    const { req, res } = createMocks<Request, Response>({ method: 'GET' });
    req.user = { id: 'support', isAdmin: false, adminPermissions: ['support:read'] } as Request['user'];
    await expect((handler as unknown as (req: Request, res: Response) => Promise<unknown>)(req, res)).rejects.toThrow(
      'Missing permission: settings:manage'
    );
    for (const collaborator of Object.values(effects)) expect(collaborator).not.toHaveBeenCalled();
  });
});
