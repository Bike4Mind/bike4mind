import { describe, expect, it } from 'vitest';
import {
  MAX_CHOICE_DESCRIPTION_LENGTH,
  MAX_CHOICE_LABEL_LENGTH,
  MAX_REPLY_CHOICES,
  REPLY_CHOICES_GUIDANCE,
  applyReplyChoices,
  expandChoiceKey,
  extractChoicesBlock,
  formatChoiceReply,
  formatChoicesBlock,
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
    expect(result).toEqual({ text: prose, choices: two, found: true, outcome: { status: 'parsed' } });
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
    expect(extractChoicesBlock(reply)).toEqual({
      text: reply,
      choices: null,
      found: false,
      outcome: { status: 'absent' },
    });
  });

  it('strips a valid block but keeps prose the model added after it', () => {
    // The guidance says the block must be the very last thing in the reply; when a model adds text
    // after it anyway, only the block goes, so the raw JSON never shows and no answer text is lost.
    const reply = `${prose}\n\n${block(JSON.stringify(two))}\n\nOne more thought.`;
    expect(extractChoicesBlock(reply)).toEqual({
      text: `${prose}\n\nOne more thought.`,
      choices: two,
      found: true,
      outcome: { status: 'parsed' },
    });
  });

  it('strips a case-drifted fence language tag', () => {
    const reply = `${prose}\n\n\`\`\`Choices\n${JSON.stringify(two)}\n\`\`\``;
    expect(extractChoicesBlock(reply)).toEqual({
      text: prose,
      choices: two,
      found: true,
      outcome: { status: 'parsed' },
    });
  });

  it('does not recognize a tilde fence (only backtick, matching the guidance)', () => {
    const reply = `${prose}\n\n~~~choices\n${JSON.stringify(two)}\n~~~`;
    expect(extractChoicesBlock(reply)).toEqual({
      text: reply,
      choices: null,
      found: false,
      outcome: { status: 'absent' },
    });
  });

  it('strips a block closed with a longer backtick fence without corrupting the options', () => {
    const reply = `${prose}\n\n\`\`\`choices\n${JSON.stringify(two)}\n\`\`\`\``;
    expect(extractChoicesBlock(reply)).toEqual({
      text: prose,
      choices: two,
      found: true,
      outcome: { status: 'parsed' },
    });
  });

  it('rejects options with duplicate labels, so no two buttons show the same text', () => {
    const duplicated = [two[0], { label: two[0].label, description: 'A different second option.' }];
    expect(extractChoicesBlock(block(JSON.stringify(duplicated))).choices).toBeNull();
  });

  it('rejects an explicit empty options array', () => {
    expect(extractChoicesBlock(block(JSON.stringify({ options: [] }))).choices).toBeNull();
  });

  it('rejects a block whose options field is not an array', () => {
    expect(extractChoicesBlock(block(JSON.stringify({ options: 'nope' }))).choices).toBeNull();
  });

  it('strips a fence indented inside a list item', () => {
    const reply = `${prose}\n\n  ${block(JSON.stringify(two))}`;
    expect(extractChoicesBlock(reply)).toEqual({
      text: prose,
      choices: two,
      found: true,
      outcome: { status: 'parsed' },
    });
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
      outcome: { status: 'invalid', reason: 'json' },
    });
  });

  it('strips an empty block', () => {
    expect(extractChoicesBlock(`${prose}\n\n\`\`\`choices\n\`\`\``)).toEqual({
      text: prose,
      choices: null,
      found: true,
      outcome: { status: 'invalid', reason: 'json' },
    });
  });

  it('strips an unterminated trailing block from a truncated reply', () => {
    const reply = `${prose}\n\n\`\`\`choices\n{"options":[{"label":"Refor`;
    expect(extractChoicesBlock(reply)).toEqual({
      text: prose,
      choices: null,
      found: true,
      outcome: { status: 'invalid', reason: 'unterminated' },
    });
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

  it('treats a choices sample nested in a longer outer fence as content', () => {
    const reply = `Here is the format:\n\n\`\`\`\`markdown\n${block(JSON.stringify(two))}\n\`\`\`\`\n\nThat is all.`;
    expect(extractChoicesBlock(reply)).toEqual({
      text: reply,
      choices: null,
      found: false,
      outcome: { status: 'absent' },
    });
  });

  it('treats a choices sample nested in a tilde fence as content', () => {
    const reply = `Here is the format:\n\n~~~\n${block(JSON.stringify(two))}\n~~~`;
    expect(extractChoicesBlock(reply)).toEqual({
      text: reply,
      choices: null,
      found: false,
      outcome: { status: 'absent' },
    });
  });

  it('ignores a block drafted inside reasoning and keeps the answer after it', () => {
    const reply = `<think>Maybe offer options:\n${block(JSON.stringify(two))}\nNo, one answer is enough.</think>Here is the full answer.`;
    expect(extractChoicesBlock(reply)).toEqual({
      text: reply,
      choices: null,
      found: false,
      outcome: { status: 'absent' },
    });
  });

  it('ignores a block inside reasoning that is still streaming', () => {
    const reply = `<think>Maybe offer options:\n${block(JSON.stringify(two))}\nor not`;
    expect(extractChoicesBlock(reply)).toEqual({
      text: reply,
      choices: null,
      found: false,
      outcome: { status: 'invalid', reason: 'think_unclosed' },
    });
  });

  it('ignores an answer block while reasoning has reopened after it', () => {
    const reply = `<think>a</think>${prose}\n\n${block(JSON.stringify(two))}<think>more`;
    expect(extractChoicesBlock(reply)).toEqual({
      text: reply,
      choices: null,
      found: false,
      outcome: { status: 'invalid', reason: 'think_unclosed' },
    });
  });

  it('strips a block after the reasoning and keeps the reasoning byte-for-byte', () => {
    const reasoning = `<think>Draft:\n${block('{"options":[]}')}\n  trailing space  </think>`;
    const result = extractChoicesBlock(`${reasoning}${prose}\n\n${block(JSON.stringify(two))}`);
    expect(result).toEqual({ text: `${reasoning}${prose}`, choices: two, found: true, outcome: { status: 'parsed' } });
  });

  it('does not let a marker-shaped string inside reasoning end it early', () => {
    const reply = `<think>outer<think>inner</think>${block(JSON.stringify(two))}</think>The answer.`;
    expect(extractChoicesBlock(reply)).toEqual({
      text: reply,
      choices: null,
      found: false,
      outcome: { status: 'absent' },
    });
  });

  it('handles CRLF line endings', () => {
    const reply = `${prose}\r\n\r\n\`\`\`choices\r\n${JSON.stringify(two)}\r\n\`\`\`\r\n`;
    expect(extractChoicesBlock(reply)).toEqual({
      text: prose,
      choices: two,
      found: true,
      outcome: { status: 'parsed' },
    });
  });
});

