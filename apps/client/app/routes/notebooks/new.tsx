import { useEffect, useLayoutEffect, useRef } from 'react';
import { useSearch } from '@tanstack/react-router';
import { useSessions, useWorkBenchActions } from '@client/app/contexts/SessionsContext';
import SessionContainer from '@client/app/components/Session/SessionContainer';
import { NotebookFilepondProvider } from '@client/app/components/Session/NotebookFilepondProvider';
import { setSessionLayout } from '@client/app/hooks/useSessionLayout';
import { useDocumentTitle } from '@client/app/hooks/useDocumentTitle';
import { useQuestPreparation } from '@client/app/hooks/useQuestPreparation';

const NewNotebookPage = () => {
  const { setCurrentSession, setCurrentSessionId, setWorkBenchAgents } = useSessions();
  const { clearAllSessions } = useWorkBenchActions();
  const search = useSearch({ strict: false }) as { questmaster?: string; goal?: string };
  const hasProcessedQuestParams = useRef(false);
  const { setPreparingQuest } = useQuestPreparation();

  useDocumentTitle(search.goal ? 'Preparing Quest...' : 'New Notebook');

  // CRITICAL: Set localStorage before child useEffects read it.
  // useLayoutEffect runs synchronously after render but before child useEffects,
  // so SessionBottom's useEffect will find these values already set.
  useLayoutEffect(() => {
    if (!hasProcessedQuestParams.current && search.goal && typeof window !== 'undefined') {
      hasProcessedQuestParams.current = true;
      console.log('🎯 Setting quest params in localStorage:', search.goal);
      localStorage.setItem('newQuestGoal', search.goal);
      localStorage.setItem('autoSubmitQuest', 'true');
      if (search.questmaster === 'true') {
        localStorage.setItem('enableQuestMasterOnSubmit', 'true');
      }
    }
    if (search.goal) {
      setPreparingQuest(search.goal);
    }
  }, [search.goal, search.questmaster, setPreparingQuest]);

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
