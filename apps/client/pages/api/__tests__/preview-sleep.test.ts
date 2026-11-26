// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { baseApiOptions, logError, send, stage } = vi.hoisted(() => ({
  baseApiOptions: [] as unknown[],
  logError: vi.fn(),
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
vi.mock('@aws-sdk/client-elastic-load-balancing-v2', () => ({
  ElasticLoadBalancingV2Client: class {
    send = send;
  },
  DescribeTargetHealthCommand: class {
    constructor(public input: unknown) {}
  },
}));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options: unknown) => {
    baseApiOptions.push(options);
    const chain: Record<string, unknown> = { middlewares: [] };
    chain.use = (m: unknown) => ((chain.middlewares as unknown[]).push(m), chain);
    chain.get = (h: unknown) => ((chain.GET = h), chain);
    chain.post = (h: unknown) => ((chain.POST = h), chain);
    return chain;
  },
}));

type Handler = (req: unknown, res: unknown) => Promise<unknown>;
type Middleware = (req: unknown, res: unknown, next: () => void) => unknown;
const TARGETS = [
  { label: 'chat-completion', resourceId: 'service/cluster-a/chat', min: 1, max: 2 },
  { label: 'subscriber-fanout', resourceId: 'service/cluster-a/fanout', min: 1, max: 1 },
];

const call = async (method: 'GET' | 'POST') => {
  const route = (await import('../preview-sleep')).default as unknown as Record<string, Handler> & {
    middlewares: Middleware[];
  };
  const { req, res } = createMocks({ method });
  Object.assign(req, { logger: { error: logError } });
  for (const middleware of route.middlewares) {
    let passed = false;
    await middleware(req, res, () => (passed = true));
    if (!passed) return res;
  }
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
  logError.mockReset();
  stage.value = 'pr123';
  process.env.PREVIEW_SLEEP_ENABLED = 'true';
  process.env.PREVIEW_SLEEP_TARGETS = JSON.stringify(TARGETS);
});

