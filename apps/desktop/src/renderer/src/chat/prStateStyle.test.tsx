import { describe, expect, it } from 'vitest';
import { MERGED_COLOR, prStateColor } from './prStateStyle';
import { STATES, renderBar, renderSidebar } from './prRenderSupport';

const iconColor = (html: string) => /data-pr-state="[a-z]+" data-pr-color="([^"]+)"/.exec(html)?.[1];

describe('PR state colour', () => {
  it.each(['light', 'dark'] as const)('is the same in the bar and the sidebar for every state (%s)', mode => {
    for (const { display, state, isDraft } of STATES) {
      const bar = renderBar(mode, state, isDraft);
      const sidebar = renderSidebar({ number: 611, state: display }, 'done', mode);
      expect(bar).toContain(`data-testid="pr-bar-${display}-icon" data-pr-state="${display}"`);
      expect(sidebar).toContain(`data-session-pr-state="${display}"`);
      expect(iconColor(bar)).toBe(prStateColor(display, mode));
      expect(iconColor(sidebar)).toBe(iconColor(bar));
    }
  });

  it('follows GitHub: open green, draft grey, merged purple, closed red', () => {
    expect(prStateColor('open', 'light')).toBe('success.plainColor');
    expect(prStateColor('draft', 'light')).toBe('text.tertiary');
    expect(prStateColor('merged', 'light')).toBe(MERGED_COLOR.light);
    expect(prStateColor('merged', 'dark')).toBe(MERGED_COLOR.dark);
    expect(prStateColor('closed', 'dark')).toBe('danger.plainColor');
  });
});
