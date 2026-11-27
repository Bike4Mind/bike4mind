import { useEffect, useMemo, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { toast } from 'sonner';
import { walkIsCurrent, type TutorialRunModule } from '@bike4mind/common';
import { useSessions } from '@client/app/contexts/SessionsContext';
import { useGetSessionQuests } from '@client/app/hooks/data/sessions';
import { useTutorialsEnabled } from '@client/app/hooks/data/tutorials';
import { useTutorialProgress, useTutorialRunModules } from '@client/app/hooks/tutorials/useTutorialRun';
import { useTutorialAutoRouteOff } from '../agentMode';
import { CORE_TUTORIALS_API_BASE, TutorialHostProvider } from '../TutorialHostContext';
import { OFF_NOTICE, TutorialRunner } from '../TutorialRunner';
import { tutorialModulesKey, tutorialProgressKey } from '../tutorialKeys';
import type { TutorialQuest } from '../types';
import { useTutorialStore, useTutorialStoreApi } from '../useTutorialStore';
import { CORE_TUTORIAL_STEPS } from './coreTutorialSteps';
import { nextInTrack } from './pickerModel';
import { TutorialPicker } from './TutorialPicker';
import { useTutorialPicker } from './tutorialPickerStore';
import { useCoreTutorialLauncher } from './useCoreTutorialLauncher';

const NO_MODULES: readonly TutorialRunModule[] = [];

/**
 * Core's tutorial host: the picker, and the runner for a walk on the open notebook. Renders nothing, and asks the
 * server nothing, until an admin switches core tutorials on.
 */
export function CoreTutorialHost() {
  if (!useTutorialsEnabled()) return null;
  return (
    <TutorialHostProvider apiBase={CORE_TUTORIALS_API_BASE} steps={CORE_TUTORIAL_STEPS}>
      <CoreTutorialHostInner />
    </TutorialHostProvider>
  );
}

function CoreTutorialHostInner() {
  const { currentSessionId } = useSessions();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const store = useTutorialStoreApi();
  const active = useTutorialStore(state => state.active);
  const modulesQuery = useTutorialRunModules();
  const progressQuery = useTutorialProgress();
  const modules = modulesQuery.data ?? NO_MODULES;
  const { start, resume } = useCoreTutorialLauncher(modules);
  const { open, setOpen, requestedTrack, clearTrackRequest, setHostState } = useTutorialPicker();
  useTutorialAutoRouteOff(currentSessionId);

  useEffect(() => {
    setHostState({ hostMounted: true });
    return () => setHostState({ hostMounted: false, walkOnScreen: false, walkPrompt: null });
  }, [setHostState]);

  // A track an entry point asked for continues where the user stands in it.
  useEffect(() => {
    if (!requestedTrack) return;
    // A request the lists cannot answer is dropped, so it never fires later on a background refetch.
    if (modulesQuery.isError || progressQuery.isError) {
      clearTrackRequest();
      setOpen(true);
      return;
    }
    if (!modulesQuery.isSuccess || progressQuery.isPending) return;
    clearTrackRequest();
    const next = nextInTrack(modules, progressQuery.data, requestedTrack);
    if (!next) setOpen(true);
    else if (next.status === 'in_progress') void resume(next.tutorial.id);
    else void start(next.tutorial.id);
  }, [
    requestedTrack,
    modulesQuery.isError,
    progressQuery.isError,
    modulesQuery.isSuccess,
    progressQuery.isPending,
    progressQuery.data,
    modules,
    clearTrackRequest,
    setOpen,
    resume,
    start,
  ]);

  // A reload, or coming back to the tutorial's notebook, picks the walk up where it was saved. A walk the user left
  // stays left until they resume it.
  const pickedUpFor = useRef<string | null>(null);
  useEffect(() => {
    if (!currentSessionId || pickedUpFor.current === currentSessionId) return;
    // A walk already running here counts as picked up, so leaving it does not restart it. One running on another
    // notebook is left alone, and this notebook is looked at again once it ends.
    if (active) {
      if (active.sessionId === currentSessionId) pickedUpFor.current = currentSessionId;
      return;
    }
    if (!modulesQuery.isSuccess || !progressQuery.data) return;
    pickedUpFor.current = currentSessionId;
    for (const tutorial of modules) {
      const entry = progressQuery.data[tutorial.id];
      if (entry?.sessionId !== currentSessionId || entry.status !== 'in_progress' || !walkIsCurrent(entry, tutorial)) {
        continue;
      }
      // No position is saved until the first step completes, so a walk without one is still on its first step.
      const step = entry.stepId ? tutorial.steps.find(s => s.id === entry.stepId) : tutorial.steps[0];
      if (!step) continue;
      store.getState().begin({
        moduleId: tutorial.id,
        sessionId: entry.sessionId,
        stepId: step.id,
        version: tutorial.version,
        revision: tutorial.revision,
      });
      return;
    }
  }, [currentSessionId, active, modulesQuery.isSuccess, progressQuery.data, modules, store]);

  // A tutorial switched off while it ran leaves nothing to walk.
  const activeModuleId = active?.moduleId;
  useEffect(() => {
    if (!activeModuleId || !modulesQuery.isSuccess || modules.some(m => m.id === activeModuleId)) return;
    store.getState().end();
    void queryClient.invalidateQueries({ queryKey: tutorialProgressKey(CORE_TUTORIALS_API_BASE) });
    toast(OFF_NOTICE);
  }, [activeModuleId, modulesQuery.isSuccess, modules, store, queryClient]);

  const onTutorialSession = Boolean(active && active.sessionId === currentSessionId);
  const questsQuery = useGetSessionQuests(onTutorialSession ? currentSessionId : null);
  const quests = useMemo(
    () => (questsQuery.data?.pages ?? []).flatMap(page => page.data) as unknown as TutorialQuest[],
    [questsQuery.data]
  );
  const script = onTutorialSession ? modules.find(m => m.id === active?.moduleId) : undefined;
  const step = script?.steps.find(s => s.id === active?.stepId);
  const walkPrompt = step?.type === 'prompt' ? (step.prompt ?? null) : null;
  useEffect(
    () => setHostState({ walkOnScreen: onTutorialSession, walkPrompt }),
    [onTutorialSession, walkPrompt, setHostState]
  );

  return (
    <>
      {script && (
        <TutorialRunner
          key={script.id}
          script={script}
          quests={quests}
          skippable
          onStartModule={moduleId => void start(moduleId)}
          onExit={() => void navigate({ to: '/new' })}
          onShowSteps={() => setOpen(true)}
          onChanged={() => {
            void queryClient.invalidateQueries({ queryKey: tutorialModulesKey(CORE_TUTORIALS_API_BASE) });
            void queryClient.invalidateQueries({ queryKey: tutorialProgressKey(CORE_TUTORIALS_API_BASE) });
          }}
        />
      )}
      <TutorialPicker
        open={open}
        onClose={() => setOpen(false)}
        modules={modules}
        progress={progressQuery.data}
        liveModuleId={activeModuleId}
        loading={modulesQuery.isPending}
        onStart={moduleId => void start(moduleId)}
        onResume={moduleId => void resume(moduleId)}
      />
    </>
  );
}
