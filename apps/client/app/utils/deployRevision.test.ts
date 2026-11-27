import { describe, beforeEach, expect, it, vi } from 'vitest';
import { observeDeployedRevision, resetDeployedRevisionBaseline } from './deployRevision';

describe('observeDeployedRevision', () => {
  beforeEach(resetDeployedRevisionBaseline);

  it('takes the first revision as the page-load baseline without reporting a deploy', () => {
    expect(observeDeployedRevision('rev-a')).toBe(false);
    expect(observeDeployedRevision('rev-a')).toBe(false);
  });

  it('reports a deploy when the revision changes', () => {
    observeDeployedRevision('rev-a');
    expect(observeDeployedRevision('rev-b')).toBe(true);
  });

  it('keeps reporting while the revision differs from the baseline', () => {
    observeDeployedRevision('rev-a');
    expect(observeDeployedRevision('rev-b')).toBe(true);
    expect(observeDeployedRevision('rev-b')).toBe(true);
  });

  it.each([undefined, ''])('ignores a missing revision (%j) and keeps the baseline', value => {
    observeDeployedRevision('rev-a');
    expect(observeDeployedRevision(value)).toBe(false);
    expect(observeDeployedRevision('rev-a')).toBe(false);
  });

  it('does not make a missing-revision response the baseline', () => {
    expect(observeDeployedRevision(undefined)).toBe(false);
    expect(observeDeployedRevision('rev-a')).toBe(false);
  });

  it('starts a fresh module instance (a reload) with no baseline', async () => {
    observeDeployedRevision('rev-a');
    vi.resetModules();
    const fresh = await import('./deployRevision');
    expect(fresh.observeDeployedRevision('rev-b')).toBe(false);
  });
});
