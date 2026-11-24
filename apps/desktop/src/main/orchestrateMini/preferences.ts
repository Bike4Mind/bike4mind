import { PreferenceFile } from '../preferenceFile';
import { windowBoundsSchema, type WindowBounds } from '../windowBounds';

export type OrchestrateMiniPreferences = {
  /** Open when the app last quit, so it reopens; off until the user first turns it on. */
  open: boolean;
  bounds: WindowBounds | null;
};

export const DEFAULT_ORCHESTRATE_MINI_PREFERENCES: OrchestrateMiniPreferences = { open: false, bounds: null };

/** Field by field, so one bad value (a hand edit, an older file) does not reset the other. */
export function parseOrchestrateMiniPreferences(value: unknown): OrchestrateMiniPreferences {
  const record = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const bounds = windowBoundsSchema.safeParse(record.bounds);
  return {
    open: typeof record.open === 'boolean' ? record.open : DEFAULT_ORCHESTRATE_MINI_PREFERENCES.open,
    bounds: bounds.success ? bounds.data : null,
  };
}

/** The Orchestrate mini window's bounds and visibility (orchestrate-mini.json); see PreferenceFile. */
export class OrchestrateMiniPreferencesStore extends PreferenceFile<OrchestrateMiniPreferences> {
  constructor(filePath: string) {
    super(filePath, parseOrchestrateMiniPreferences, 'ORCHESTRATE-MINI');
  }
}
