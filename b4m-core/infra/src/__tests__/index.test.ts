import { describe, it, expect } from 'vitest';
import * as infraExports from '../index.js';

describe('barrel smoke test', () => {
  it('exports createDlqRegistry as a function', () => {
    expect(typeof infraExports.createDlqRegistry).toBe('function');
  });

  it('exports isMonitoredStage as a function', () => {
    expect(typeof infraExports.isMonitoredStage).toBe('function');
  });

  it('createDlqRegistry is callable with a minimal descriptor', () => {
    const descriptors = [
      { label: 'test-queue', displayName: 'Test Queue', application: 'TestApp', sourceQueue: 'testQueue' },
    ] as const;
    const resolvers = {
      resolveDlqUrl: () => 'https://sqs.example.com/123/test-dlq',
      resolveSourceQueueUrl: () => 'https://sqs.example.com/123/test-queue',
    };
    const registry = infraExports.createDlqRegistry(descriptors, resolvers);
    expect(registry.getDlqUrl('test-queue')).toBe('https://sqs.example.com/123/test-dlq');
    expect(registry.getSourceQueueUrl('testQueue')).toBe('https://sqs.example.com/123/test-queue');
  });
});
