import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useChatInput } from '@client/app/hooks/useChatInput';
import { setOptimisticQueryData } from '@client/app/utils/react-query';
import {
  carriesTutorialMarker,
  markedTurn,
  samePrompt,
  type TutorialCardSide,
  type TutorialStatus,
  type TutorialStep,
} from '@bike4mind/common';
import { CoachMark } from './CoachMark';
import { HideUnusedComposerChips } from './ComposerChips';
import type {
  TutorialAnchorOptions,
  TutorialQuest,
  TutorialScript,
  TutorialStepRegistry,
  TutorialTransport,
} from './types';
import { useTutorialHost } from './hostBase';
import { StepFallback } from './steps/StepFallback';
import { useTutorialStore, useTutorialStoreApi } from './useTutorialStore';

export const LEFT_NOTICE =
  'You sent a message of your own, so the tutorial stepped aside. Your conversation carries on.';
export const CHANGED_NOTICE = 'This tutorial was updated since you started it. Start it again from the beginning.';
export const LANDED_EARLIER_NOTICE =
  'That step needs the page set up first, so the tutorial picks up at the step that does it.';
export const PAUSED_NOTICE = 'Tutorial paused. Pick it up from the Tutorials panel.';
export const JUMP_FAILED_NOTICE = "Couldn't move to that step - please try again.";
export const SKIP_FAILED_NOTICE = "Couldn't skip that step - please try again.";
export const OFF_NOTICE = 'This tutorial was switched off for now. Your conversation carries on.';

/** How the server said the module moved under a running walk: changed, or switched off. Undefined for anything else. */
export function moduleChangeOf(error: unknown): 'changed' | 'off' | undefined {
  const response = (error as { response?: { status?: number; data?: { code?: string } } } | null)?.response;
  if (response?.status === 410 || response?.status === 404) return 'off';
  if (response?.status === 409 && response.data?.code === 'VERSION_CHANGED') return 'changed';
  return undefined;
}

/**
 * A message of the user's own that the chat answered: settled and unmarked. A tutorial prompt the user
 * sent is unmarked too until the server's recorded reply lands on it, so one still running is not judged.
 */
export const hasForeignQuest = (quests: readonly TutorialQuest[] | undefined) =>
  (quests ?? []).some(quest => !quest._optimistic && quest.status !== 'running' && !carriesTutorialMarker(quest));

const NO_QUESTS: readonly TutorialQuest[] = [];

/**
 * Empties the composer when it still holds a prompt this module pasted for another step, so the step a jump
 * lands on pastes its own. Text the user typed is left alone.
 */
function clearStalePrompt(script: TutorialScript, sessionId: string) {
  const input = useChatInput.getState();
  const value = input.chatInputValue;
  if (!value.trim() || !script.steps.some(s => s.prompt && samePrompt(value, s.prompt))) return;
  input.setDraft(sessionId, '');
  input.setChatInputValue('');
}

/** "Step 2 of 15" for the card. A bridge between modules is not a step, so it has none. */
export function stepProgress(script: TutorialScript, stepId: string) {
  const counted = script.steps.filter(s => s.type !== 'bridge');
  const index = counted.findIndex(s => s.id === stepId);
  return index >= 0 ? { index: index + 1, count: counted.length } : undefined;
}

/**
 * The side the card tries first. A step's own side is chosen for its own anchor, so an anchor the step moved the card
 * to (a file row in the File Browser, say) brings its own side or none, and the card takes the roomiest clear spot.
 */
export function cardSide(
  step: Pick<TutorialStep, 'anchor' | 'placement'>,
  override: ({ testid: string | undefined } & TutorialAnchorOptions) | null
): TutorialCardSide | undefined {
  if (override?.placement) return override.placement;
  const moved = override?.testid !== undefined && override.testid !== step.anchor;
  return moved ? undefined : step.placement;
}

