import { describe, it, expect } from 'vitest';
import {
  contributedQueueNames,
  contributedQueuePairOptions,
  describeDroppedContributions,
  isValidContributedResourceName,
  partitionContributed,
  partitionContributedQueues,
  reservedQueueNames,
  type ContributedQueueSpec,
} from '../contributions.js';
import { buildQueuePair } from '../queueFactory.js';

const byName = (s: { name: string }) => s.name;

describe('partitionContributed', () => {
  const core = new Set(['MONGODB_URI']);

  it('registers valid unique names in declaration order', () => {
    const result = partitionContributed([{ name: 'EXAMPLE_API_TOKEN' }, { name: 'EXAMPLE_URL' }], byName, core);
    expect(result.registered.map(byName)).toEqual(['EXAMPLE_API_TOKEN', 'EXAMPLE_URL']);
    expect(result.coreCollisions).toEqual([]);
    expect(result.duplicates).toEqual([]);
    expect(result.rejected).toEqual([]);
  });

  it('drops a name core already owns', () => {
    const result = partitionContributed([{ name: 'MONGODB_URI' }], byName, core);
    expect(result.registered).toEqual([]);
    expect(result.coreCollisions).toEqual(['MONGODB_URI']);
  });

  it('reports a core-name collision in coreCollisions and registers the rest', () => {
    const result = partitionContributed([{ name: 'MONGODB_URI' }, { name: 'EXAMPLE_URL' }], byName, core);
    expect(result.coreCollisions).toEqual(['MONGODB_URI']);
    expect(result.registered.map(byName)).toEqual(['EXAMPLE_URL']);
  });

  it('keeps the first of two declarations with the same name', () => {
    const first = { name: 'EXAMPLE_API_TOKEN', placeholder: 'a' };
    const result = partitionContributed([first, { name: 'EXAMPLE_API_TOKEN', placeholder: 'b' }], byName, core);
    expect(result.registered).toEqual([first]);
    expect(result.duplicates).toEqual(['EXAMPLE_API_TOKEN']);
  });

  it.each(['', '1ABC', 'HAS-DASH', 'HAS SPACE', '__proto__', '_LEADING', 'constructor', 'prototype'])(
    'rejects the invalid name %j',
    name => {
      expect(isValidContributedResourceName(name)).toBe(false);
      expect(partitionContributed([{ name }], byName, core).rejected).toEqual([name]);
    }
  );

  // Each of these would alias a core or platform variable through the env var it maps to.
  it.each([
    'MongodbUri',
    'mongodb_uri',
    'ExampleUrl',
    'NODE_OPTIONS',
    'AWS_SECRET_ACCESS_KEY',
    'LD_PRELOAD',
    'PATH',
    'HTTPS_PROXY',
    'SSL_CERT_FILE',
    'OPENSSL_CONF',
    'AWS_X',
    'HTTP_PROXY',
    'DOCUMENTDB_CA_BUNDLE_BASE64',
    'AGENT_EXECUTOR_INTERNAL_SECRET',
    'INTERNAL_WS_SECRET',
    'INTERNAL_S3_WEBHOOK_SECRET',
  ])('rejects %j, which names or aliases a variable a contribution must not own', name => {
    expect(isValidContributedResourceName(name)).toBe(false);
  });

  it('rejects a non-string name', () => {
    expect(partitionContributed([{ name: 42 }], s => s.name, core).rejected).toEqual(['42']);
  });

  it('describes each kind of drop', () => {
    const result = partitionContributed(
      [{ name: 'MONGODB_URI' }, { name: 'A' }, { name: 'A' }, { name: '' }],
      byName,
      core
    );
    expect(describeDroppedContributions('secret', result)).toHaveLength(3);
    expect(describeDroppedContributions('secret', partitionContributed([], byName, core))).toEqual([]);
  });
});

