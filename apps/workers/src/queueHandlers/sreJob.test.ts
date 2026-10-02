import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ZodError } from 'zod';

// Spy on the extracted logic functions - the merged handler's job is purely to
// validate + route, so the handlers themselves are mocked out.
const mockRunSreAnalysis = vi.fn();
const mockRunSreRevision = vi.fn();

vi.mock('@server/queueHandlers/sreAnalysis', () => ({
  runSreAnalysis: (...args: unknown[]) => mockRunSreAnalysis(...args),
}));
vi.mock('@server/queueHandlers/sreRevision', () => ({
  runSreRevision: (...args: unknown[]) => mockRunSreRevision(...args),
}));

// Passthrough so `dispatch` is the raw (event, ctx, logger) handler.
vi.mock('@server/queueHandlers/utils', () => ({
  dispatchWithLogger: (fn: (...args: unknown[]) => unknown) => fn,
}));

// Intentionally NOT mocking @bike4mind/common - we want the real
// SreJobMessageSchema discriminated union to validate/route here.

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  log: vi.fn(),
  updateMetadata: vi.fn(),
} as never;

import { dispatch } from './sreJob';
import { SreSourceType, SreClassification } from '@bike4mind/common';

function makeSqsEvent(body: Record<string, unknown>) {
  return { Records: [{ body: JSON.stringify(body) }] } as never;
}

const analysisBody = {
  jobType: 'analysis',
  source: SreSourceType.CLOUDWATCH,
  fingerprint: 'fp-1',
  classification: SreClassification.MEDIUM,
  errorMessage: 'boom',
};

const revisionBody = {
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

describe('sreJob handler', () => {
  beforeEach(() => vi.clearAllMocks());

  it("routes jobType: 'analysis' to runSreAnalysis", async () => {
    await dispatch(makeSqsEvent(analysisBody), {} as never, mockLogger);

    expect(mockRunSreAnalysis).toHaveBeenCalledTimes(1);
    expect(mockRunSreRevision).not.toHaveBeenCalled();
    const [payload] = mockRunSreAnalysis.mock.calls[0];
    expect(payload.jobType).toBe('analysis');
    expect(payload.fingerprint).toBe('fp-1');
  });

  it("routes jobType: 'revision' to runSreRevision", async () => {
    await dispatch(makeSqsEvent(revisionBody), {} as never, mockLogger);

    expect(mockRunSreRevision).toHaveBeenCalledTimes(1);
    expect(mockRunSreAnalysis).not.toHaveBeenCalled();
    const [request] = mockRunSreRevision.mock.calls[0];
    expect(request.jobType).toBe('revision');
    expect(request.prNumber).toBe(42);
  });

  it('rejects an unknown jobType discriminator', async () => {
    await expect(
      dispatch(makeSqsEvent({ ...analysisBody, jobType: 'bogus' }), {} as never, mockLogger)
    ).rejects.toThrow(ZodError);
    expect(mockRunSreAnalysis).not.toHaveBeenCalled();
    expect(mockRunSreRevision).not.toHaveBeenCalled();
  });

  it('rejects a message missing required payload fields', async () => {
    await expect(dispatch(makeSqsEvent({ jobType: 'analysis' }), {} as never, mockLogger)).rejects.toThrow(ZodError);
    expect(mockRunSreAnalysis).not.toHaveBeenCalled();
  });
});
