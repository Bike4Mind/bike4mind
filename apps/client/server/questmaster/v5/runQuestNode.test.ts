import { describe, expect, it } from 'vitest';
import { buildNodeQuery } from './runQuestNode';

describe('buildNodeQuery', () => {
  it('renders title and task', () => {
    expect(buildNodeQuery({ title: 'Fetch the data', task: 'Pull the last 30 days of logs.' })).toBe(
      '# Fetch the data\n\nPull the last 30 days of logs.'
    );
  });

  it('appends acceptance criteria when present', () => {
    const query = buildNodeQuery({
      title: 'Fetch the data',
      task: 'Pull the last 30 days of logs.',
      acceptanceCriteria: 'A CSV with one row per request.',
    });
    expect(query).toContain('## Acceptance criteria');
    expect(query).toContain('A CSV with one row per request.');
  });

  it('omits the acceptance-criteria section when it is blank', () => {
    const query = buildNodeQuery({ title: 'T', task: 'Do it', acceptanceCriteria: '   ' });
    expect(query).not.toContain('Acceptance criteria');
  });
});