describe('partitionContributedQueues', () => {
  const core = {
    resourceNames: ['imageGenerationQueue', 'imageGenerationDLQ', 'EXAMPLE_API_TOKEN'],
    envNames: ['MONGODB_URI', 'IMAGE_GENERATION_QUEUE'],
    dlqLabels: ['image-generation', 'fab-file-moderation'],
  };
  const queue = (over: Partial<ContributedQueueSpec> = {}): ContributedQueueSpec => ({
    name: 'exampleJobQueue',
    visibilityTimeout: '6 minutes',
    label: 'example-job',
    displayName: 'Example Job',
    application: 'Example',
    ...over,
  });
  const dropped = (spec: ContributedQueueSpec) => {
    const result = partitionContributedQueues([spec], core);
    expect(result.registered).toEqual([]);
    return result;
  };

  it('registers a valid pair', () => {
    expect(partitionContributedQueues([queue()], core).registered).toEqual([queue()]);
  });

  it('registers nothing for an empty list', () => {
    expect(partitionContributedQueues([], core)).toEqual({
      registered: [],
      coreCollisions: [],
      duplicates: [],
      rejected: [],
    });
  });

  it('names the pair the way buildQueuePair does, so a moved queue keeps its logical names', () => {
    const legacy = { name: 'exampleJobQueue', visibilityTimeout: '6 minutes' };
    const pair = buildQueuePair(legacy);
    expect(contributedQueueNames(legacy)).toEqual([pair.name, pair.dlqName]);
    expect(contributedQueueNames({ name: 'imageGenerationQueue', dlqName: 'imageGenerationDLQ' })).toEqual([
      'imageGenerationQueue',
      'imageGenerationDLQ',
    ]);
  });

  it.each([
    ['a core queue name', { name: 'imageGenerationQueue' }],
    ['a core DLQ name as its DLQ', { dlqName: 'imageGenerationDLQ' }],
    ['a core name in env form', { name: 'mongodbUri' }],
    ['a core queue in another casing', { name: 'imageGenerationQUEUE' }],
    ['a contributed secret in env form', { name: 'exampleApiToken' }],
    ['a core DLQ label', { label: 'image-generation' }],
    ['an alarm-only core label', { label: 'fab-file-moderation' }],
  ])('drops a pair reusing %s', (_what, over) => {
    expect(dropped(queue(over)).coreCollisions).toHaveLength(1);
  });

  it.each([
    ['an upper snake name', { name: 'EXAMPLE_QUEUE' }],
    ['a DLQ name equal to the queue name', { dlqName: 'exampleJobQueue' }],
    ['a non-kebab label', { label: 'Example Job' }],
    ['the reserved alarm pipeline label', { label: 'alarm-handler-dlq' }],
    ['a duration sst.aws.Queue rejects', { visibilityTimeout: '6m' }],
    ['a visibility timeout above 12 hours', { visibilityTimeout: '13 hours' }],
    ['a visibility timeout of 43201 seconds', { visibilityTimeout: '43201 seconds' }],
    ['a retry of zero', { retry: 0 }],
    ['a retry above 1000', { retry: 1001 }],
    ['a DLQ retention below 60 seconds', { dlqMessageRetentionSeconds: 59 }],
    ['a DLQ retention above 14 days', { dlqMessageRetentionSeconds: 1209601 }],
    ['a name whose env form is a reserved variable', { name: 'awsRegion' }],
    ['a DLQ name whose env form has a reserved prefix', { dlqName: 'nodeOptionsDLQ' }],
  ])('rejects %s', (_what, over) => {
    expect(dropped(queue(over)).rejected).toHaveLength(1);
  });

  it('registers a pair at the SQS limits', () => {
    const limits = queue({ visibilityTimeout: '12 hours', retry: 1000, dlqMessageRetentionSeconds: 1209600 });
    expect(partitionContributedQueues([limits], core).registered).toEqual([limits]);
  });

  it('keeps the first of two pairs sharing a name, DLQ name or label', () => {
    const result = partitionContributedQueues(
      [
        queue(),
        queue({ label: 'other' }),
        queue({ name: 'otherQueue', dlqName: 'exampleJobQueue', label: 'other-2' }),
        queue({ name: 'thirdQueue' }),
      ],
      core
    );
    expect(result.registered).toEqual([queue()]);
    expect(result.duplicates).toHaveLength(3);
  });
});

describe('contributedQueuePairOptions', () => {
  const spec = {
    name: 'exampleJobQueue',
    visibilityTimeout: '6 minutes',
    label: 'x',
    displayName: 'X',
    application: 'X',
  };

  it('encrypts both queues when the spec says nothing', () => {
    const pair = buildQueuePair(contributedQueuePairOptions(spec));
    expect(pair.dlqArgs.transform?.queue ?? {}).toMatchObject({ kmsMasterKeyId: 'alias/aws/sqs' });
    expect(pair.queueArgs('arn').transform?.queue ?? {}).toMatchObject({ kmsMasterKeyId: 'alias/aws/sqs' });
  });

  it('keeps an explicit opt-out, so a queue moved from infra/queues.ts stays as it was', () => {
    const pair = buildQueuePair(contributedQueuePairOptions({ ...spec, encryption: 'none' }));
    expect(pair.dlqArgs.transform?.queue ?? {}).not.toHaveProperty('kmsMasterKeyId');
    expect(pair.queueArgs('arn').transform?.queue ?? {}).not.toHaveProperty('kmsMasterKeyId');
  });
});

describe('reservedQueueNames', () => {
  const generated = {
    contributedInfraResources: {
      secrets: [{ name: 'EXAMPLE_TOKEN' }, { name: 'bad name' }],
      rotations: [],
      queues: [],
    },
    coreResourceNames: ['CORE_A'],
    coreEnvNames: ['CORE_ENV'],
    coreDlqLabels: ['core-label'],
  } as unknown as Parameters<typeof reservedQueueNames>[0];

  it('reserves the core names plus every declared contributed secret, registered or not', () => {
    const reserved = reservedQueueNames(generated);
    expect([...reserved!.resourceNames]).toEqual(['CORE_A', 'EXAMPLE_TOKEN', 'bad name']);
    expect([...reserved!.envNames]).toEqual(['CORE_ENV']);
    expect([...reserved!.dlqLabels]).toEqual(['core-label']);
  });

  it.each(['coreResourceNames', 'coreEnvNames', 'coreDlqLabels'])('is null when %s is null', key => {
    expect(reservedQueueNames({ ...generated, [key]: null })).toBeNull();
  });
});
