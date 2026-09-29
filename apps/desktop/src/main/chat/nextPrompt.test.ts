import type { ChatModelOption } from '@shared/chat';
import { describe, expect, it } from 'vitest';
import { pickSuggestionModel, sanitizeSuggestion, suggestionRequestMessages, SUGGESTION_MODELS } from './nextPrompt';

const option = (id: string): ChatModelOption => ({ id, name: id });

describe('pickSuggestionModel', () => {
  it('prefers a small model over the one the conversation is held on', () => {
    const available = [option('claude-opus-4-5-20251101'), option(SUGGESTION_MODELS[0])];
    expect(pickSuggestionModel(available)).toBe(SUGGESTION_MODELS[0]);
  });

  it('follows the preference order when the server offers several', () => {
    const available = [option(SUGGESTION_MODELS[2]), option(SUGGESTION_MODELS[0])];
    expect(pickSuggestionModel(available)).toBe(SUGGESTION_MODELS[0]);
  });

  // Unlike a title, this never falls back to the session's own model: it runs after EVERY reply,
  // and billing a frontier model per turn for a greyed-out hint is not a trade anyone opted into.
  it('declines rather than spending a big model, per turn, on a hint', () => {
    expect(pickSuggestionModel([option('claude-opus-4-5-20251101')])).toBeNull();
  });

  it('declines when the catalog could not be read', () => {
    expect(pickSuggestionModel([])).toBeNull();
  });
});

describe('suggestionRequestMessages', () => {
  it('sends the instruction, the prompt and the reply, and nothing else', () => {
    const messages = suggestionRequestMessages('should I keep the card?', 'You could keep it for now.');
    expect(messages).toHaveLength(3);
    expect(messages[0].role).toBe('system');
    expect(messages[1]).toEqual({ role: 'user', content: 'should I keep the card?' });
    // Handed over as an assistant turn, so the model reads it as something SAID rather than as
    // something asked of it.
    expect(messages[2]).toEqual({ role: 'assistant', content: 'You could keep it for now.' });
  });

  // The thing a user answers is whatever the reply ENDED on, so both excerpts are tails.
  it('excerpts a long turn from its end, not its start', () => {
    const messages = suggestionRequestMessages('x'.repeat(50_000), `${'y'.repeat(50_000)}so which one?`);
    expect(String(messages[2].content).length).toBeLessThan(2000);
    expect(String(messages[2].content).endsWith('so which one?')).toBe(true);
  });
});

describe('sanitizeSuggestion', () => {
  it('keeps a well-formed suggestion as written', () => {
    const raw = 'Keep SidebarCard for now until the folder dialog is built';
    expect(sanitizeSuggestion(raw)).toBe(raw);
  });

  it('strips the quotes and markdown a model wraps a line in', () => {
    expect(sanitizeSuggestion('**"Add a test for the empty case"**')).toBe('Add a test for the empty case');
  });

  it('drops trailing punctuation', () => {
    expect(sanitizeSuggestion('Add a test for the empty case.')).toBe('Add a test for the empty case');
  });

  it('drops a bullet the model put in front of its one answer', () => {
    expect(sanitizeSuggestion('- Add a test for the empty case')).toBe('Add a test for the empty case');
  });

  it('collapses a multi-line reply onto one line', () => {
    expect(sanitizeSuggestion('Add a test\n\nfor the empty case')).toBe('Add a test for the empty case');
  });

  it('removes control bytes rather than putting them in the input box', () => {
    expect(sanitizeSuggestion('Add a\u0007 test\u0000 now')).toBe('Add a test now');
  });

  it.each([
    ['blank', '   \n  '],
    ['decoration only', '***'],
    ['punctuation with no words', '...'],
    // The feature offers an instruction to SEND. A model asking the user something is the
    // failure mode this prompt slips into most, and it would read as the app interrogating them.
    ['a question', 'Would you like me to add a test for that?'],
    // Discarded rather than cut: a truncated imperative asks for something different from
    // whatever the model wrote, and this one is a keystroke away from being sent.
    ['too long to read inside the input', 'Delete the old SidebarCard component and every test that still imports it'],
    ['prose rather than a prompt', `Sure, I can help with that. ${'The next step is to check the logs. '.repeat(6)}`],
  ])('refuses %s, so the ordinary placeholder is shown', (_label, reply) => {
    expect(sanitizeSuggestion(reply)).toBeNull();
  });
});
