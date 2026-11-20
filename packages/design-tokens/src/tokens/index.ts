import { designTokensSchema, type DesignTokens } from '../schema';
import { colorPrimitives } from './primitives';
import { darkScheme, lightScheme } from './schemes';
import { typography } from './typography';
import { spacing, radii, shadows, motion } from './metrics';

export * from './primitives';
export { darkScheme, lightScheme } from './schemes';
export { typography } from './typography';
export { spacing, radii, shadows, motion } from './metrics';

/**
 * The canonical token set, validated at module load so a malformed token
 * fails fast at build/test time rather than rendering wrong.
 */
export const designTokens: DesignTokens = designTokensSchema.parse({
  color: {
    primitives: colorPrimitives,
    schemes: {
      light: lightScheme,
      dark: darkScheme,
    },
  },
  typography,
  spacing,
  radii,
  shadows,
  motion,
});
