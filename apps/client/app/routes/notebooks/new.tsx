import { useEffect, useLayoutEffect, useRef } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useSessions, useWorkBenchActions } from '@client/app/contexts/SessionsContext';
import SessionContainer from '@client/app/components/Session/SessionContainer';
import { NotebookFilepondProvider } from '@client/app/components/Session/NotebookFilepondProvider';
import { setSessionLayout } from '@client/app/hooks/useSessionLayout';
import { useDocumentTitle } from '@client/app/hooks/useDocumentTitle';
import { useQuestPreparation } from '@client/app/hooks/useQuestPreparation';
import { setQuestLaunchIntent } from '@client/app/utils/questLaunchIntent';

const NewNotebookPage = () => {
  const { setCurrentSession, setCurrentSessionId, setWorkBenchAgents } = useSessions();
  const { clearAllSessions } = useWorkBenchActions();
  const search = useSearch({ strict: false }) as { questmaster?: string; goal?: string };
  const navigate = useNavigate();
  const hasProcessedQuestParams = useRef(false);
  const { setPreparingQuest, isPreparingQuest } = useQuestPreparation();

  useDocumentTitle(search.goal || isPreparingQuest ? 'Preparing Quest...' : 'New Notebook');

  // CRITICAL: Record the launch intent before child useEffects read it.
  // useLayoutEffect runs synchronously after render but before child useEffects,
  // so useSendMessage's consuming effect finds the intent already set.
  useLayoutEffect(() => {
    if (!hasProcessedQuestParams.current && search.goal) {
      hasProcessedQuestParams.current = true;
      setQuestLaunchIntent({
        goal: search.goal,
        autoSubmit: true,
        enableQuestMaster: search.questmaster === 'true',
      });
      setPreparingQuest(search.goal);
      // Strip the params so a refresh or back-navigation cannot replay the
      // auto-submit (the intent itself is in-memory and consume-once).
      void navigate({ to: '/new', search: {}, replace: true });
    }
  }, [search.goal, search.questmaster, setPreparingQuest, navigate]);

  useEffect(() => {
    // Clear workbench state for new notebook
    console.log('🧹 Clearing all workbench files for new notebook');
    clearAllSessions();
    setWorkBenchAgents([]);

    setCurrentSession(null);
    setCurrentSessionId(null);
    setSessionLayout({ layout: 'hide' });
  }, [setCurrentSession, setCurrentSessionId, clearAllSessions, setWorkBenchAgents]);

  // Overlay is now rendered at app level (QuestPreparationOverlay in root layout)
  // so it persists across page navigation
  return (
    <NotebookFilepondProvider>
      <SessionContainer isLoading={false} />
    </NotebookFilepondProvider>
  );
};

export default NewNotebookPage;
