import { describe, expect, it } from 'vitest';
import { getToolDisplayName, humanizeToolId } from './toolMapping';

describe('humanizeToolId', () => {
  it('drops a leading namespace segment and title-cases the rest', () => {
    expect(humanizeToolId('acme_run_batch_job')).toBe('Run Batch Job');
    expect(humanizeToolId('acme-solve.model')).toBe('Solve Model');
  });

  it('keeps a single-word id whole', () => {
    expect(humanizeToolId('lookup')).toBe('Lookup');
  });

  it('never returns a snake_case id', () => {
    expect(humanizeToolId('ACME_DEEP_SCAN')).toBe('Deep Scan');
  });
});

describe('getToolDisplayName', () => {
  it("keeps a core tool's own name, even when an overlay labels the same id", () => {
    expect(getToolDisplayName('web_search', { web_search: 'Renamed' })).toBe('Web Search');
  });

  it('uses the label an overlay contributed for its tool', () => {
    expect(getToolDisplayName('acme_run_batch_job', { acme_run_batch_job: 'Batch Runner' })).toBe('Batch Runner');
  });

  it('humanizes a tool no one labels', () => {
    expect(getToolDisplayName('acme_run_batch_job', {})).toBe('Run Batch Job');
  });

  it('ignores inherited keys on the label table', () => {
    expect(getToolDisplayName('constructor', {})).toBe('Constructor');
  });
});
