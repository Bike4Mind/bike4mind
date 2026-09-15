import { SUBQUEST_STATUS_VALUES, type SubQuestStatus } from '@bike4mind/common';
import { describe, expect, it } from 'vitest';
import {
  SUBQUEST_STATUS_ICONS,
  SUBQUEST_STATUS_LABELS,
  getSubQuestStatusIcon,
  getSubQuestStatusLabel,
} from '../subQuestStatusPresentation';

describe('sub-quest status presentation', () => {
  it('has a glyph and a label for every canonical status', () => {
    for (const status of SUBQUEST_STATUS_VALUES) {
      expect(getSubQuestStatusIcon(status)).not.toBe('');
      expect(getSubQuestStatusLabel(status)).not.toBe(status);
    }
  });

  it('renders a glyph for deleted - the one disclosed behaviour change in this PR', () => {
    // The server-side queued export previously ran a switch with no `deleted` arm, so a deleted
    // sub-quest exported with no icon there while the client export rendered one. Both now read
    // this module, so the two cannot disagree.
    expect(getSubQuestStatusIcon('deleted')).toBe(' ❌');
  });

  it('is total for a token that names an Object.prototype member', () => {
    // A plain object literal inherits from Object.prototype, so `ICONS[status] ?? ''` returned the
    // inherited FUNCTION for these and spliced it into an exported markdown heading. Object.hasOwn
    // is what makes the fallback actually fire.
    for (const hostile of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
      const icon = getSubQuestStatusIcon(hostile as SubQuestStatus);
      const label = getSubQuestStatusLabel(hostile as SubQuestStatus);
      expect(icon).toBe('');
      expect(label).toBe(hostile);
      expect(typeof icon).toBe('string');
      expect(typeof label).toBe('string');
    }
  });

  it('falls back to the raw token as its own label rather than mislabelling it', () => {
    expect(getSubQuestStatusLabel('in-progress' as SubQuestStatus)).toBe('in-progress');
    expect(getSubQuestStatusIcon('in-progress' as SubQuestStatus)).toBe('');
  });

  it('keeps both maps exhaustive over the canonical enum', () => {
    expect(Object.keys(SUBQUEST_STATUS_ICONS).sort()).toEqual([...SUBQUEST_STATUS_VALUES].sort());
    expect(Object.keys(SUBQUEST_STATUS_LABELS).sort()).toEqual([...SUBQUEST_STATUS_VALUES].sort());
  });
});
