import { createHash } from 'node:crypto';
import { CreditHolderType, insufficientCreditsError, isZodError } from '@bike4mind/common';
import { createMocks } from 'node-mocks-http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveKey, registeredModels, providerSpy, loadFile, download, recordUsage, reserve, refund, settle } =
  vi.hoisted(() => ({
    resolveKey: vi.fn(),
    registeredModels: { value: ['test-decisions', 'gpt-6-luna'] as string[] },
    providerSpy: vi.fn(),
    loadFile: vi.fn(),
    download: vi.fn(),
    recordUsage: vi.fn(),
    reserve: vi.fn(),
    refund: vi.fn(),
    settle: vi.fn(),
  }));

// Contract-adapter mock, as in embeddings.test.ts: runs the contract's own request schema into
// `req.validated`, so body validation stays under test.
vi.mock('@server/middlewares/defineNextRoute', () => ({
  nextRouteForContract: (contract: { request: { parse: (body: unknown) => unknown } }) => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      async (req: unknown, res: unknown) => {
        try {
          const route = h[(req as { method?: string }).method ?? 'GET'];
          if (!route) return;
          (req as { validated?: unknown }).validated = contract.request.parse((req as { body?: unknown }).body);
          return await route(req, res);
        } catch (err) {
          const status = isZodError(err)
            ? 422
            : typeof (err as { statusCode?: number })?.statusCode === 'number'
              ? (err as { statusCode: number }).statusCode
              : 500;
          (res as { status: (n: number) => { json: (b: unknown) => void } })
            .status(status)
            .json({ error: (err as Error)?.message });
        }
      },
      {
        use: () => chain,
        post: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.POST = fns[fns.length - 1]), chain),
      }
    );
    return chain;
  },
}));
vi.mock('@server/middlewares/rateLimit', () => ({ rateLimit: () => vi.fn() }));
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  usageEventRepository: { record: (...a: unknown[]) => recordUsage(...a) },
}));
vi.mock('@bike4mind/utils', async importActual => ({
  ...(await importActual<typeof import('@bike4mind/utils')>()),
  getSettingsMap: vi.fn(async () => ({})),
  getSettingsValue: vi.fn(() => true),
}));
vi.mock('@server/billing/reserveRequestCredits', () => ({ reserveRequestCredits: (...a: unknown[]) => reserve(...a) }));
// The real TestDecisionProvider behind a spy, so the route runs the real retry policy and normalizer.
vi.mock('@server/decisions/providers', async () => {
  const { TestDecisionProvider } = await import('@bike4mind/utils/decisionProviders');
  const real = new TestDecisionProvider();
  const provider = {
    id: 'test',
    models: ['test-decisions'],
    decide: (...a: Parameters<typeof real.decide>) => {
      providerSpy(...a);
      return real.decide(...a);
    },
  };
  return {
    getDecisionProviderRegistry: () => ({
      forModel: (model: string) => (registeredModels.value.includes(model) ? provider : undefined),
      models: () => registeredModels.value,
    }),
    resolveDecisionProviderKey: (...a: unknown[]) => resolveKey(...a),
  };
});
vi.mock('@server/files/loadAccessibleFabFile', () => ({ loadAccessibleFabFile: (...a: unknown[]) => loadFile(...a) }));
// Real resizing needs a decodable image; the dimension gate has its own tests.
vi.mock('@bike4mind/utils/imageResize', () => ({ ensureImageWithinDimensionLimit: async (bytes: Buffer) => bytes }));
vi.mock('@server/utils/storage', () => ({
  getFilesStorage: () => ({ download: (...a: unknown[]) => download(...a) }),
}));

import { NotFoundError } from '@bike4mind/utils';
import { TEST_DECISION_MARKERS } from '@bike4mind/utils/decisionProviders';
import handler from '../decisions/index';

type Handler = (req: unknown, res: unknown) => Promise<void>;

const FILE_ID = '64b7f0c2a1b2c3d4e5f60718';
const PNG_BYTES = Buffer.from('iVBORw0KGgo=', 'base64');

