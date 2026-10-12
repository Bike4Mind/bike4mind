/**
 * Whether the composer should give up focus after a send. Only touch devices want that (it hides
 * the on-screen keyboard); everywhere else blurring drops keyboard and screen reader users onto
 * <body>, so focus stays in the composer for the next message.
 */
export const shouldBlurComposerAfterSend = (): boolean =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(pointer: coarse)').matches
    : false;
