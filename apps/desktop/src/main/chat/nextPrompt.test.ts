import { isLocalBackend, type ChatModelOption } from '@shared/chat';
import { describe, expect, it } from 'vitest';
import {
  pickSuggestionModel,
  sanitizeSuggestion,
  suggestionModelChoices,
  suggestionRequestMessages,
  SUGGESTION_MODELS,
} from './nextPrompt';

const option = (id: string, backend?: string): ChatModelOption => ({ id, name: id, ...(backend ? { backend } : {}) });

describe('pickSuggestionModel', () => {
  it('prefers a small model over the one the conversation is held on', () => {
    const available = [option('claude-opus-4-5-20251101'), option(SUGGESTION_MODELS[0])];
    expect(pickSuggestionModel(available)?.id).toBe(SUGGESTION_MODELS[0]);
  });

  it('follows the preference order when the server offers several', () => {
    const available = [option(SUGGESTION_MODELS[2]), option(SUGGESTION_MODELS[0])];
    expect(pickSuggestionModel(available)?.id).toBe(SUGGESTION_MODELS[0]);
  });

  // Unlike a title, this never falls back to the session's own model: it runs after EVERY reply,
  // and billing a frontier model per turn for a greyed-out hint is not a trade anyone opted into.
  it('declines rather than spending a big model, per turn, on a hint', () => {
    expect(pickSuggestionModel([option('claude-opus-4-5-20251101')])).toBeNull();
  });

  it('declines when the catalog could not be read', () => {
    expect(pickSuggestionModel([])).toBeNull();
  });

  it('never picks a local model on its own', () => {
    expect(pickSuggestionModel([option('qwen3:8b', 'ollama')])).toBeNull();
  });

  it('uses the model pinned in Settings, local ones included', () => {
    const available = [option(SUGGESTION_MODELS[0]), option('qwen3:8b', 'ollama')];
    expect(pickSuggestionModel(available, 'qwen3:8b')?.id).toBe('qwen3:8b');
    expect(pickSuggestionModel(available, SUGGESTION_MODELS[0])?.id).toBe(SUGGESTION_MODELS[0]);
  });

  // A user who pinned Ollama must not be routed to a different provider when it stops.
  it('declines rather than substituting when the pinned model is not offered', () => {
    expect(pickSuggestionModel([option(SUGGESTION_MODELS[0])], 'qwen3:8b')).toBeNull();
  });

  it('offers and uses a device-local model pinned in Settings', () => {
    const local = option('local:ollama:qwen3:8b', 'local-ollama');
    expect(suggestionModelChoices([local])).toEqual([local]);
    expect(pickSuggestionModel([local], local.id)).toBe(local);
    expect(pickSuggestionModel([local])).toBeNull();
  });

  it('treats any local-* backend as device-local', () => {
    const local = option('local:lmstudio:some-model', 'local-lmstudio');
    expect(suggestionModelChoices([local])).toEqual([local]);
    expect(isLocalBackend(local)).toBe(true);
    expect(isLocalBackend(option('claude-sonnet'))).toBe(false);
  });

  it('refuses a pin on a big hosted model the picker never offered', () => {
    expect(pickSuggestionModel([option('claude-opus-4-5-20251101')], 'claude-opus-4-5-20251101')).toBeNull();
  });
});

describe('suggestionModelChoices', () => {
  it('lists the small hosted models in preference order, then every local model', () => {
    const available = [
      option('claude-opus-4-5-20251101'),
      option('qwen3:8b', 'ollama'),
      option(SUGGESTION_MODELS[2]),
      option(SUGGESTION_MODELS[0]),
      option('llama3.2', 'ollama'),
    ];
    expect(suggestionModelChoices(available).map(model => model.id)).toEqual([
      SUGGESTION_MODELS[0],
      SUGGESTION_MODELS[2],
      'qwen3:8b',
      'llama3.2',
    ]);
  });
});

describe('suggestionRequestMessages', () => {
  // The regression guard, and the whole point of the fix. A request that ends on an assistant
  // turn is a prefill: the model continues that turn instead of writing the user's next
  // message, and this feature shipped answering with a few tokens of nothing on nearly every
  // call. Whatever else changes here, the last message stays the user's.
  it('ends on a user message, never on an assistant prefill', () => {
    const messages = suggestionRequestMessages('should I keep the card?', 'You could keep it for now.');
    expect(messages[messages.length - 1].role).toBe('user');
    expect(messages.some(message => message.role === 'assistant')).toBe(false);
  });

  it('sends the instruction and one turn carrying both halves of the exchange, and nothing else', () => {
    const messages = suggestionRequestMessages('should I keep the card?', 'You could keep it for now.');
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[1].role).toBe('user');
    expect(String(messages[1].content)).toContain('should I keep the card?');
    expect(String(messages[1].content)).toContain('You could keep it for now.');
  });

  // The thing a user answers is whatever the reply ENDED on, so both excerpts are tails.
  it('excerpts a long turn from its end, not its start', () => {
    const messages = suggestionRequestMessages('x'.repeat(50_000), `${'y'.repeat(50_000)}so which one?`);
    const content = String(messages[1].content);
    expect(content.length).toBeLessThan(3000);
    expect(content).toContain('so which one?');
    expect(content).not.toContain('y'.repeat(2000));
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

  // A rule is what a model reaches for when it thinks it is continuing a document rather than
  // writing a line, and three dashes are neither decoration nor a list marker, so nothing else
  // here catches them.
  it.each([
    ['dashes', '\n\n---\n\nAdd a test for the empty case'],
    ['asterisks', '***\nAdd a test for the empty case'],
    ['underscores', '___\nAdd a test for the empty case'],
    ['a rule on the same line as the answer', '--- Add a test for the empty case'],
  ])('strips a leading horizontal rule written with %s', (_label, reply) => {
    expect(sanitizeSuggestion(reply)).toBe('Add a test for the empty case');
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
