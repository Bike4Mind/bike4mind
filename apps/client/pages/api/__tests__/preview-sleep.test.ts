// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { baseApiOptions, send, stage } = vi.hoisted(() => ({
  baseApiOptions: [] as unknown[],
  send: vi.fn(),
  stage: { value: 'pr123' },
}));

vi.mock('sst', () => ({
  Resource: {
    App: {
      get stage() {
        return stage.value;
      },
    },
  },
}));
vi.mock('@aws-sdk/client-application-auto-scaling', () => ({
  ApplicationAutoScalingClient: class {
    send = send;
  },
  DescribeScalableTargetsCommand: class {
    constructor(public input: unknown) {}
  },
  RegisterScalableTargetCommand: class {
    constructor(public input: unknown) {}
  },
}));
vi.mock('@aws-sdk/client-ecs', () => ({
  ECSClient: class {
    send = send;
  },
  DescribeServicesCommand: class {
    constructor(public input: unknown) {}
  },
}));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({ rateLimit: () => vi.fn() }));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options: unknown) => {
    baseApiOptions.push(options);
    const chain: Record<string, unknown> = {};
    chain.use = () => chain;
    chain.get = (h: unknown) => ((chain.GET = h), chain);
    chain.post = (h: unknown) => ((chain.POST = h), chain);
    return chain;
  },
}));

type Handler = (req: unknown, res: unknown) => Promise<unknown>;
const TARGETS = [
  { label: 'chat-completion', resourceId: 'service/cluster-a/chat', min: 1, max: 2 },
  { label: 'subscriber-fanout', resourceId: 'service/cluster-a/fanout', min: 1, max: 1 },
];

const call = async (method: 'GET' | 'POST') => {
  const route = (await import('../preview-sleep')).default as unknown as Record<string, Handler>;
  const { req, res } = createMocks({ method });
  await route[method](req, res);
  return res;
};
const commandsOf = (name: string) =>
  send.mock.calls
    .map(([c]) => c)
    .filter(c => c.constructor.name === name)
    .map(c => c.input);

beforeEach(() => {
  vi.resetModules();
  send.mockReset();
  stage.value = 'pr123';
  process.env.PREVIEW_SLEEP_ENABLED = 'true';
  process.env.PREVIEW_SLEEP_TARGETS = JSON.stringify(TARGETS);
});

describe('/api/preview-sleep', () => {
  it('rejects API keys and serves only GET and POST', async () => {
    await import('../preview-sleep');
    expect(baseApiOptions.at(-1)).toMatchObject({ auth: 'jwtOnly', allowedMethods: ['GET', 'POST'] });
  });

  it.each(['GET', 'POST'] as const)('404s %s off-preview without calling AWS', async method => {
    process.env.PREVIEW_SLEEP_ENABLED = '';
    expect((await call(method)).statusCode).toBe(404);
    expect(send).not.toHaveBeenCalled();
  });

  it('404s on production even with the flag set', async () => {
    stage.value = 'production';
    expect((await call('POST')).statusCode).toBe(404);
    expect(send).not.toHaveBeenCalled();
  });

  it('POST registers exactly the deployed targets with their awake bounds', async () => {
    send.mockResolvedValue({});
    expect((await call('POST')).statusCode).toBe(202);
    expect(commandsOf('RegisterScalableTargetCommand')).toEqual(
      TARGETS.map(t => ({
        ServiceNamespace: 'ecs',
        ScalableDimension: 'ecs:service:DesiredCount',
        ResourceId: t.resourceId,
        MinCapacity: t.min,
        MaxCapacity: t.max,
      }))
    );
  });

  it('GET reports asleep when a target is scaled to zero', async () => {
    send.mockImplementation(async (c: { constructor: { name: string } }) =>
      c.constructor.name === 'DescribeScalableTargetsCommand'
        ? { ScalableTargets: TARGETS.map(t => ({ ResourceId: t.resourceId, MinCapacity: 0, MaxCapacity: 0 })) }
        : { services: [{ runningCount: 0, desiredCount: 0 }] }
    );
    const res = await call('GET');
    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toEqual({
      asleep: true,
      waking: false,
      services: [
        { label: 'chat-completion', running: 0, desired: 0 },
        { label: 'subscriber-fanout', running: 0, desired: 0 },
      ],
    });
  });

  it('GET reports waking while running tasks lag the restored bounds', async () => {
    send.mockImplementation(async (c: { constructor: { name: string } }) =>
      c.constructor.name === 'DescribeScalableTargetsCommand'
        ? { ScalableTargets: TARGETS.map(t => ({ ResourceId: t.resourceId, MinCapacity: t.min, MaxCapacity: t.max })) }
        : { services: [{ runningCount: 0, desiredCount: 1 }] }
    );
    expect((await call('GET'))._getJSONData()).toMatchObject({ asleep: false, waking: true });
  });

  it('GET treats a missing service or target as asleep, and no targets as awake', async () => {
    send.mockResolvedValue({});
    expect((await call('GET'))._getJSONData()).toMatchObject({ asleep: true });
    process.env.PREVIEW_SLEEP_TARGETS = '';
    send.mockClear();
    expect((await call('GET'))._getJSONData()).toEqual({ asleep: false, waking: false, services: [] });
    expect(send).not.toHaveBeenCalled();
  });
});
