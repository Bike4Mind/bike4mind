/**
 * Gears - long-form copy, shared by the Tutorials detail view and the Gears one.
 *
 * Sits beside presentation.ts on purpose: that file holds the sentence a card
 * shows, this one holds the paragraphs behind it, and both are keyed by gear so
 * neither surface keeps a second copy that can drift.
 *
 * Every section is optional. A missing one is not rendered, so a feature can be
 * filled in a section at a time rather than needing all four to be worth showing.
 */

export interface GearDetail {
  whatItDoes?: string;
  whyItWorks?: string;
  whenToUse?: string;
  gotchas?: string;
}

const GEAR_DETAIL: Record<string, GearDetail> = {
  mementos: {
    whatItDoes:
      'Mementos are short facts the app keeps about you and your work - what you are building, who you work with, how you like things done. They are written after a conversation ends and read at the start of the next one, so you stop re-explaining your context every time.',
    whyItWorks:
      'Each chat starts with no knowledge of the last one. Mementos are a small, readable set of notes that get loaded in first, which is why they hold durable things and not the details of a single task. A fact worth keeping is one that would still be true next month.',
    whenToUse:
      'Leave it on if you use the app for ongoing work - the same project, the same codebase, the same team. The value compounds as the notes build up. Turn it off for one-off or sensitive work. Nothing is written while it is off, and you can delete individual mementos at any time.',
    gotchas:
      'Mementos are not a transcript. They will not recall what you said in a specific chat, only the facts saved from it. If something matters, say it plainly - a passing mention may not be kept.',
  },
};

/**
 * Detail copy for a feature.
 *
 * `authored` is false while the paragraphs are still to be written: the view
 * then shows the gear's one-sentence intro and says outright that the rest is
 * coming, which is more honest than filler at the right length.
 */
export function gearDetailFor(item: { key: string; intro: string }): GearDetail & { authored: boolean } {
  const detail = GEAR_DETAIL[item.key];
  return {
    ...detail,
    whatItDoes: detail?.whatItDoes ?? item.intro,
    authored: !!detail,
  };
}
