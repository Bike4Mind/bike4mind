import { describe, it, expect } from 'vitest';
import { copyForRunningTool } from './loadingCopy';

describe('copyForRunningTool', () => {
  it('prefers a core tool entry over an overlay one', () => {
    expect(copyForRunningTool('web_search', { web_search: 'Overlay copy' })).not.toBe('Overlay copy');
  });

  it('uses overlay copy for a tool core does not list', () => {
    expect(copyForRunningTool('partner_run_job', { partner_run_job: 'Running the partner job…' })).toBe(
      'Running the partner job…'
    );
  });

  it('falls back to the generic line when no registry names the tool', () => {
    expect(copyForRunningTool('partner_run_job', {})).toBe('Running partner run job…');
    expect(copyForRunningTool(undefined, {})).toBe('Working on it…');
  });

  it('does not read inherited object keys as overlay copy', () => {
    expect(copyForRunningTool('constructor', {})).toBe('Running constructor…');
  });
});
