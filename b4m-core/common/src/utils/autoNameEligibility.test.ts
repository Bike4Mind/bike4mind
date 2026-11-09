import { describe, expect, it } from 'vitest';
import { hasAutoNamePlaceholderName, isLowSignalNamingPrompt } from './autoNameEligibility';

describe('isLowSignalNamingPrompt', () => {
  it.each([
    'Hello',
    'hi',
    'Hi there!',
    'hey, how are you?',
    'continue',
    'go on',
    'thanks',
    'ok',
    '\u{1F44B}',
    '  ',
    '?',
  ])('treats %j as low-signal', prompt => expect(isLowSignalNamingPrompt(prompt)).toBe(true));

  it.each([
    'Python decorators',
    'hi, can you review my resume?',
    'SQL',
    '\u4eac\u90fd\u306e\u65c5\u884c',
    'help me plan',
  ])('treats %j as having signal', prompt => expect(isLowSignalNamingPrompt(prompt)).toBe(false));

  it('counts an attachment as signal', () => {
    expect(isLowSignalNamingPrompt('hi', 1)).toBe(false);
  });
});

describe('hasAutoNamePlaceholderName', () => {
  it.each([
    [{ name: 'New Notebook' }, true],
    [{ name: 'Untitled' }, true],
    [{ name: 'API chat', autoNamePlaceholder: 'API chat' }, true],
    [{ name: 'My project', autoNamePlaceholder: 'API chat' }, false],
    [{ name: 'My project' }, false],
    [{ name: undefined }, false],
  ])('%j -> %s', (session, expected) => expect(hasAutoNamePlaceholderName(session)).toBe(expected));
});