describe('extractChoicesBlock outcome', () => {
  it.each([
    ['json', '{not json'],
    ['shape', JSON.stringify({ options: 'nope' })],
    ['shape', JSON.stringify([two[0], 'second'])],
    ['shape', JSON.stringify([two[0], { label: 'Extend' }])],
    ['label_length', JSON.stringify([two[0], { label: 'x'.repeat(MAX_CHOICE_LABEL_LENGTH + 1), description: 'd' }])],
    ['label_length', JSON.stringify([two[0], { label: ' ', description: 'd' }])],
    [
      'description_length',
      JSON.stringify([two[0], { label: 'Long', description: 'd'.repeat(MAX_CHOICE_DESCRIPTION_LENGTH + 1) }]),
    ],
    ['duplicate_label', JSON.stringify([two[0], { label: two[0].label, description: 'Another.' }])],
    ['too_few', JSON.stringify([two[0]])],
  ])('reports %s', (reason, body) => {
    const result = extractChoicesBlock(`${prose}\n\n${block(body)}`);
    expect(result).toEqual({ text: prose, choices: null, found: true, outcome: { status: 'invalid', reason } });
  });

  it('reports unterminated for a block cut off at the end', () => {
    const result = extractChoicesBlock(`${prose}\n\n\`\`\`choices\n{"options":[`);
    expect(result.outcome).toEqual({ status: 'invalid', reason: 'unterminated' });
  });

  it('reports think_unclosed for a block inside reasoning that never closed', () => {
    const result = extractChoicesBlock(`<think>${prose}\n\n${block(JSON.stringify(two))}`);
    expect(result.outcome).toEqual({ status: 'invalid', reason: 'think_unclosed' });
    expect(result.found).toBe(false);
  });

  it('reports absent for unclosed reasoning with no block in it', () => {
    expect(extractChoicesBlock('<think>still thinking').outcome).toEqual({ status: 'absent' });
  });
});