const QUESTIONS = [
  { type: 'predicate', name: 'is_urgent', instructions: 'Needs a reply within 24 hours.' },
  {
    type: 'choice',
    name: 'team',
    instructions: 'Which team?',
    choices: [{ value: 'billing' }, { value: 'technical' }, { value: 'sales' }],
  },
  {
    type: 'score',
    name: 'frustration',
    instructions: 'How frustrated?',
    levels: [{ label: 'calm' }, { label: 'frustrated' }, { label: 'angry' }],
  },
];

const run = async (body: Record<string, unknown>) => {
  const { req, res } = createMocks({
    method: 'POST',
    body: { model: 'test-decisions', questions: QUESTIONS, ...body },
  });
  Object.assign(req, {
    user: { id: 'u1' },
    apiKeyInfo: { keyId: 'k1' },
    logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  });
  await (handler as unknown as Handler)(req, res);
  return { status: res._getStatusCode(), body: res._getJSONData(), headers: res._getHeaders() };
};

describe('POST /api/v1/decisions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredModels.value = ['test-decisions', 'gpt-6-luna'];
    resolveKey.mockResolvedValue('test-key');
    recordUsage.mockResolvedValue(undefined);
    settle.mockImplementation(async (credits: number) => credits);
    reserve.mockResolvedValue({ ownerId: 'u1', ownerType: CreditHolderType.User, reservedCredits: 1, refund, settle });
  });

  it('answers every question type in question order with an id, the resolved model and usage', async () => {
    const { status, body } = await run({ input: 'Help! My payouts have been failing for 3 days.' });

    expect(status).toBe(200);
    expect(body).toMatchObject({ object: 'decision', model: 'test-decisions' });
    expect(body.id).toMatch(/^dec_[0-9a-f]{32}$/);
    expect(body.answers.map((answer: { type: string; name: string }) => [answer.type, answer.name])).toEqual([
      ['predicate', 'is_urgent'],
      ['choice', 'team'],
      ['score', 'frustration'],
    ]);
    expect(body.answers[1].probabilities.map((entry: { value: string }) => entry.value)).toEqual([
      'billing',
      'technical',
      'sales',
    ]);
    expect(body.usage.total_tokens).toBe(body.usage.input_tokens + body.usage.output_tokens);
  });

  it('settles as decision_usage and records a usage event without the input', async () => {
    await run({ input: 'Payouts failing' });

    expect(settle).toHaveBeenCalledWith(
      0,
      expect.objectContaining({ type: 'decision_usage', model: 'test-decisions', apiKeyId: 'k1', source: 'api' })
    );
    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ feature: 'decision', provider: 'test', status: 'ok', apiKeyId: 'k1' })
    );
    expect(JSON.stringify(recordUsage.mock.calls)).not.toContain('Payouts failing');
  });

  it('defaults the safety identifier to a hash of the user id, and passes a caller value through', async () => {
    await run({ input: 'x' });
    expect(providerSpy.mock.calls[0][0].safetyIdentifier).toBe(createHash('sha256').update('u1').digest('hex'));

    await run({ input: 'x', safety_identifier: 'end-user-7' });
    expect(providerSpy.mock.calls[1][0].safetyIdentifier).toBe('end-user-7');
  });

  it('keeps a refusal as an answer instead of failing the request', async () => {
    const { status, body } = await run({ input: `please ${TEST_DECISION_MARKERS.refuse}` });
    expect(status).toBe(200);
    expect(body.answers[0]).toEqual({ type: 'refusal', name: 'is_urgent' });
  });

  it('rejects duplicate names with 422, the error code and the question path', async () => {
    const { status, body } = await run({ input: 'x', questions: [QUESTIONS[0], QUESTIONS[0]] });
    expect(status).toBe(422);
    expect(body).toMatchObject({ errorCode: 'invalid_request', param: 'questions[1].name' });
    expect(reserve).not.toHaveBeenCalled();
  });

  it('rejects an http(s) image URL and an unknown model at the schema', async () => {
    expect((await run({ input: [{ type: 'image', image_url: 'https://example.com/a.png' }] })).status).toBe(422);
    expect((await run({ input: 'x', model: 'gpt-nope' })).status).toBe(422);
  });

  it('returns 422 model_unavailable for a catalog model this deployment does not serve', async () => {
    registeredModels.value = ['gpt-6-luna'];
    const { status, body } = await run({ input: 'x' });
    expect(status).toBe(422);
    expect(body).toMatchObject({ errorCode: 'model_unavailable', param: 'model' });
  });

  it('returns 503 provider_not_configured when no usable key resolves', async () => {
    resolveKey.mockResolvedValue(null);
    const { status, body } = await run({ input: 'x' });
    expect(status).toBe(503);
    expect(body.errorCode).toBe('provider_not_configured');
  });

  it('retries an overloaded provider once on the same model, then 503s with Retry-After and refunds', async () => {
    const { status, body, headers } = await run({ input: TEST_DECISION_MARKERS.overloaded });

    expect(status).toBe(503);
    expect(body.errorCode).toBe('provider_overloaded');
    expect(headers['retry-after']).toMatch(/^\d+$/);
    expect(providerSpy).toHaveBeenCalledTimes(2);
    expect(providerSpy.mock.calls.every(([request]) => request.model === 'test-decisions')).toBe(true);
    expect(refund).toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
  });

  it('maps a rejected provider key to 401 provider_rejected and refunds', async () => {
    const { status, body } = await run({ input: TEST_DECISION_MARKERS.badKey });
    expect(status).toBe(401);
    expect(body.errorCode).toBe('provider_rejected');
    expect(refund).toHaveBeenCalled();
  });

  it('returns 422 insufficient_credits from the credit hold', async () => {
    reserve.mockRejectedValue(insufficientCreditsError('Not enough credits'));
    const { status } = await run({ input: 'x' });
    expect(status).toBe(422);
    expect(providerSpy).not.toHaveBeenCalled();
  });

  describe('file_id images', () => {
    it('loads the file through the files ACL and sends it as a data URL', async () => {
      loadFile.mockResolvedValue({
        mimeType: 'image/png',
        fileSize: PNG_BYTES.length,
        filePath: 'u1/a.png',
        moderationStatus: 'clean',
      });
      download.mockResolvedValue(PNG_BYTES);

      const { status } = await run({ input: [{ type: 'image', file_id: FILE_ID }] });

      expect(status).toBe(200);
      expect(loadFile).toHaveBeenCalledWith(expect.anything(), FILE_ID);
      expect(providerSpy.mock.calls[0][0].input).toEqual([
        { type: 'image', dataUrl: `data:image/png;base64,${PNG_BYTES.toString('base64')}` },
      ]);
    });

    it('returns 404 input_image_not_found for a file the caller cannot read', async () => {
      loadFile.mockRejectedValue(new NotFoundError('nope'));
      const { status, body } = await run({ input: [{ type: 'image', file_id: FILE_ID }] });
      expect(status).toBe(404);
      expect(body).toMatchObject({ errorCode: 'input_image_not_found', param: 'input[0].file_id' });
      expect(reserve).not.toHaveBeenCalled();
    });

    it('refuses an image moderation has not cleared', async () => {
      loadFile.mockResolvedValue({
        mimeType: 'image/png',
        fileSize: 10,
        filePath: 'u1/a.png',
        moderationStatus: 'pending',
      });
      const { status, body } = await run({ input: [{ type: 'image', file_id: FILE_ID }] });
      expect(status).toBe(422);
      expect(body.errorCode).toBe('unsupported_input');
      expect(download).not.toHaveBeenCalled();
    });

    it('returns 422 unsupported_input for a file that is not an image', async () => {
      loadFile.mockResolvedValue({ mimeType: 'application/pdf', fileSize: 10, filePath: 'u1/a.pdf' });
      const { status, body } = await run({ input: [{ type: 'image', file_id: FILE_ID }] });
      expect(status).toBe(422);
      expect(body.errorCode).toBe('unsupported_input');
    });
  });
});
