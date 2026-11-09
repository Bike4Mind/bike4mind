import type { DesignTokens } from '../schema';

/**
 * A named emit target. Every platform output (web theme fragment, CSS
 * variables, future native formats) implements this interface; adding a
 * target is adding one implementation, nothing in the token source changes.
 */
export type TokenEmitter<TOutput> = {
  /** Unique target name, e.g. "joy" or "css-variables". */
  readonly target: string;
  emit(tokens: DesignTokens): TOutput;
};
