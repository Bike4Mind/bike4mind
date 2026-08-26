import { describe, it, expect } from 'vitest';
import { systemContentToText } from './systemContent';

describe('systemContentToText', () => {
  it('passes a plain string through unchanged', () => {
    expect(systemContentToText('You are a helpful assistant.')).toBe('You are a helpful assistant.');
  });

  it('joins the text of block-array content instead of serializing it', () => {
    const content = [
      { type: 'text' as const, text: 'Current date: Monday, August 17, 2026' },
      { type: 'text' as const, text: 'ARTIFACT OUTPUT:' },
    ];
    expect(systemContentToText(content)).toBe('Current date: Monday, August 17, 2026\nARTIFACT OUTPUT:');
  });

  // The regression this module exists for: both Anthropic-family adapters used to
  // coerce array content with JSON.stringify (or a bare join), sending the model
  // literal JSON syntax - escaped quotes and type/text keys - as its system prompt.
  it('never emits JSON syntax or [object Object] for block arrays', () => {
    const content = [{ type: 'text' as const, text: 'Be concise.' }];
    const out = systemContentToText(content);
    expect(out).toBe('Be concise.');
    expect(out).not.toContain('"type"');
    expect(out).not.toContain('\\"');
    expect(out).not.toContain('[object Object]');
  });

  it('drops non-text blocks rather than serializing them', () => {
    const content = [
      { type: 'text' as const, text: 'Keep this.' },
      { type: 'tool_use' as const, id: 't1', name: 'search', input: {} },
    ];
    expect(systemContentToText(content as never)).toBe('Keep this.');
  });

  it('returns an empty string for undefined, empty, and text-free content', () => {
    expect(systemContentToText(undefined)).toBe('');
    expect(systemContentToText('')).toBe('');
    expect(systemContentToText([])).toBe('');
    expect(systemContentToText([{ type: 'text' as const, text: '' }])).toBe('');
  });

  // Anthropic rejects a text block containing no non-whitespace text, and system
  // content reaches neither backend's sanitizeMessageContent - both exclude the
  // system role before sanitizing - so this helper is the only place it is caught.
  it('drops whitespace-only blocks rather than passing them to the API', () => {
    expect(systemContentToText([{ type: 'text' as const, text: '   ' }])).toBe('');
    expect(systemContentToText([{ type: 'text' as const, text: '\n\t  \n' }])).toBe('');
  });

  it('keeps real text when a whitespace-only block sits alongside it', () => {
    const content = [
      { type: 'text' as const, text: '   ' },
      { type: 'text' as const, text: 'Be concise.' },
      { type: 'text' as const, text: '\n' },
    ];
    expect(systemContentToText(content)).toBe('Be concise.');
  });

  it('preserves whitespace inside a block, trimming only the emptiness check', () => {
    const content = [{ type: 'text' as const, text: '  Indented guidance.  ' }];
    expect(systemContentToText(content)).toBe('  Indented guidance.  ');
  });
});
