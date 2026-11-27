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

describe('createThinkFilter starting in reasoning', () => {
  function prefilled(chunks: string[]): { text: string; reasoning: string } {
    const filter = createThinkFilter({ startInReasoning: true });
    const parts = [...chunks.map(chunk => filter.push(chunk)), filter.flush()];
    return { text: parts.map(part => part.text).join(''), reasoning: parts.map(part => part.reasoning).join('') };
  }

  it('treats text before the first close as reasoning and consumes the close', () => {
    expect(prefilled(['Okay, the user ', 'asks.\n</think>\n\nParis'])).toEqual({
      reasoning: 'Okay, the user asks.\n',
      text: 'Paris',
    });
  });

  it('handles the close in the first chunk', () => {
    expect(prefilled(['</think>\n\nParis', ' it is.'])).toEqual({ reasoning: '', text: 'Paris it is.' });
  });

  it('drops whitespace before the reasoning and before the reply, across chunks', () => {
    expect(prefilled(['\n', '  hmm</think>', '\n', '\n ok \n'])).toEqual({ reasoning: 'hmm', text: 'ok \n' });
  });

  it('streams reasoning as it arrives and holds a close split across chunks', () => {
    const filter = createThinkFilter({ startInReasoning: true });
    expect(filter.push('hmm</th')).toEqual({ text: '', reasoning: 'hmm' });
    expect(filter.push('ink>Par')).toEqual({ text: 'Par', reasoning: '' });
    expect(filter.push('is')).toEqual({ text: 'is', reasoning: '' });
  });

  it('keeps everything as reasoning when the close never comes', () => {
    expect(prefilled(['thinking ', 'and still <thi', 'nking'])).toEqual({
      reasoning: 'thinking and still <thinking',
      text: '',
    });
  });

  it('keeps an opener inside the block as reasoning text, as Ollama does', () => {
    expect(prefilled(['<think>\nplan</think>answer'])).toEqual({ reasoning: '<think>\nplan', text: 'answer' });
  });

  it('ends the block at the first close and passes later markers through as reply text, as Ollama does', () => {
    expect(prefilled(['r<think>x</thi', 'nk>rest</think>ans'])).toEqual({
      reasoning: 'r<think>x',
      text: 'rest</think>ans',
    });
  });
});
