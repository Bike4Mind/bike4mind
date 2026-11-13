import { cssVariablesEmitter } from './cssVariables';
import { joyEmitter } from './joy';
import { kotlinEmitter } from './native/kotlin';
import { swiftEmitter } from './native/swift';

export type { TokenEmitter } from './types';
export { joyEmitter, emitJoyThemeFragment } from './joy';
export type { JoyPaletteFragment, JoyThemeFragment } from './joy';
export { cssVariablesEmitter, emitCssVariables } from './cssVariables';
export { swiftEmitter, emitSwift } from './native/swift';
export { kotlinEmitter, emitKotlin } from './native/kotlin';
export { resolveNativeTheme, NATIVE_COLOR_ROLES } from './native/nativeTheme';
export type { NativeTheme, NativeColorRole, Rgba } from './native/nativeTheme';
export type { EmittedFiles } from './native/types';

/** Registry of the available emit targets, keyed by target name. */
export const emitters = {
  [joyEmitter.target]: joyEmitter,
  [cssVariablesEmitter.target]: cssVariablesEmitter,
  [swiftEmitter.target]: swiftEmitter,
  [kotlinEmitter.target]: kotlinEmitter,
} as const;