describe('/api/preview-sleep', () => {
  it('requires a JWT (no API keys) and serves only GET and POST', async () => {
    await import('../preview-sleep');
    expect(baseApiOptions.at(-1)).toMatchObject({ auth: 'jwtOnly', allowedMethods: ['GET', 'POST'] });
  });

  it.each(['GET', 'POST'] as const)('404s %s off-preview without calling AWS', async method => {
    process.env.PREVIEW_SLEEP_ENABLED = '';
    expect((await call(method)).statusCode).toBe(404);
    expect(send).not.toHaveBeenCalled();
  });

  it('runs the preview gate before the rate limiter', async () => {
    const route = (await import('../preview-sleep')).default as unknown as { middlewares: Middleware[] };
    process.env.PREVIEW_SLEEP_ENABLED = '';
    const { req, res } = createMocks({ method: 'GET' });
    const next = vi.fn();
    await route.middlewares[0](req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(404);
  });

  it.each(['GET', 'POST'] as const)('hides the AWS error text on a failed %s', async method => {
    send.mockRejectedValue(new Error('AccessDenied: arn:partition:iam::account-id:role/example'));
    const res = await call(method);
    expect(res.statusCode).toBe(502);
    expect(JSON.stringify(res._getJSONData())).not.toContain('arn:');
    expect(logError).toHaveBeenCalledTimes(1);
  });

  it('treats malformed targets as none rather than failing', async () => {
    process.env.PREVIEW_SLEEP_TARGETS = '{not json';
    const res = await call('GET');
    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toEqual({ asleep: false, waking: false, services: [] });
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

  describe('once every task is running', () => {
    const respond = (service: Record<string, unknown>, health: string[]) =>
      send.mockImplementation(async (c: { constructor: { name: string } }) => {
        if (c.constructor.name === 'DescribeScalableTargetsCommand')
          return { ScalableTargets: TARGETS.map(t => ({ ResourceId: t.resourceId, MinCapacity: 1, MaxCapacity: 1 })) };
        if (c.constructor.name === 'DescribeTargetHealthCommand')
          return { TargetHealthDescriptions: health.map(State => ({ TargetHealth: { State } })) };
        return { services: [{ runningCount: 1, desiredCount: 1, ...service }] };
      });
    const loadBalancers = [{ targetGroupArn: 'target-group-placeholder' }];
    const deployments = (rolloutState: string) => [
      { status: 'ACTIVE', rolloutState: 'IN_PROGRESS' },
      { status: 'PRIMARY', rolloutState },
    ];

    it('stays waking while the primary rollout is in progress', async () => {
      respond({ deployments: deployments('IN_PROGRESS'), loadBalancers }, ['healthy']);
      expect((await call('GET'))._getJSONData()).toMatchObject({ asleep: false, waking: true });
    });

    it('stays waking while the target is not yet healthy, though the rollout reads completed', async () => {
      respond({ deployments: deployments('COMPLETED'), loadBalancers }, ['initial']);
      const body = (await call('GET'))._getJSONData();
      expect(body).toMatchObject({ asleep: false, waking: true });
      expect(body.services[0]).toEqual({ label: 'chat-completion', running: 1, desired: 1 });
    });

    it('reads awake once the rollout completed and the targets are healthy', async () => {
      respond({ deployments: deployments('COMPLETED'), loadBalancers }, ['healthy']);
      expect((await call('GET'))._getJSONData()).toMatchObject({ asleep: false, waking: false });
      expect(commandsOf('DescribeTargetHealthCommand')).toContainEqual({ TargetGroupArn: 'target-group-placeholder' });
    });

    it('needs as many healthy targets as desired tasks, counting only the healthy state', async () => {
      const service = { runningCount: 2, desiredCount: 2, deployments: deployments('COMPLETED'), loadBalancers };
      respond(service, ['healthy', 'initial']);
      expect((await call('GET'))._getJSONData()).toMatchObject({ asleep: false, waking: true });
      respond(service, ['healthy', 'healthy']);
      expect((await call('GET'))._getJSONData()).toMatchObject({ asleep: false, waking: false });
    });

    it('hides the AWS error text when only the target health lookup fails', async () => {
      respond({ deployments: deployments('COMPLETED'), loadBalancers }, ['healthy']);
      const describe = send.getMockImplementation()!;
      send.mockImplementation(async (c: { constructor: { name: string } }) => {
        if (c.constructor.name === 'DescribeTargetHealthCommand')
          throw new Error('AccessDenied: arn:partition:iam::account-id:role/example');
        return describe(c);
      });
      const res = await call('GET');
      expect(res.statusCode).toBe(502);
      expect(JSON.stringify(res._getJSONData())).not.toContain('arn:');
    });

    it('reads awake with no deployments array and no load balancer', async () => {
      respond({}, []);
      expect((await call('GET'))._getJSONData()).toMatchObject({ asleep: false, waking: false });
      expect(commandsOf('DescribeTargetHealthCommand')).toEqual([]);
    });

    it('stays asleep, not waking, at desired 0 even with an unhealthy target group', async () => {
      send.mockImplementation(async (c: { constructor: { name: string } }) => {
        if (c.constructor.name === 'DescribeScalableTargetsCommand')
          return { ScalableTargets: TARGETS.map(t => ({ ResourceId: t.resourceId, MinCapacity: 0, MaxCapacity: 0 })) };
        if (c.constructor.name === 'DescribeTargetHealthCommand') return { TargetHealthDescriptions: [] };
        return {
          services: [{ runningCount: 0, desiredCount: 0, deployments: deployments('COMPLETED'), loadBalancers }],
        };
      });
      expect((await call('GET'))._getJSONData()).toMatchObject({ asleep: true, waking: false });
      expect(commandsOf('DescribeTargetHealthCommand')).toEqual([]);
    });
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
