import { describe, expect, it } from 'vitest';
import { buildCIFailedBlocks, buildPROpenedBlocks } from '../blockTemplates';

describe('GitHub block templates escaping', () => {
  it('renders branch names, author and title as literal text', () => {
    const result = buildPROpenedBlocks({
      prNumber: 7,
      prTitle: 'Fix <!here> & snake_case',
      prUrl: 'https://github.com/o/r/pull/7',
      author: '<@U123>',
      repo: 'o/r',
      baseBranch: 'main',
      headBranch: 'feat/<!channel>',
    });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/<!here>|<!channel>|<@U123>/);
    expect(serialized).toContain('Fix &lt;!here&gt; &amp; snake_case');
    expect(serialized).toContain('feat/&lt;!channel&gt;');
    expect(serialized).toContain('*Author:* &lt;@U123&gt;');
  });

  it('keeps a branch inside its code span and a commit message on one line', () => {
    const result = buildCIFailedBlocks({
      workflowName: 'CI <x>',
      workflowUrl: 'https://github.com/o/r/actions/runs/1',
      branch: 'a`b',
      repo: 'o/r',
      commitMessage: 'first <!channel>\nsecond',
      runNumber: 1,
    });

    const section = result.blocks[1] as { text: { text: string } };
    expect(section.text.text).toContain('|CI &lt;x&gt;>');
    expect(section.text.text).toContain('`a\u02CBb`');
    expect(section.text.text).toContain('Commit: first &lt;!channel&gt;');
  });
});
