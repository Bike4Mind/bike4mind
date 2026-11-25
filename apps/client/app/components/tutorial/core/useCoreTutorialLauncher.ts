import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { toast } from 'sonner';
import { walkIsCurrent, type TutorialRunModule } from '@bike4mind/common';
import { useChatInput } from '@client/app/hooks/useChatInput';
import { useTutorialHost } from '../hostBase';
import { tutorialProgressKey } from '../tutorialKeys';
import { useTutorialStoreApi } from '../useTutorialStore';
import { useTutorialPicker } from './tutorialPickerStore';

export const START_FAILED_NOTICE = "Couldn't start that tutorial - please try again.";
export const RESUME_FELL_BACK_NOTICE =
  "That tutorial can't be picked up where it stopped, so it starts from the beginning.";

/** The message the tutorial opens with, which the user sends from the composer to begin. */
export const openingPromptOf = (tutorial: Pick<TutorialRunModule, 'steps'>): string | undefined =>
  tutorial.steps.find(step => step.type === 'prompt' && step.turn === 0)?.prompt;

/**
 * Starts and resumes core tutorials. Starting opens a fresh tutorial notebook, puts the opening message in its
 * composer and lands the user there, with the coach card pointing at Send: nothing is sent for them.
 */
export function useCoreTutorialLauncher(modules: readonly TutorialRunModule[]) {
  const { apiBase, transport } = useTutorialHost();
  const store = useTutorialStoreApi();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const closePicker = useTutorialPicker(s => s.setOpen);

  const goToSession = (sessionId: string) => navigate({ to: '/notebooks/$id', params: { id: sessionId } });

  const start = async (moduleId: string) => {
    const tutorial = modules.find(m => m.id === moduleId);
    if (!tutorial || tutorial.steps.length === 0) return;
    closePicker(false);
    let started: Awaited<ReturnType<typeof transport.start>>;
    try {
      started = await transport.start({ moduleId });
    } catch (error) {
      console.warn('Tutorial start failed', error);
      toast(START_FAILED_NOTICE);
      return;
    }
    void queryClient.invalidateQueries({ queryKey: tutorialProgressKey(apiBase) });
    void queryClient.invalidateQueries({ queryKey: ['sessions'] });
    const { sessionId, version, revision } = started;
    store.getState().begin({ moduleId, sessionId, stepId: tutorial.steps[0].id, version, revision });
    const opening = openingPromptOf(tutorial);
    const input = useChatInput.getState();
    if (opening) input.setDraft(sessionId, opening);
    await goToSession(sessionId);
    if (opening) {
      input.setChatInputValue(opening);
      input.requestFocus();
    }
  };

  const resume = async (moduleId: string) => {
    const tutorial = modules.find(m => m.id === moduleId);
    if (!tutorial) return;
    closePicker(false);
    const live = store.getState().active;
    if (live?.moduleId === moduleId) {
      await goToSession(live.sessionId);
      return;
    }
    const progress = await queryClient
      .fetchQuery({ queryKey: tutorialProgressKey(apiBase), queryFn: transport.progress, staleTime: 0 })
      .catch(() => undefined);
    const entry = progress?.[moduleId];
    if (!entry || entry.status === 'finished' || !walkIsCurrent(entry, tutorial)) {
      await start(moduleId);
      return;
    }
    let resumed: Awaited<ReturnType<typeof transport.resume>>;
    try {
      resumed = await transport.resume({ moduleId });
    } catch {
      // The server refuses a session the user has since written in, or one that is gone.
      toast(RESUME_FELL_BACK_NOTICE);
      await start(moduleId);
      return;
    } finally {
      void queryClient.invalidateQueries({ queryKey: tutorialProgressKey(apiBase) });
    }
    const stepId = tutorial.steps.some(s => s.id === entry.stepId) ? entry.stepId! : tutorial.steps[0].id;
    store.getState().begin({
      moduleId,
      sessionId: resumed.sessionId,
      stepId,
      version: resumed.version,
      revision: resumed.revision,
    });
    await goToSession(resumed.sessionId);
  };

  return { start, resume };
}
