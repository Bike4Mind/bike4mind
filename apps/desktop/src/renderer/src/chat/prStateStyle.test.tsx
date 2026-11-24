import { describe, expect, it } from 'vitest';
import type { PrAttention } from '@shared/prAttention';
import type { PrBarSnapshot } from '@shared/pullRequest';
import {
  CHANGES_REQUESTED_COLOR,
  MERGED_COLOR,
  READY_COLOR,
  prIconColor,
  prIconLabel,
  prStateColor,
} from './prStateStyle';
import { STATES, renderBar, renderSidebar } from './prRenderSupport';

const iconColor = (html: string) => /data-pr-state="[a-z]+" data-pr-color="([^"]+)"/.exec(html)?.[1];
const glyphs = (html: string) => [...html.matchAll(/data-pr-glyph="([a-zA-Z]+)"/g)].map(match => match[1]);

/** One read per attention, with the glyph and colour the icon must draw for it. */
const ATTENTION_CASES: {
  attention: PrAttention;
  read: Partial<PrBarSnapshot>;
  glyph: string | null;
  color: (mode: 'light' | 'dark') => string;
}[] = [
  { attention: 'conflict', read: { mergeable: 'CONFLICTING' }, glyph: 'conflict', color: () => 'danger.plainColor' },
  {
    attention: 'ciFailed',
    read: { checks: [{ name: 'lint', bucket: 'fail', required: true }] },
    glyph: 'ciFailed',
    color: () => 'danger.plainColor',
  },
  {
    attention: 'changesRequested',
    read: { reviewDecision: 'CHANGES_REQUESTED' },
    glyph: 'changesRequested',
    color: mode => CHANGES_REQUESTED_COLOR[mode],
  },
  {
    attention: 'ciRunning',
    read: { checks: [{ name: 'test', bucket: 'pending', required: true }] },
    glyph: 'ciRunning',
    color: () => 'warning.plainColor',
  },
  {
    attention: 'awaitingReview',
    read: { reviewDecision: 'REVIEW_REQUIRED', mergeStateStatus: 'BLOCKED' },
    glyph: null,
    color: () => 'text.secondary',
  },
  {
    attention: 'approvedBlocked',
    read: { reviewDecision: 'APPROVED', mergeStateStatus: 'BLOCKED' },
    glyph: 'approvedBlocked',
    color: () => 'success.plainColor',
  },
  { attention: 'ready', read: {}, glyph: 'ready', color: mode => READY_COLOR[mode] },
];

describe('PR state colour', () => {
  it.each(['light', 'dark'] as const)('is the same in the bar and the sidebar for every state (%s)', mode => {
    for (const { display, state, isDraft, queued } of STATES) {
      const bar = renderBar(mode, state, isDraft, queued);
      // The fixture read is approved-or-not-required, green and clean: an open PR is ready.
      const attention = display === 'open' ? 'ready' : undefined;
      const sidebar = renderSidebar({ number: 611, state: display, ...(attention ? { attention } : {}) }, 'done', mode);
      expect(bar).toContain(`data-testid="pr-bar-${display}-icon" data-pr-state="${display}"`);
      expect(sidebar).toContain(`data-session-pr-state="${display}"`);
      expect(iconColor(bar)).toBe(prIconColor({ state: display, attention }, mode));
      expect(iconColor(sidebar)).toBe(iconColor(bar));
    }
  });

  it.each(['light', 'dark'] as const)('draws each attention with its glyph and colour, in both places (%s)', mode => {
    for (const { attention, read, glyph, color } of ATTENTION_CASES) {
      const bar = renderBar(mode, 'OPEN', false, false, read);
      const sidebar = renderSidebar({ number: 611, state: 'open', attention }, 'done', mode);
      for (const html of [bar, sidebar]) {
        expect(html).toContain(`data-pr-attention="${attention}"`);
        expect(iconColor(html)).toBe(color(mode));
        expect(glyphs(html)).toEqual(glyph ? [glyph] : []);
      }
    }
  });

  it('keeps draft, queued, merged and closed on their own icons with no attention mark', () => {
    for (const state of ['draft', 'queued', 'merged', 'closed'] as const) {
      const html = renderSidebar({ number: 611, state, attention: 'ciFailed', behind: true, autoMerge: true });
      expect(html).not.toContain('data-pr-attention');
      expect(glyphs(html)).toEqual([]);
      expect(iconColor(html)).toBe(prStateColor(state, 'light'));
    }
  });

  it('adds behind and auto-merge badges, and fades a last-known icon', () => {
    const html = renderSidebar({
      number: 9,
      state: 'open',
      attention: 'ready',
      behind: true,
      autoMerge: true,
      stale: true,
    });
    expect(glyphs(html)).toEqual(['ready', 'behind', 'autoMerge']);
    expect(html).toContain('data-pr-behind="true"');
    expect(html).toContain('data-pr-auto-merge="true"');
    expect(html).toContain('data-pr-stale="true"');
  });

  it('names the state in words for hover and screen readers', () => {
    expect(prIconLabel(123, { state: 'open', attention: 'changesRequested', behind: true })).toBe(
      'PR #123 - Open: changes requested, behind base'
    );
    expect(prIconLabel(5, { state: 'open', attention: 'ready', autoMerge: true, stale: true })).toBe(
      'PR #5 - Open: ready to merge, auto-merge on, last known'
    );
    expect(prIconLabel(7, { state: 'merged' })).toBe('PR #7 - Merged');
    const html = renderSidebar({ number: 42, state: 'open', attention: 'ciFailed' });
    expect(html).toContain('title="PR #42 - Open: CI failed"');
  });

  it('follows GitHub: open green, draft grey, queued amber, merged purple, closed red', () => {
    expect(prStateColor('open', 'light')).toBe('success.plainColor');
    expect(prStateColor('draft', 'light')).toBe('text.tertiary');
    expect(prStateColor('queued', 'light')).toBe('warning.plainColor');
    expect(prStateColor('queued', 'dark')).toBe('warning.plainColor');
    expect(prStateColor('merged', 'light')).toBe(MERGED_COLOR.light);
    expect(prStateColor('merged', 'dark')).toBe(MERGED_COLOR.dark);
    expect(prStateColor('closed', 'dark')).toBe('danger.plainColor');
  });

  it('colours a queued PR in the bar and its Queued to merge chip as warnings', () => {
    const html = renderBar('light', 'OPEN', false, true);
    expect(html).toContain('data-testid="pr-bar-queued-icon" data-pr-state="queued"');
    const chip = /<[^>]*data-testid="pr-bar-automerge-armed"[^>]*>/.exec(html)?.[0];
    expect(chip).toContain('data-queued="true"');
    expect(chip).toContain('MuiChip-colorWarning');
  });
});
