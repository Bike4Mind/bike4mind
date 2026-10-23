// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const QUEUE = {
  name: 'exampleJobQueue',
  visibilityTimeout: '6 minutes',
  label: 'example-job',
  displayName: 'Example Job',
  application: 'Example',
};

const DLQ_URLS = {
  'example-job': 'https://sqs.example/exampleJobQueueDLQ',
  'image-generation': 'https://sqs.example/core',
};
const SOURCE_URLS = { exampleJobQueue: 'https://sqs.example/exampleJobQueue' };

async function load(queues: unknown[], coreNames: string[] | null = ['imageGenerationQueue', 'imageGenerationDLQ']) {
  vi.doMock('sst', () => ({ Resource: { dlqUrls: DLQ_URLS, sourceQueueUrls: SOURCE_URLS } }));
  vi.doMock('../premium-generated/infraResources.generated', () => ({
    contributedInfraResources: { secrets: [], rotations: [], queues },
    coreResourceNames: coreNames,
    coreEnvNames: coreNames && [],
    coreDlqLabels: coreNames && ['image-generation'],
  }));
  return import('./dlqRegistry');
}

describe('contributed DLQ registry', () => {
  let baseline: string[];

  beforeEach(async () => {
    vi.resetModules();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    baseline = (await load([])).getDlqRegistry().map(d => d.label);
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock('sst');
    vi.doUnmock('../premium-generated/infraResources.generated');
    vi.restoreAllMocks();
  });

  it('resolves a declared pair from label to DLQ URL to source URL', async () => {
    const registry = await load([QUEUE]);
    const entry = registry.getDlqByLabel('example-job');
    expect(entry).toEqual({
      label: 'example-job',
      displayName: 'Example Job',
      application: 'Example',
      sourceQueue: 'exampleJobQueue',
    });
    expect(registry.getDlqUrl(entry!.label)).toBe(DLQ_URLS['example-job']);
    expect(registry.getSourceQueueUrl(entry!.sourceQueue)).toBe(SOURCE_URLS.exampleJobQueue);
    expect(registry.getDlqUrl(registry.contributedDlqLabel('example-job'))).toBe(DLQ_URLS['example-job']);
    expect(registry.getSourceQueueUrl(registry.contributedSourceQueueName('exampleJobQueue'))).toBe(
      SOURCE_URLS.exampleJobQueue
    );
  });

  it('appends contributed entries and leaves the core labels and order alone', async () => {
    const labels = (await load([QUEUE])).getDlqRegistry().map(d => d.label);
    expect(labels).toEqual([...baseline, 'example-job']);
  });

  it('drops a pair that re-declares a core label or queue, keeping the core entry', async () => {
    const registry = await load([
      { ...QUEUE, label: 'image-generation' },
      { ...QUEUE, name: 'imageGenerationQueue', label: 'example-two' },
    ]);
    expect(registry.getDlqRegistry().map(d => d.label)).toEqual(baseline);
    expect(registry.getDlqByLabel('image-generation')?.sourceQueue).toBe('imageGenerationQueue');
    expect(() => registry.contributedDlqLabel('image-generation')).toThrow('not registered');
  });

  it('keeps the first of duplicate pairs instead of failing the registry', async () => {
    const registry = await load([QUEUE, { ...QUEUE, displayName: 'Second' }]);
    expect(registry.getDlqRegistry().filter(d => d.label === 'example-job')).toHaveLength(1);
    expect(registry.getDlqByLabel('example-job')?.displayName).toBe('Example Job');
  });

  it('throws when narrowing a name nobody declared', async () => {
    const registry = await load([QUEUE]);
    expect(() => registry.contributedDlqLabel('missing')).toThrow('not registered');
    expect(() => registry.contributedSourceQueueName('missingQueue')).toThrow('not registered');
  });

  it('registers nothing when codegen could not read the core names', async () => {
    const registry = await load([QUEUE], null);
    expect(registry.getDlqRegistry().map(d => d.label)).toEqual(baseline);
    expect(() => registry.contributedDlqLabel('example-job')).toThrow('not registered');
  });
});
