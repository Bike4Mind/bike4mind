import { describe, expect, it } from 'vitest';
import {
  MAX_SLACK_MESSAGE_BLOCKS_DEPTH,
  MAX_SLACK_MESSAGE_USER_MENTIONS,
  SlackMessageRequestSchema,
  countSlackUserMentions,
  findSlackApiPostBlocksProblem,
} from './slackMessagesApi';

const section = (text: string, extra: Record<string, unknown> = {}) => ({
  type: 'section',
  text: { type: 'mrkdwn', text },
  ...extra,
});

describe('findSlackApiPostBlocksProblem', () => {
  it('accepts layout and content blocks, image accessories and rich_text links', () => {
    const blocks = [
      { type: 'header', text: { type: 'plain_text', text: 'Shipped' } },
      section('*v1.2*', { accessory: { type: 'image', image_url: 'https://example.com/a.png', alt_text: 'a' } }),
      { type: 'divider' },
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'by ci' }] },
      { type: 'image', image_url: 'https://example.com/b.png', alt_text: 'b' },
      {
        type: 'rich_text',
        elements: [
          { type: 'rich_text_section', elements: [{ type: 'link', url: 'https://example.com/pr/1', text: 'PR' }] },
        ],
      },
    ];
    expect(findSlackApiPostBlocksProblem(blocks)).toBeNull();
  });

  it.each([
    ['an actions block', [{ type: 'actions', elements: [] }]],
    ['an input block', [{ type: 'input', element: { type: 'plain_text_input' } }]],
    [
      'a button accessory',
      [section('View logs', { accessory: { type: 'button', text: { type: 'plain_text', text: 'x' } } })],
    ],
    [
      'a forged SRE approval button',
      [section('View logs', { accessory: { type: 'button', action_id: 'sre_approve_fix', value: 'tracking-1' } })],
    ],
    [
      'an action_id anywhere',
      [{ type: 'context', elements: [{ type: 'mrkdwn', text: 'x', action_id: 'set_default_notebook' }] }],
    ],
    [
      'a url outside a rich_text link',
      [section('x', { accessory: { type: 'image', image_url: 'https://e.com/a', url: 'https://evil.example' } })],
    ],
    ['a confirm dialog', [section('x', { confirm: { title: 'Sure?' } })]],
    ['a select nested in rich_text', [{ type: 'rich_text', elements: [{ type: 'static_select' }] }]],
    ['an unknown block type', [{ type: 'video' }]],
  ])('refuses %s', (_label, blocks) => {
    expect(findSlackApiPostBlocksProblem(blocks)).not.toBeNull();
  });

  it('refuses nesting past the depth ceiling without recursing', () => {
    let deep: unknown = 'x';
    for (let i = 0; i < 20_000; i++) deep = [deep];
    expect(findSlackApiPostBlocksProblem([{ type: 'section', text: deep }])).toMatch(/nest at most/);

    let ok: unknown = 'x';
    for (let i = 0; i < MAX_SLACK_MESSAGE_BLOCKS_DEPTH - 2; i++) ok = [ok];
    expect(findSlackApiPostBlocksProblem([{ type: 'section', fields: ok }])).toBeNull();
  });

  it('refuses too many values', () => {
    const fields = Array.from({ length: 6000 }, () => 1);
    expect(findSlackApiPostBlocksProblem([{ type: 'section', fields }])).toMatch(/at most/);
  });
});

describe('SlackMessageRequestSchema', () => {
  it('fails validation (not a crash) for a deeply nested body', () => {
    let deep: unknown = 'x';
    for (let i = 0; i < 20_000; i++) deep = [deep];
    const result = SlackMessageRequestSchema.safeParse({
      channel_id: 'C0123ABCDEF',
      text: 'hi',
      blocks: [{ type: 'section', text: deep }],
    });
    expect(result.success).toBe(false);
  });
});

describe('user mention cap', () => {
  const mentions = (count: number, offset = 0) =>
    Array.from({ length: count }, (_, i) => `<@U${String(i + offset).padStart(9, '0')}>`).join(' ');

  it('counts distinct users across text, block strings and rich_text user elements', () => {
    const blocks = [
      section('<@U000000001> and <@u000000001|ada>'),
      {
        type: 'rich_text',
        elements: [{ type: 'rich_text_section', elements: [{ type: 'user', user_id: 'U000000002' }] }],
      },
    ];
    expect(countSlackUserMentions('<@U000000001> <@W000000003>', blocks)).toBe(3);
  });

  it(`accepts ${MAX_SLACK_MESSAGE_USER_MENTIONS} distinct mentions and refuses one more, wherever it is`, () => {
    const base = { channel_id: 'C0123ABCDEF' };
    expect(
      SlackMessageRequestSchema.safeParse({ ...base, text: mentions(MAX_SLACK_MESSAGE_USER_MENTIONS) }).success
    ).toBe(true);
    expect(
      SlackMessageRequestSchema.safeParse({ ...base, text: mentions(MAX_SLACK_MESSAGE_USER_MENTIONS + 1) }).success
    ).toBe(false);
    const split = SlackMessageRequestSchema.safeParse({
      ...base,
      text: mentions(MAX_SLACK_MESSAGE_USER_MENTIONS),
      blocks: [section(mentions(1, MAX_SLACK_MESSAGE_USER_MENTIONS))],
    });
    expect(split.success).toBe(false);
  });
});
