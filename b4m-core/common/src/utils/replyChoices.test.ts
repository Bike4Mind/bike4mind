import { describe, expect, it } from 'vitest';
import {
  MAX_CHOICE_LABEL_LENGTH,
  MAX_REPLY_CHOICES,
  extractChoicesBlock,
  formatChoiceReply,
  parseChoiceKey,
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