/** Heads the bridge card, which closes the module, where a step shows its count. */
export const bridgeHeading = (script: TutorialScript) => {
  const count = script.steps.filter(s => s.type !== 'bridge').length;
  if (count === 0) return 'All done';
  return `All done: ${count} ${count === 1 ? 'step' : 'steps'} complete`;
};

export interface TutorialRunnerProps {
  script: TutorialScript;
  /** Defaults to the host provider's registry. A step type it lacks renders StepFallback. */
  steps?: TutorialStepRegistry;
  /** Defaults to the host provider's transport. */
  transport?: TutorialTransport;
  /** The active session's quests, for noticing a message the user sent themselves. */
  quests?: readonly TutorialQuest[];
  /** Starts another module, for a step that hands the user on to one. */
  onStartModule?: (moduleId: string) => void;
  /** Leaves the rails for the host's own starting point, for a step that ends the journey there. */
  onExit?: () => void;
  /** The step a jump to `stepId` can stand on, given what is on the page. Absent, a jump lands on the step itself. */
  landOn?: (stepId: string, sessionId: string) => string;
  /** Offered on the card as "Steps", to open the host's journey panel. */
  onShowSteps?: () => void;
  /** The server says the module changed or was switched off; the host refetches its scripts. */
  onChanged?: () => void;
  /**
   * Offers "Skip step" on every card but the closing bridge. Skipping a step that sends a recorded turn seeds
   * that turn first, as a jump does, so later steps find the answer they point at. Off unless a host opts in.
   */
  skippable?: boolean;
}

