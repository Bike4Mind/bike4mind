import { GlobalStyles } from '@mui/joy';
import type { TutorialScript } from './types';

/**
 * Core's composer chips beside the message box: the model picker, Tools, Agents and the two voice buttons.
 * The composer is core's, so they are hidden by testid. Send, the text field and the + attach menu are not here.
 */
export const COMPOSER_CHIPS = [
  'ai-settings-btn',
  'session-tools-dropdown-toggle',
  'session-agents-dropdown-toggle',
  'voice-record-btn',
  'conversational-voice-btn',
] as const;

const COMPOSER = '[data-testid="session-bottom-container"]';

/** The chips no step of `script` points at. */
export const unusedComposerChips = (script: TutorialScript) =>
  COMPOSER_CHIPS.filter(testid => !script.steps.some(step => step.anchor === testid));

/** Hides the composer chips the module never uses for as long as it is mounted, so they return when it ends. */
export function HideUnusedComposerChips({ script }: { script: TutorialScript }) {
  const hidden = unusedComposerChips(script);
  if (hidden.length === 0) return null;
  const selector = `${COMPOSER} :is(${hidden.map(testid => `[data-testid="${testid}"]`).join(', ')})`;
  return <GlobalStyles styles={{ [selector]: { display: 'none !important' } }} />;
}
