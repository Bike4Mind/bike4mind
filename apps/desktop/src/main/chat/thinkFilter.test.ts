import { describe, expect, it } from 'vitest';
import { createThinkFilter } from './thinkFilter';

function run(chunks: string[]): string {
  const filter = createThinkFilter();
  return chunks.map(chunk => filter.push(chunk)).join('') + filter.flush();
}

describe('createThinkFilter', () => {
  it('drops the empty spans an adaptive model opens on every round', () => {
    expect(run(['<think>', '</think>', '\n\nLooking at the rail.'])).toBe('\n\nLooking at the rail.');
  });

  it('drops reasoning text between the markers', () => {
    expect(run(['<think>', 'plan the ', 'page', '</think>', 'Here it is.'])).toBe('Here it is.');
  });

  it('holds a marker split across deltas until it resolves', () => {
    const filter = createThinkFilter();
    expect(filter.push('Done.<th')).toBe('Done.');
    expect(filter.push('ink>hidden</thi')).toBe('');
    expect(filter.push('nk> Next.')).toBe(' Next.');
  });

  it('releases a held tail that never became a marker', () => {
    const filter = createThinkFilter();
    expect(filter.push('a < b and <t')).toBe('a < b and ');
    expect(filter.flush()).toBe('<t');
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
