import { useCallback, useEffect, useMemo, useState } from 'react';
import { EMPTY_SIDEBAR_SECTIONS, type SidebarSectionsState } from '@shared/sidebarSections';

export interface SidebarSectionActions {
  /** Makes a section and, when given a session, moves it in. */
  create: (name: string, sessionId?: string) => void;
  rename: (sectionId: string, name: string) => void;
  remove: (sectionId: string) => void;
  /** Null takes the session out of its section. */
  move: (sessionId: string, sectionId: string | null) => void;
}

/**
 * The user's sidebar sections, as main last reported them. Every change answers with the whole
 * state, so there is no optimistic copy here to drift from the file.
 */
export function useSidebarSections(): {
  sections: SidebarSectionsState;
  actions: SidebarSectionActions;
  /** Set when the last change failed to save; cleared by the next one that succeeds. */
  error: string | null;
  dismissError: () => void;
} {
  const [sections, setSections] = useState<SidebarSectionsState>(EMPTY_SIDEBAR_SECTIONS);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    window.b4m.sidebar
      .getSections()
      .then(state => {
        if (live) setSections(state);
      })
      .catch((error: unknown) => console.error('Could not load sidebar sections', error));
    return () => {
      live = false;
    };
  }, []);

  // The sidebar stays usable on a failed write - it just keeps the state it had - so the failure
  // is logged and surfaced as a dismissible message rather than raised into a render.
  const apply = useCallback((change: Promise<SidebarSectionsState>) => {
    change
      .then(state => {
        setSections(state);
        setError(null);
      })
      .catch((cause: unknown) => {
        console.error('Could not update sidebar sections', cause);
        setError('Could not save that section change.');
      });
  }, []);
  const dismissError = useCallback(() => setError(null), []);

  const actions = useMemo<SidebarSectionActions>(
    () => ({
      create: (name, sessionId) => apply(window.b4m.sidebar.createSection(name, sessionId)),
      rename: (sectionId, name) => apply(window.b4m.sidebar.renameSection(sectionId, name)),
      remove: sectionId => apply(window.b4m.sidebar.deleteSection(sectionId)),
      move: (sessionId, sectionId) => apply(window.b4m.sidebar.moveSession(sessionId, sectionId)),
    }),
    [apply]
  );

  return { sections, actions, error, dismissError };
}
