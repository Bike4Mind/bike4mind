import { describe, expect, it } from 'vitest';
import { createThinkFilter } from './thinkFilter';

function split(chunks: string[]): { text: string; reasoning: string } {
  const filter = createThinkFilter();
  const parts = [...chunks.map(chunk => filter.push(chunk)), filter.flush()];
  return { text: parts.map(part => part.text).join(''), reasoning: parts.map(part => part.reasoning).join('') };
}

const run = (chunks: string[]): string => split(chunks).text;

describe('createThinkFilter', () => {
  it('drops the empty spans an adaptive model opens on every round', () => {
    expect(run(['<think>', '</think>', '\n\nLooking at the rail.'])).toBe('\n\nLooking at the rail.');
  });

  it('moves the text between the markers to reasoning', () => {
    expect(split(['<think>', 'plan the ', 'page', '</think>', 'Here it is.'])).toEqual({
      text: 'Here it is.',
      reasoning: 'plan the page',
    });
  });

  it('holds a marker split across deltas until it resolves', () => {
    const filter = createThinkFilter();
    expect(filter.push('Done.<th')).toEqual({ text: 'Done.', reasoning: '' });
    expect(filter.push('ink>hidden</thi')).toEqual({ text: '', reasoning: 'hidden' });
    expect(filter.push('nk> Next.')).toEqual({ text: ' Next.', reasoning: '' });
  });

  it('releases a held tail that never became a marker', () => {
    const filter = createThinkFilter();
    expect(filter.push('a < b and <t').text).toBe('a < b and ');
    expect(filter.flush().text).toBe('<t');
  });

  it('keeps a nested span hidden to its matching close', () => {
    expect(run(['<think>outer<think>inner</think>tail</think>answer'])).toBe('answer');
  });

  it('treats a close with nothing open as text', () => {
    expect(run(['the </think> tag'])).toBe('the </think> tag');
  });

  it('hides an unclosed span to the end', () => {
    expect(run(['Answer.', '<think>', 'still going'])).toBe('Answer.');
  });
});
