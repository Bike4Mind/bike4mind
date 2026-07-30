import { describe, it, expect } from 'vitest';
import { PromptMetaZodSchema } from './promptMeta';
import { ArtifactTypeSchema } from '../types/entities/ArtifactTypes';

// ChatCompletionInvoke runs PromptMetaZodSchema.parse(quest.promptMeta) on every turn, so a
// value this schema rejects fails the completion outright. These cover the fields whose real
// runtime values are wider than a naive reading of the schema suggests.
describe('PromptMetaZodSchema artifact types', () => {
  it.each(ArtifactTypeSchema.options)('accepts the %s artifact type that parseArtifacts emits', type => {
    const parsed = PromptMetaZodSchema.parse({
      artifacts: [{ type, content: '<div />' }],
    });

    expect(parsed.artifacts?.[0]?.type).toBe(type);
  });

  it('accepts a raw MIME type, which tool extraction falls back to', () => {
    const parsed = PromptMetaZodSchema.parse({
      artifacts: [{ type: 'application/vnd.ant.chess', content: '{}' }],
    });

    expect(parsed.artifacts?.[0]?.type).toBe('application/vnd.ant.chess');
  });
});

describe('PromptMetaZodSchema after a JSON round trip', () => {
  // promptMeta goes out to the client and comes back: the bug-report modal posts it to
  // /api/feedback, which parses the request body with this schema. Every Date is a string by
  // then, so a date field that only accepts z.date() rejects a report the user was told was sent.
  const withDates = {
    artifacts: [{ type: 'html', content: '<div />', timestamp: new Date() }],
    toolHealth: [{ toolName: 'web_search', available: true, failureCount: 0, lastChecked: new Date() }],
    executionTracking: {
      steps: [{ name: 'search', status: 'completed' as const, startTime: new Date(), endTime: new Date() }],
    },
    humanReview: { approved: true, reviewedAt: new Date() },
    statusLog: [{ status: 'First model response', timestamp: new Date() }],
  };

  it('parses its own JSON form', () => {
    const overTheWire = JSON.parse(JSON.stringify(withDates));

    expect(() => PromptMetaZodSchema.parse(overTheWire)).not.toThrow();
  });

  it('still parses the in-memory form with real Dates', () => {
    expect(() => PromptMetaZodSchema.parse(withDates)).not.toThrow();
  });
});