/** Plays the active module's current step. Steps advance on events their renderer reports, never on timers. */
export function TutorialRunner({
  script,
  steps: stepsProp,
  transport: transportProp,
  quests,
  onStartModule,
  onExit,
  landOn,
  onShowSteps,
  onChanged,
  skippable = false,
}: TutorialRunnerProps) {
  const queryClient = useQueryClient();
  const host = useTutorialHost();
  const steps = stepsProp ?? host.steps;
  const transport = transportProp ?? host.transport;
  const store = useTutorialStoreApi();
  const active = useTutorialStore(state => (state.active?.moduleId === script.id ? state.active : null));
  const step = active ? script.steps.find(s => s.id === active.stepId) : undefined;
  const [anchorOverride, setAnchorOverride] = useState<
    ({ stepId: string; testid: string | undefined } & TutorialAnchorOptions) | null
  >(null);
  const override = anchorOverride?.stepId === step?.id ? anchorOverride : null;
  const anchor = override?.testid ?? step?.anchor;
  const anchorScope = override && 'scope' in override ? override.scope : step?.anchorScope;

  // Ends the walk once the server says its module moved under it. Start over only when there is a module to start.
  const endChanged = useCallback(
    (change: 'changed' | 'off') => {
      const current = store.getState().active;
      if (current?.moduleId !== script.id) return;
      store.getState().end();
      onChanged?.();
      const moduleId = script.id;
      toast(change === 'off' ? OFF_NOTICE : CHANGED_NOTICE, {
        testId: 'tutorial-updated-notice',
        ...(change === 'changed' &&
          onStartModule && {
            action: {
              label: <span data-testid="tutorial-updated-start-over">Start over</span>,
              onClick: () => onStartModule(moduleId),
            },
          }),
      });
    },
    [store, onChanged, onStartModule, script.id]
  );

  const inFlight = useRef<Promise<void> | null>(null);
  const report = useCallback(
    (stepId: string, status: TutorialStatus) => {
      const current = store.getState().active;
      const identity = current?.moduleId === script.id ? { version: current.version, revision: current.revision } : {};
      const send = () =>
        transport.position({ moduleId: script.id, stepId, status, ...identity }).catch(error => {
          // Leaving or finishing is never refused for this, so only a running walk hears it.
          const change = status === 'in_progress' ? moduleChangeOf(error) : undefined;
          if (!change) return;
          try {
            endChanged(change);
          } catch {
            // A throwing host callback must not reject the chain, or later writes never send.
          }
        });
      // One write at a time per run, so a slow earlier position cannot land after a later one.
      const next = inFlight.current ? inFlight.current.then(send) : send();
      inFlight.current = next;
      void next.then(() => {
        if (inFlight.current === next) inFlight.current = null;
      });
    },
    [store, transport, script.id, endChanged]
  );

  const stop = useCallback(
    (status: 'left' | null, notice?: string) => {
      const current = store.getState().active;
      if (current?.moduleId !== script.id) return;
      if (status) report(current.stepId, status);
      store.getState().end();
      if (notice) toast(notice);
    },
    [store, report, script.id]
  );

  const foreign = Boolean(active) && hasForeignQuest(quests);
  useEffect(() => {
    if (foreign) stop('left', LEFT_NOTICE);
  }, [foreign, stop]);

  const missing = Boolean(active) && !step;
  useEffect(() => {
    if (missing) stop(null, CHANGED_NOTICE);
  }, [missing, stop]);

  // Bound to the step it was handed to, so a late or repeated event cannot skip the step after it.
  const completeFrom = useCallback(
    (fromId: string) => {
      const current = store.getState().active;
      if (current?.moduleId !== script.id || current.stepId !== fromId) return;
      const next = script.steps[script.steps.findIndex(s => s.id === fromId) + 1];
      if (next) {
        store.getState().goTo(next.id);
        report(next.id, 'in_progress');
      } else {
        report(fromId, 'finished');
        store.getState().end();
      }
    },
    [store, report, script]
  );

  const advance = useCallback(
    async (turn: number) => {
      const current = store.getState().active;
      if (current?.moduleId !== script.id) return;
      const { quest } = await transport.advance({ moduleId: script.id, sessionId: current.sessionId, turn });
      await setOptimisticQueryData(queryClient, ['quests', 'session', current.sessionId], quest);
    },
    [store, queryClient, transport, script.id]
  );

  const jump = useTutorialStore(state =>
    active && state.pendingJump?.moduleId === script.id ? state.pendingJump : null
  );
  const jumpSeq = useRef(0);
  const jumpInFlight = useRef<Promise<void> | null>(null);
  useEffect(() => {
    const unsubscribe = store.subscribe((state, prior) => {
      if (state.active?.sessionId !== prior.active?.sessionId || state.active?.moduleId !== prior.active?.moduleId) {
        jumpSeq.current++;
      }
    });
    return () => {
      unsubscribe();
      jumpSeq.current++;
    };
  }, [store]);
  useEffect(() => {
    if (!jump) return;
    store.getState().clearJump();
    const target = script.steps.findIndex(s => s.id === jump.stepId);
    const sessionId = store.getState().active?.sessionId;
    if (target < 0 || !sessionId) return;
    const seq = ++jumpSeq.current;
    const isCurrent = () => {
      const current = store.getState().active;
      return seq === jumpSeq.current && current?.moduleId === script.id && current.sessionId === sessionId;
    };
    const previous = jumpInFlight.current;
    const pending = (async () => {
      try {
        // Let an older seed settle before retrying its turn, even when a newer jump supersedes it.
        if (previous) await previous;
        if (!isCurrent()) return;
        for (const s of script.steps.slice(0, target)) {
          if (!isCurrent()) return;
          if (s.turn !== undefined) await advance(s.turn);
        }
        if (!isCurrent()) return;
        const current = store.getState().active!;
        const landing = landOn ? landOn(jump.stepId, sessionId) : jump.stepId;
        if (landing !== current.stepId) clearStalePrompt(script, sessionId);
        store.getState().goTo(landing);
        report(landing, 'in_progress');
        if (landing !== jump.stepId) toast(LANDED_EARLIER_NOTICE);
      } catch (error) {
        if (!isCurrent()) return;
        const change = moduleChangeOf(error);
        if (change) endChanged(change);
        else toast(JUMP_FAILED_NOTICE);
      }
    })().catch(error => console.warn('Tutorial jump callback failed', error));
    jumpInFlight.current = pending;
    void pending.then(() => {
      if (jumpInFlight.current === pending) jumpInFlight.current = null;
    });
  }, [store, jump, script, advance, landOn, report, endChanged]);

  const stepId = step?.id;

  const setAnchor = useCallback(
    (testid: string | undefined, options?: TutorialAnchorOptions) => {
      if (stepId) setAnchorOverride({ stepId, testid, ...options });
    },
    [stepId]
  );
  const [doneStepId, setDoneStepId] = useState<string | null>(null);
  // Reset during render, not in an effect: the new step's mount effects report done before a parent effect would run.
  const [doneFor, setDoneFor] = useState(stepId);
  if (doneFor !== stepId) {
    setDoneFor(stepId);
    setDoneStepId(null);
  }
  const markDone = useCallback(
    (done = true) => {
      if (stepId) setDoneStepId(prev => (done ? stepId : prev === stepId ? null : prev));
    },
    [stepId]
  );

  const skipping = useRef(false);
  const skip = useCallback(async () => {
    const current = store.getState().active;
    if (!step || skipping.current || current?.moduleId !== script.id || current.stepId !== step.id) return;
    skipping.current = true;
    try {
      const turn = step.turn;
      const seeded = turn !== undefined && (quests ?? NO_QUESTS).some(q => markedTurn(q) === turn);
      const sentByUser =
        Boolean(step.prompt) && (quests ?? NO_QUESTS).some(q => q.prompt && samePrompt(q.prompt, step.prompt!));
      // Wait out a pending jump so seeded turns land in order.
      await jumpInFlight.current;
      if (turn !== undefined && !seeded && !sentByUser) await advance(turn);
      const after = store.getState().active;
      // The walk may have ended or moved on while the turn was seeded.
      if (after?.moduleId !== script.id || after.stepId !== step.id) return;
      clearStalePrompt(script, current.sessionId);
      completeFrom(step.id);
    } catch (error) {
      const change = moduleChangeOf(error);
      if (change) endChanged(change);
      else toast(SKIP_FAILED_NOTICE);
    } finally {
      skipping.current = false;
    }
  }, [store, step, script, quests, advance, completeFrom, endChanged]);
  const sheetFileId = useCallback(
    async () => (await transport.sheet({ moduleId: script.id })).fileId,
    [transport, script.id]
  );

  if (!active || !step) return null;
  const Step = steps[step.type] ?? StepFallback;
  const progress = stepProgress(script, step.id);

  return (
    <>
      <HideUnusedComposerChips script={script} />
      <CoachMark
        stepKey={step.id}
        title={step.title}
        body={doneStepId === step.id && step.doneBody ? step.doneBody : step.body}
        done={doneStepId === step.id}
        anchor={anchor}
        anchorScope={anchorScope}
        placement={cardSide(step, override)}
        avoid={override?.avoid ?? step.avoid}
        width={step.cardWidth}
        panel={step.layout === 'panel'}
        // Closing the card that ends the module finishes it: there is nothing left to pause.
        onLeave={step.type === 'bridge' ? () => completeFrom(step.id) : () => stop('left', PAUSED_NOTICE)}
        // The closing card's Done finishes the module; there is nothing left to leave.
        offerLeave={step.type !== 'bridge'}
        onShowSteps={onShowSteps}
        onSkip={skippable && step.type !== 'bridge' ? () => void skip() : undefined}
        progress={progress}
        heading={progress ? undefined : bridgeHeading(script)}
      >
        <Step
          key={step.id}
          step={step}
          sessionId={active.sessionId}
          quests={quests ?? NO_QUESTS}
          complete={() => completeFrom(step.id)}
          advance={advance}
          startModule={onStartModule}
          exit={onExit}
          setAnchor={setAnchor}
          anchor={anchor}
          anchorScope={anchorScope}
          markDone={markDone}
          sheetFileId={sheetFileId}
        />
      </CoachMark>
    </>
  );
}
