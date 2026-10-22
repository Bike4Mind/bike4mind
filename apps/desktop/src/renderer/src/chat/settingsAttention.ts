import { updateAttention } from '@shared/update';
import { useAppUpdate } from './useAppUpdate';

/**
 * What Settings has to say when nobody is looking at it, or undefined when it has nothing.
 *
 * Settings has no row in the nav list - it is reached from the account menu, and a second
 * config row under Customize said the same thing twice. That leaves nothing permanently on
 * screen to report a ready update, so the account strip carries this instead: it is the row
 * the menu opens from, and it is always visible.
 *
 * Only the updater can raise one. The server is set by the user and never asks for them.
 */
export function useSettingsAttention(): string | undefined {
  const { state } = useAppUpdate();

  return updateAttention(state);
}
