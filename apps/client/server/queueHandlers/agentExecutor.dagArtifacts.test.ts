import { describe, it, expect } from 'vitest';
import { collectDagChildArtifactBlocks } from './agentExecutor.dagArtifacts';

const artifact = (id: string, body = 'x') =>
  `<artifact identifier="${id}" type="text/html" title="${id}">${body}</artifact>`;

describe('collectDagChildArtifactBlocks', () => {
  it('returns child artifact blocks the parent did not reproduce', () => {
    const blocks = collectDagChildArtifactBlocks({
      parentAnswer: 'Here is the summary.',
      childAnswers: [`Chart done.\n${artifact('sales-chart')}`],
    });
    expect(blocks).toEqual([artifact('sales-chart')]);
  });

  it('dedups by identifier against the parent (parent already showed it)', () => {
    const blocks = collectDagChildArtifactBlocks({
      parentAnswer: `Combined view:\n${artifact('sales-chart')}`,
      childAnswers: [`Chart done.\n${artifact('sales-chart')}`],
    });
    expect(blocks).toEqual([]);
  });

  it('dedups by identifier across multiple children (same id emitted twice)', () => {
    const blocks = collectDagChildArtifactBlocks({
      parentAnswer: 'Summary.',
      childAnswers: [`A\n${artifact('shared')}`, `B\n${artifact('shared')}`],
    });
    expect(blocks).toEqual([artifact('shared')]);
  });

  it('keeps distinct child artifacts and preserves child order', () => {
    const blocks = collectDagChildArtifactBlocks({
      parentAnswer: 'Summary.',
      childAnswers: [`A\n${artifact('one')}`, `B\n${artifact('two')}`],
    });
    expect(blocks).toEqual([artifact('one'), artifact('two')]);
  });

  it('ignores empty / non-artifact child answers', () => {
    const blocks = collectDagChildArtifactBlocks({
      parentAnswer: 'Summary.',
      childAnswers: ['', 'Just prose, no artifact here.', `Done.\n${artifact('real')}`],
    });
    expect(blocks).toEqual([artifact('real')]);
  });

  it('promotes fenced HTML documents to artifacts (parity with chat extraction)', () => {
    const childAnswers = [
      '```html\n<!DOCTYPE html><html><head><title>Report</title></head><body>hi</body></html>\n```',
    ];
    const blocks = collectDagChildArtifactBlocks({ parentAnswer: 'Summary.', childAnswers });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain('<artifact');
    expect(blocks[0]).toContain('</artifact>');
  });

  it('returns nothing when there are no child artifacts', () => {
    const blocks = collectDagChildArtifactBlocks({
      parentAnswer: `Full answer with its own art:\n${artifact('parent-only')}`,
      childAnswers: ['no artifacts', ''],
    });
    expect(blocks).toEqual([]);
  });
});
