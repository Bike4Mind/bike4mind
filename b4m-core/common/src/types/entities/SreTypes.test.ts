import { describe, it, expect } from 'vitest';
import { SreEventPayloadSchema, SreJobMessageSchema, SreSourceType, SreClassification } from './SreTypes';

describe('SreEventPayloadSchema — triggerAction (#8305 regression)', () => {
  const base = {
    source: SreSourceType.GITHUB_ISSUE,
    fingerprint: 'fp-1',
    classification: SreClassification.MEDIUM,
    errorMessage: 'boom',
  };

  it('preserves triggerAction through parse instead of stripping it', () => {
    // Producers (sreWebhookDispatch) set triggerAction; the Diagnostician reads it
    // to treat a reopened issue as a stronger "fix didn't work" signal. Before the
    // field was declared on the schema, Zod silently dropped it on parse.
    const parsed = SreEventPayloadSchema.parse({ ...base, triggerAction: 'reopened' });
    expect(parsed.triggerAction).toBe('reopened');
  });

  it('preserves triggerAction when validated as a jobType: analysis message', () => {
    const parsed = SreJobMessageSchema.parse({ jobType: 'analysis', ...base, triggerAction: 'reopened' });
    expect(parsed.jobType).toBe('analysis');
    if (parsed.jobType === 'analysis') {
      expect(parsed.triggerAction).toBe('reopened');
    }
  });

  it('leaves triggerAction undefined when the producer omits it', () => {
    const parsed = SreEventPayloadSchema.parse(base);
    expect(parsed.triggerAction).toBeUndefined();
  });

  it('rejects an invalid triggerAction value', () => {
    expect(() => SreEventPayloadSchema.parse({ ...base, triggerAction: 'bogus' })).toThrow();
  });
});

describe('SreJobMessageSchema — discriminated union', () => {
  const analysisBase = {
    jobType: 'analysis',
    source: SreSourceType.CLOUDWATCH,
    fingerprint: 'fp-1',
    classification: SreClassification.MEDIUM,
    errorMessage: 'boom',
  };

  const revisionBase = {
    jobType: 'revision',
    trackingId: 'track-1',
    fingerprint: 'fp-1',
    branchName: 'sre-fix/abc',
    prNumber: 42,
    originalDiagnosis: {
      rootCause: 'rc',
      proposedFix: 'pf',
      confidence: 80,
      riskAssessment: 'low',
      affectedFiles: [],
    },
    source: SreSourceType.GITHUB_ISSUE,
  };

  it('validates a complete revision message and preserves prNumber', () => {
    const parsed = SreJobMessageSchema.parse(revisionBase);
    expect(parsed.jobType).toBe('revision');
    if (parsed.jobType === 'revision') {
      expect(parsed.prNumber).toBe(42);
      expect(parsed.originalDiagnosis.rootCause).toBe('rc');
    }
  });

  it('rejects a revision message missing trackingId', () => {
    const { trackingId: _omit, ...noTrackingId } = revisionBase;
    expect(() => SreJobMessageSchema.parse(noTrackingId)).toThrow();
  });

  it('rejects an unknown jobType discriminator', () => {
    expect(() => SreJobMessageSchema.parse({ ...analysisBase, jobType: 'bogus' })).toThrow();
  });

  it('rejects a message with no jobType', () => {
    const { jobType: _omit, ...noJobType } = analysisBase;
    expect(() => SreJobMessageSchema.parse(noJobType)).toThrow();
  });
});
