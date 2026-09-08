import { describe, it, expect } from 'vitest';

import { escapeSlackText, slackLink, slackMention } from './slackMarkup';

describe('slackMention - notifying form by id type', () => {
  it('uses <@...> for a user id (U/W)', () => {
    expect(slackMention('U0WESCARD')).toBe('<@U0WESCARD>');
    expect(slackMention('W0BOTUSER')).toBe('<@W0BOTUSER>');
  });

  it('uses the subteam form for a user-group id (S), which is what actually notifies', () => {
    // <@S...> would render as inert text and ping nobody - the role-roster gate would
    // then look wired while silently notifying no one.
    expect(slackMention('S0REVIEWERS')).toBe('<!subteam^S0REVIEWERS>');
  });
});

describe('slackLink / escapeSlackText', () => {
  it('escapes reserved characters in the label and url', () => {
    expect(slackLink('https://x.test/a?b=1&c=2', '#1 <ping>')).toBe('<https://x.test/a?b=1&amp;c=2|#1 &lt;ping&gt;>');
  });

  it('escapes ampersand before angle brackets so nothing double-encodes', () => {
    expect(escapeSlackText('a & <b>')).toBe('a &amp; &lt;b&gt;');
  });
});
