import { cssVariablesEmitter } from './cssVariables';
import { joyEmitter } from './joy';

export type { TokenEmitter } from './types';
export { joyEmitter, emitJoyThemeFragment } from './joy';
export type { JoyPaletteFragment, JoyThemeFragment } from './joy';
export { cssVariablesEmitter, emitCssVariables } from './cssVariables';

/** Registry of the available emit targets, keyed by target name. */
export const emitters = {
  [joyEmitter.target]: joyEmitter,
  [cssVariablesEmitter.target]: cssVariablesEmitter,
} as const;
