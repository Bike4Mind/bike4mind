import { describe, expect, it } from 'vitest';
import {
  MAX_CHOICE_LABEL_LENGTH,
  MAX_REPLY_CHOICES,
  REPLY_CHOICES_GUIDANCE,
  applyReplyChoices,
  expandChoiceKey,
  extractChoicesBlock,
  formatChoiceReply,
  parseChoiceKey,
  stripChoicesFromReplies,
} from './replyChoices';

const two = [
  { label: 'Reformulate', description: 'Re-formulate with all three pools.' },
  { label: 'Extend', description: 'Extend the loaded brief.' },
];
const block = (body: string) => '```choices\n' + body + '\n```';
const prose = 'Next steps, your call:\n1. Reformulate.\n2. Extend.';

describe('extractChoicesBlock', () => {
  it('strips a trailing block and returns its options', () => {
    const result = extractChoicesBlock(`${prose}\n\n${block(JSON.stringify({ options: two }))}\n`);
    expect(result).toEqual({ text: prose, choices: two, found: true });
  });

  it('accepts a bare array body', () => {
    expect(extractChoicesBlock(`${prose}\n\n${block(JSON.stringify(two))}`).choices).toEqual(two);
  });

  it('trims label and description whitespace', () => {
    const padded = two.map(o => ({ label: `  ${o.label} `, description: ` ${o.description}  ` }));
    expect(extractChoicesBlock(block(JSON.stringify(padded))).choices).toEqual(two);
  });

  it('leaves a reply without a block unchanged', () => {
    const reply = `${prose}\n\n`;
    expect(extractChoicesBlock(reply)).toEqual({ text: reply, choices: null, found: false });
  });

  it('leaves a block that is followed by more content alone', () => {
    const reply = `${prose}\n\n${block(JSON.stringify(two))}\n\nOne more thought.`;
    expect(extractChoicesBlock(reply)).toEqual({ text: reply, choices: null, found: false });
  });

  it('uses only the last block when there are two', () => {
    const first = block(
      JSON.stringify([
        { label: 'Old', description: 'x' },
        { label: 'Older', description: 'y' },
      ])
    );
    const reply = `${first}\n\n${prose}\n\n${block(JSON.stringify(two))}`;
    const result = extractChoicesBlock(reply);
    expect(result.choices).toEqual(two);
    expect(result.text).toBe(`${first}\n\n${prose}`);
  });

  it('ignores other fence languages', () => {
    const reply = `${prose}\n\n\`\`\`json\n${JSON.stringify(two)}\n\`\`\``;
    expect(extractChoicesBlock(reply).found).toBe(false);
  });

  it('strips a malformed block without returning options', () => {
    expect(extractChoicesBlock(`${prose}\n\n${block('{not json')}`)).toEqual({
      text: prose,
      choices: null,
      found: true,
    });
  });

  it('strips an empty block', () => {
    expect(extractChoicesBlock(`${prose}\n\n\`\`\`choices\n\`\`\``)).toEqual({
      text: prose,
      choices: null,
      found: true,
    });
  });

  it('strips an unterminated trailing block from a truncated reply', () => {
    const reply = `${prose}\n\n\`\`\`choices\n{"options":[{"label":"Refor`;
    expect(extractChoicesBlock(reply)).toEqual({ text: prose, choices: null, found: true });
  });

  it('rejects the whole block when any option is invalid, so numbering never shifts', () => {
    const tooLong = [two[0], { label: 'x'.repeat(MAX_CHOICE_LABEL_LENGTH + 1), description: 'd' }];
    const missing = [two[0], { label: 'Extend' }];
    const blank = [two[0], { label: ' ', description: 'd' }];
    for (const options of [tooLong, missing, blank]) {
      expect(extractChoicesBlock(block(JSON.stringify({ options }))).choices).toBeNull();
    }
  });

  it('rejects fewer than two options', () => {
    expect(extractChoicesBlock(block(JSON.stringify([two[0]]))).choices).toBeNull();
  });

  it('clips to the maximum, keeping the leading options so their numbers still match', () => {
    const many = Array.from({ length: MAX_REPLY_CHOICES + 2 }, (_, i) => ({ label: `L${i}`, description: `D${i}` }));
    expect(extractChoicesBlock(block(JSON.stringify(many))).choices).toEqual(many.slice(0, MAX_REPLY_CHOICES));
  });

  it('handles CRLF line endings', () => {
    const reply = `${prose}\r\n\r\n\`\`\`choices\r\n${JSON.stringify(two)}\r\n\`\`\`\r\n`;
    expect(extractChoicesBlock(reply)).toEqual({ text: prose, choices: two, found: true });
  });
});

