import { describe, expect, it } from 'vitest';
import {
  escapeSlackCode,
  escapeSlackLine,
  escapeSlackText,
  neutralizeSlackBroadcastMentions,
  neutralizeSlackBroadcastMentionsDeep,
} from './slackText';

describe('escapeSlackText', () => {
  it('neutralizes mentions and links', () => {
    expect(escapeSlackText('<!channel> see <https://x.test|y>')).toBe('&lt;!channel&gt; see &lt;https://x.test|y&gt;');
  });

  it('escapes ampersand before angle brackets so nothing double-encodes', () => {
    expect(escapeSlackText('a & <b>')).toBe('a &amp; &lt;b&gt;');
  });

  it('keeps line breaks and emphasis characters', () => {
    expect(escapeSlackText('*bold*\nsnake_case')).toBe('*bold*\nsnake_case');
  });
});

describe('escapeSlackLine', () => {
  it('collapses every line terminator to a space', () => {
    expect(escapeSlackLine('a\r\nb\nc\td\u2028e')).toBe('a b c d e');
  });

  it('escapes like escapeSlackText', () => {
    expect(escapeSlackLine('<@U123>')).toBe('&lt;@U123&gt;');
  });
});

describe('escapeSlackCode', () => {
  it('replaces backticks so the value cannot close its code span', () => {
    expect(escapeSlackCode('a` <!here> `b')).toBe('a\u02CB &lt;!here&gt; \u02CBb');
  });

  it('collapses line breaks', () => {
    expect(escapeSlackCode('src/a.ts\nsrc/b.ts')).toBe('src/a.ts src/b.ts');
  });
});

describe('neutralizeSlackBroadcastMentions', () => {
  const ZWSP = '\u200B';

  it.each([
    ['<!channel> deploy done', `@${ZWSP}channel deploy done`],
    ['<!here|here> ping', `@${ZWSP}here ping`],
    ['<!EVERYONE>', `@${ZWSP}everyone`],
    ['<!group> legacy', `@${ZWSP}group legacy`],
    ['team <!subteam^S0123ABC|@oncall> look', `team @${ZWSP}oncall look`],
    ['<!subteam^S0123ABC>', `@${ZWSP}group`],
    ['@channel and @here and @everyone', `@${ZWSP}channel and @${ZWSP}here and @${ZWSP}everyone`],
    ['(@here)', `(@${ZWSP}here)`],
  ])('neutralizes %j', (input, expected) => {
    expect(neutralizeSlackBroadcastMentions(input)).toBe(expected);
  });

  it('leaves user mentions, links, emails and other words alone', () => {
    const text = 'cc <@U0123ABC> see <https://example.com|docs> mail ops@here.example @channels @heretic';
    expect(neutralizeSlackBroadcastMentions(text)).toBe(text);
  });

  it('replaces rich_text broadcast and usergroup elements with inert text, keeping user elements', () => {
    const blocks = [
      {
        type: 'rich_text',
        elements: [
          {
            type: 'rich_text_section',
            elements: [
              { type: 'broadcast', range: 'everyone' },
              { type: 'broadcast', range: 'channel' },
              { type: 'broadcast', range: 'here' },
              { type: 'usergroup', usergroup_id: 'S0123ABC' },
              { type: 'user', user_id: 'U0123ABC' },
              { type: 'text', text: ' <!here> done' },
            ],
          },
        ],
      },
    ];
    expect(neutralizeSlackBroadcastMentionsDeep(blocks)).toEqual([
      {
        type: 'rich_text',
        elements: [
          {
            type: 'rich_text_section',
            elements: [
              { type: 'text', text: `@${ZWSP}everyone` },
              { type: 'text', text: `@${ZWSP}channel` },
              { type: 'text', text: `@${ZWSP}here` },
              { type: 'text', text: `@${ZWSP}group` },
              { type: 'user', user_id: 'U0123ABC' },
              { type: 'text', text: ` @${ZWSP}here done` },
            ],
          },
        ],
      },
    ]);
  });

  it('walks every string in a Block Kit structure without touching other values', () => {
    const blocks = [
      { type: 'section', text: { type: 'mrkdwn', text: '<!channel> shipped' } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: '@here v1.2' }], count: 3, flag: true },
    ];
    expect(neutralizeSlackBroadcastMentionsDeep(blocks)).toEqual([
      { type: 'section', text: { type: 'mrkdwn', text: `@${ZWSP}channel shipped` } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `@${ZWSP}here v1.2` }], count: 3, flag: true },
    ]);
  });
});

describe('neutralizeSlackBroadcastMentions in URLs', () => {
  it('leaves a URL path segment that looks like a broadcast word intact', () => {
    const link = '<https://social.test/@everyone|profile>';
    expect(neutralizeSlackBroadcastMentions(link)).toBe(link);
  });

  it('leaves url and image_url values untouched in blocks while still neutralizing their text', () => {
    const blocks = [
      { type: 'image', image_url: 'https://cdn.test/@here.png', alt_text: '@here' },
      {
        type: 'rich_text',
        elements: [
          { type: 'rich_text_section', elements: [{ type: 'link', url: 'https://x.test/@channel', text: '@channel' }] },
        ],
      },
    ];
    const [image, richText] = neutralizeSlackBroadcastMentionsDeep(blocks) as [
      { image_url: string; alt_text: string },
      { elements: [{ elements: [{ url: string; text: string }] }] },
    ];
    expect(image.image_url).toBe('https://cdn.test/@here.png');
    expect(image.alt_text).toBe('@​here');
    expect(richText.elements[0].elements[0].url).toBe('https://x.test/@channel');
    expect(richText.elements[0].elements[0].text).toBe('@​channel');
  });
});
