import { useCallback } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import DataLakeExplorer from '@client/app/components/datalake/DataLakeExplorer';
import { useDataLakeWizardStore } from '@client/app/stores/useDataLakeWizardStore';
import { useChatInput } from '@client/app/hooks/useChatInput';

/**
 * Data Lakes home - the top-level, Opti-independent destination for a user's OWN
 * lakes: browse (the unified Explorer reading `/api/data-lakes/*`, which sees the
 * user's dynamic DB lakes) + manage (create / add files / archive / restore /
 * delete). Reachable by any user with the EnableDataLakes admin flag, Opti or not.
 *
 * The management panel + wizard modals are store-driven singletons already mounted
 * globally by ProviderBundle (Files/Browser). We only drive them via the store
 * (`openManager`); mounting our own copies here would stack a second modal on the
 * same `isManagerOpen`/`isOpen` flag.
 */
export default function DataLakesHome() {
  const navigate = useNavigate();
  const { article } = useSearch({ strict: false }) as { article?: string };
  const openManager = useDataLakeWizardStore(s => s.openManager);

  // No docked chat on this surface - "Ask about this article" prefills the composer
  // and drops the user into a fresh chat to send it.
  const handleAskAbout = useCallback(
    (prompt: string) => {
      useChatInput.getState().setChatInputValue(prompt);
      navigate({ to: '/new' });
    },
    [navigate]
  );

  return (
    <DataLakeExplorer
      source="datalakes"
      rootLabel="Data Lakes"
      articleId={article ?? null}
      onBack={() => navigate({ to: '/new' })}
      onAskAbout={handleAskAbout}
      onManage={openManager}
    />
  );
}