describe('parseChoiceKey', () => {
  it.each(['2', ' 2 ', '2.', '2)', '#2', '# 2'])('reads %j as the second option', input => {
    expect(parseChoiceKey(input, 3)).toBe(1);
  });

  it.each(['0', '4', '12', '2 but keep the caps', 'two', ''])('returns null for %j', input => {
    expect(parseChoiceKey(input, 3)).toBeNull();
  });
});

describe('formatChoiceReply', () => {
  it('sends exactly the label and description the user saw', () => {
    expect(formatChoiceReply(two[0])).toBe('Reformulate: Re-formulate with all three pools.');
  });
});

describe('stripChoicesFromReplies', () => {
  it('strips every slot and takes options from the first valid block', () => {
    const other = [
      { label: 'A', description: 'a' },
      { label: 'B', description: 'b' },
    ];
    const result = stripChoicesFromReplies([
      `${prose}\n\n${block('{bad')}`,
      `${prose}\n\n${block(JSON.stringify(two))}`,
      `${prose}\n\n${block(JSON.stringify(other))}`,
    ]);
    expect(result).toEqual({ replies: [prose, prose, prose], choices: two, found: true });
  });

  it('returns the slots untouched when none carries a block', () => {
    expect(stripChoicesFromReplies(['a', 'b'])).toEqual({ replies: ['a', 'b'], choices: null, found: false });
  });
});

describe('REPLY_CHOICES_GUIDANCE', () => {
  it('shows the model a block in the exact shape the parser reads', () => {
    const example = REPLY_CHOICES_GUIDANCE.match(/```choices\n(.*)\n```/)?.[1] ?? '';
    const parsed = JSON.parse(example) as { options: Array<{ label: string; description: string }> };
    expect(parsed.options[0]).toEqual({ label: expect.any(String), description: expect.any(String) });
  });
});

describe('applyReplyChoices', () => {
  it('strips the block from replies and reply and sets the options', () => {
    const withBlock = `${prose}\n\n${block(JSON.stringify(two))}`;
    const quest: Parameters<typeof applyReplyChoices>[0] = { reply: withBlock, replies: [withBlock] };
    applyReplyChoices(quest);
    expect(quest).toEqual({ reply: prose, replies: [prose], suggestedChoices: { options: two } });
  });

  it('clears choices left over from an earlier answer to the same turn', () => {
    const quest: Parameters<typeof applyReplyChoices>[0] = {
      reply: null,
      replies: [prose],
      suggestedChoices: { options: two, selectedIndex: 0 },
    };
    applyReplyChoices(quest);
    expect(quest.suggestedChoices).toBeUndefined();
    expect(quest.replies).toEqual([prose]);
  });
});

describe('expandChoiceKey', () => {
  it('expands a bare key into the option text the button would send', () => {
    expect(expandChoiceKey('2', { options: two })).toEqual({
      prompt: 'Extend: Extend the loaded brief.',
      pickedIndex: 1,
    });
  });

  it.each([
    ['a longer prompt', '2 but keep the caps', { options: two }],
    ['no open choices', '2', undefined],
    ['an already-picked set', '2', { options: two, selectedIndex: 0 }],
    ['an out-of-range key', '3', { options: two }],
  ])('passes %s through untouched', (_, prompt, choices) => {
    expect(expandChoiceKey(prompt, choices)).toEqual({ prompt, pickedIndex: null });
  });
});
