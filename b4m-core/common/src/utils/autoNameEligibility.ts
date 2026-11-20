/**
 * When a notebook may be auto-named. Shared by the turn-start publish in
 * ChatCompletionInvoke, the after-reply fallback (AutoNameSessionFeature) and the
 * AutoName worker (apps/workers/src/events/sessionAutoNaming.ts), so the three agree.
 */

/** Names the core surfaces give a notebook before it has a real title. */
export const AUTO_NAME_DEFAULT_NAMES: readonly string[] = ['Untitled', 'New Notebook'];

/**
 * True while the notebook still carries a placeholder: a core default, or the placeholder a
 * product surface stamped at create (`autoNamePlaceholder`). A notebook the user renamed no
 * longer matches its placeholder.
 */
export function hasAutoNamePlaceholderName(session: { name?: string | null; autoNamePlaceholder?: string | null }) {
  if (session.name == null) return false;
  return (
    AUTO_NAME_DEFAULT_NAMES.includes(session.name) ||
    (session.autoNamePlaceholder != null && session.name === session.autoNamePlaceholder)
  );
}

// Every word of a low-signal prompt comes from here: greetings, acknowledgements and nudges
// that say nothing about what the notebook is for.
const LOW_SIGNAL_WORDS = new Set([
  'hi',
  'hello',
  'hey',
  'heya',
  'hiya',
  'yo',
  'sup',
  'hola',
  'howdy',
  'greetings',
  'good',
  'morning',
  'afternoon',
  'evening',
  'day',
  'there',
  'again',
  'all',
  'everyone',
  'how',
  'are',
  'you',
  "what's",
  'whats',
  'up',
  'thanks',
  'thank',
  'thx',
  'ty',
  'ok',
  'okay',
  'k',
  'yes',
  'yep',
  'yeah',
  'no',
  'nope',
  'sure',
  'hmm',
  'test',
  'testing',
  'ping',
  'continue',
  'go',
  'on',
  'next',
  'more',
  'start',
  'help',
]);

/**
 * True when a prompt gives the namer nothing to title the notebook from ("Hello", "hi there",
 * "continue", an emoji). An attachment always counts as signal: its file name carries the topic.
 */
export function isLowSignalNamingPrompt(prompt: string, attachmentCount = 0): boolean {
  if (attachmentCount > 0) return false;
  const words = prompt.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
  return words.every(word => LOW_SIGNAL_WORDS.has(word));
}
