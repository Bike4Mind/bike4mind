import { describe, it, expect } from 'vitest';
import { expectTypeOf } from 'vitest';
import { createDlqRegistry } from '../dlqRegistry.js';
import type { DlqDescriptor } from '../types.js';

const TEST_DESCRIPTORS = [
  { label: 'queue-a', displayName: 'Queue A', application: 'AppA', sourceQueue: 'queueASource' },
  { label: 'queue-b', displayName: 'Queue B', application: 'AppB', sourceQueue: 'queueBSource' },
] as const satisfies readonly DlqDescriptor[];

const makeResolvers = (dlqUrls: Record<string, string>, sourceUrls: Record<string, string>) => ({
  resolveDlqUrl: (label: string) => dlqUrls[label],
  resolveSourceQueueUrl: (name: string) => sourceUrls[name],
});

const defaultDlqUrls = {
  'queue-a': 'https://sqs.example.com/123/queue-a-dlq',
  'queue-b': 'https://sqs.example.com/123/queue-b-dlq',
};
const defaultSourceUrls = {
  queueASource: 'https://sqs.example.com/123/queue-a',
  queueBSource: 'https://sqs.example.com/123/queue-b',
};

describe('createDlqRegistry', () => {
  describe('happy path', () => {
    it('getDlqUrl returns the resolved DLQ URL', () => {
      const registry = createDlqRegistry(TEST_DESCRIPTORS, makeResolvers(defaultDlqUrls, defaultSourceUrls));
      expect(registry.getDlqUrl('queue-a')).toBe('https://sqs.example.com/123/queue-a-dlq');
      expect(registry.getDlqUrl('queue-b')).toBe('https://sqs.example.com/123/queue-b-dlq');
    });

    it('getSourceQueueUrl returns the resolved source URL', () => {
      const registry = createDlqRegistry(TEST_DESCRIPTORS, makeResolvers(defaultDlqUrls, defaultSourceUrls));
      expect(registry.getSourceQueueUrl('queueASource')).toBe('https://sqs.example.com/123/queue-a');
      expect(registry.getSourceQueueUrl('queueBSource')).toBe('https://sqs.example.com/123/queue-b');
    });

    it('getDlqByLabel returns the correct descriptor', () => {
      const registry = createDlqRegistry(TEST_DESCRIPTORS, makeResolvers(defaultDlqUrls, defaultSourceUrls));
      const entry = registry.getDlqByLabel('queue-a');
      expect(entry).toBeDefined();
      expect(entry!.displayName).toBe('Queue A');
      expect(entry!.application).toBe('AppA');
      expect(entry!.sourceQueue).toBe('queueASource');
    });

    it('getDlqByLabel returns undefined for unknown label', () => {
      const registry = createDlqRegistry(TEST_DESCRIPTORS, makeResolvers(defaultDlqUrls, defaultSourceUrls));
      expect(registry.getDlqByLabel('nonexistent' as string)).toBeUndefined();
    });

    it('getAllDescriptors returns all descriptors', () => {
      const registry = createDlqRegistry(TEST_DESCRIPTORS, makeResolvers(defaultDlqUrls, defaultSourceUrls));
      const all = registry.getAllDescriptors();
      expect(all).toHaveLength(2);
      expect(all[0].label).toBe('queue-a');
      expect(all[1].label).toBe('queue-b');
    });
  });

  describe('error handling', () => {
    it('getDlqUrl throws exact error string when DLQ URL missing', () => {
      const registry = createDlqRegistry(TEST_DESCRIPTORS, makeResolvers({}, defaultSourceUrls), {
        dlqErrorContext: 'Check dlqUrls Linkable in infra/web.ts.',
      });
      expect(() => registry.getDlqUrl('queue-a')).toThrow(
        'Missing DLQ URL for label: queue-a. Check dlqUrls Linkable in infra/web.ts.'
      );
    });

    it('getSourceQueueUrl throws exact error string when source URL missing', () => {
      const registry = createDlqRegistry(TEST_DESCRIPTORS, makeResolvers(defaultDlqUrls, {}), {
        sourceQueueErrorContext: 'Check sourceQueueUrls Linkable in infra/web.ts.',
      });
      expect(() => registry.getSourceQueueUrl('queueASource')).toThrow(
        'Missing source queue URL for: queueASource. Check sourceQueueUrls Linkable in infra/web.ts.'
      );
    });

    it('getDlqUrl throws without context when no options provided', () => {
      const registry = createDlqRegistry(TEST_DESCRIPTORS, makeResolvers({}, defaultSourceUrls));
      expect(() => registry.getDlqUrl('queue-a')).toThrow('Missing DLQ URL for label: queue-a.');
    });

    it('getSourceQueueUrl throws without context when no options provided', () => {
      const registry = createDlqRegistry(TEST_DESCRIPTORS, makeResolvers(defaultDlqUrls, {}));
      expect(() => registry.getSourceQueueUrl('queueASource')).toThrow('Missing source queue URL for: queueASource.');
    });

    it('throws at construction when duplicate label is detected', () => {
      const dupeDescriptors = [
        { label: 'queue-a', displayName: 'Queue A', application: 'AppA', sourceQueue: 'queueASource' },
        { label: 'queue-a', displayName: 'Queue A Dupe', application: 'AppA', sourceQueue: 'queueASource2' },
      ] as const satisfies readonly DlqDescriptor[];
      expect(() => createDlqRegistry(dupeDescriptors, makeResolvers(defaultDlqUrls, defaultSourceUrls))).toThrow(
        'createDlqRegistry: duplicate label "queue-a"'
      );
    });

    it('resolver returning undefined is normalized to friendly error', () => {
      const resolvers = {
        resolveDlqUrl: (_label: string): string | undefined => undefined,
        resolveSourceQueueUrl: (_name: string): string | undefined => undefined,
      };
      const registry = createDlqRegistry(TEST_DESCRIPTORS, resolvers);
      expect(() => registry.getDlqUrl('queue-a')).toThrow('Missing DLQ URL for label: queue-a.');
    });

    it('resolver that throws propagates the error as-is', () => {
      const resolvers = {
        resolveDlqUrl: (_label: string): string | undefined => {
          throw new Error('resolver internal failure');
        },
        resolveSourceQueueUrl: (_name: string): string | undefined => undefined,
      };
      const registry = createDlqRegistry(TEST_DESCRIPTORS, resolvers);
      expect(() => registry.getDlqUrl('queue-a')).toThrow('resolver internal failure');
    });
  });

  describe('type-level tests', () => {
    it('getSourceQueueUrl parameter type is literal union, not string', () => {
      const registry = createDlqRegistry(TEST_DESCRIPTORS, makeResolvers(defaultDlqUrls, defaultSourceUrls));
      expectTypeOf(registry.getSourceQueueUrl).parameter(0).toEqualTypeOf<'queueASource' | 'queueBSource'>();
    });

    it('getDlqUrl parameter type is literal union, not string', () => {
      const registry = createDlqRegistry(TEST_DESCRIPTORS, makeResolvers(defaultDlqUrls, defaultSourceUrls));
      expectTypeOf(registry.getDlqUrl).parameter(0).toEqualTypeOf<'queue-a' | 'queue-b'>();
    });
  });
});