describe('formatChoicesBlock', () => {
  it('round-trips through extractChoicesBlock', () => {
    const result = extractChoicesBlock(prose + formatChoicesBlock(two));
    expect(result).toEqual({ text: prose, choices: two, found: true, outcome: { status: 'parsed' } });
  });

  it('writes the exact guidance format', () => {
    expect(formatChoicesBlock(two)).toBe('\n\n```choices\n' + JSON.stringify({ options: two }) + '\n```');
  });

  it('emits only label and description', () => {
    const extra = two.map(o => ({ ...o, selectedIndex: 1, secret: 'x' }));
    expect(formatChoicesBlock(extra)).toBe(formatChoicesBlock(two));
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
  it('strips every slot but reads options only from the last answer slot', () => {
    const other = [
      { label: 'A', description: 'a' },
      { label: 'B', description: 'b' },
    ];
    const first = `${prose}\n\n${block(JSON.stringify(two))}`;
    const result = stripChoicesFromReplies([first, `${prose}\n\n${block(JSON.stringify(other))}`, '  ']);
    expect(result).toEqual({
      replies: [prose, prose, '  '],
      choices: other,
      found: true,
      outcome: { status: 'parsed' },
    });
  });

  it('takes the answer slot block over a draft in a separate reasoning slot', () => {
    const real = [
      { label: 'X', description: 'x' },
      { label: 'Y', description: 'y' },
    ];
    const reasoning = `<think>Draft:\n${block(JSON.stringify(two))}\n</think>`;
    const result = stripChoicesFromReplies([reasoning, `${prose}\n\n${block(JSON.stringify(real))}`]);
    expect(result).toEqual({ replies: [reasoning, prose], choices: real, found: true, outcome: { status: 'parsed' } });
  });

  it('gives no options when the last answer slot has none, even if an earlier one does', () => {
    const earlier = `${prose}\n\n${block(JSON.stringify(two))}`;
    const result = stripChoicesFromReplies([earlier, 'Final answer.']);
    expect(result).toEqual({
      replies: [prose, 'Final answer.'],
      choices: null,
      found: false,
      outcome: { status: 'absent' },
    });
  });

  it('strips an earlier slot block when the final slot has none', () => {
    const result = stripChoicesFromReplies([`Answer A\n\n${block(JSON.stringify({ options: two }))}`, '**Result: B**']);
    expect(result.replies).toEqual(['Answer A', '**Result: B**']);
    expect(result.replies.join('')).not.toContain('```choices');
    expect(result.choices).toBeNull();
  });

  it('returns the slots untouched when none carries a block', () => {
    expect(stripChoicesFromReplies(['a', 'b'])).toEqual({
      replies: ['a', 'b'],
      choices: null,
      found: false,
      outcome: { status: 'absent' },
    });
  });

  /**
   * Regression for the chat error path: a stream can fail right as the model is mid-choices-block
   * (overload, timeout, dropped connection). The error handler appends its own message as a new
   * slot and joins everything with no separator. If the choices block were left in place, an
   * unterminated block would "absorb" the error message as part of itself, and once the error is
   * the last slot the earlier slot's block is no longer read, leaking the raw JSON. Stripping with
   * stripChoicesFromReplies before the error joins it - which is what the error path does - avoids
   * both: there is no block left for extractChoicesBlock to misread at render/export time.
   */
  it('strips a mid-stream block before an error message is appended, so neither is lost', () => {
    const unterminated = `${prose}\n\n\`\`\`choices\n{"options":[{"label":"Refor`;
    const closed = `${prose}\n\n${block(JSON.stringify(two))}`;
    const error = 'Sorry, something went wrong while generating a response. Please try again.';

    for (const streamedSlot of [unterminated, closed]) {
      const { replies: stripped } = stripChoicesFromReplies([streamedSlot]);
      const finalText = [...stripped, error].join('');
      expect(finalText).toBe(`${prose}${error}`);
      // The already-clean text must not get mangled by a second extractChoicesBlock pass
      // (extractReplies on the client re-runs it while a reply is still streaming).
      expect(extractChoicesBlock(finalText)).toEqual({
        text: finalText,
        choices: null,
        found: false,
        outcome: { status: 'absent' },
      });
    }
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

  it('never persists a draft from reasoning in place of the answer', () => {
    const reasoning = `<think>Maybe offer options:\n${block(JSON.stringify(two))}\nNo, one answer is enough.</think>`;
    const answer = 'Here is the full answer.';
    const quest: Parameters<typeof applyReplyChoices>[0] = { reply: reasoning + answer, replies: [reasoning, answer] };
    applyReplyChoices(quest);
    expect(quest).toEqual({ reply: reasoning + answer, replies: [reasoning, answer], suggestedChoices: undefined });
  });

  it('returns parsed when options were stored', () => {
    const withBlock = `${prose}\n\n${block(JSON.stringify(two))}`;
    expect(applyReplyChoices({ reply: withBlock, replies: [withBlock] })).toEqual({ status: 'parsed' });
  });

  it('returns absent when the answer has no block', () => {
    expect(applyReplyChoices({ reply: prose, replies: [prose] })).toEqual({ status: 'absent' });
  });

  it('returns the invalid reason for a block that failed validation', () => {
    const withBad = `${prose}\n\n${block(JSON.stringify([two[0]]))}`;
    const quest: Parameters<typeof applyReplyChoices>[0] = { reply: withBad, replies: [withBad] };
    expect(applyReplyChoices(quest)).toEqual({ status: 'invalid', reason: 'too_few' });
    expect(quest).toEqual({ reply: prose, replies: [prose], suggestedChoices: undefined });
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
