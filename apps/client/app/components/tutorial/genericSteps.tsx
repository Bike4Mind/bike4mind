import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, GlobalStyles, Stack, Typography } from '@mui/joy';
import { useWorkBenchFiles } from '@client/app/contexts/SessionsContext';
import { useChatInput } from '@client/app/hooks/useChatInput';
import { markedTurn, samePrompt, type TutorialCardSide } from '@bike4mind/common';
import { useAgentModeCue } from './agentMode';
import type { TutorialStepProps, TutorialStepRegistry } from './types';

export const SEND_ANCHOR = 'send-message-btn';

/**
 * Pastes the turn's prompt into the chat composer and points at its send button. The user sends it,
 * and the step moves on once the recorded reply has answered it.
 */
export function PromptStep({ step, sessionId, quests, complete, setAnchor }: TutorialStepProps) {
  const sent = Boolean(step.prompt) && quests.some(q => q.prompt && samePrompt(q.prompt, step.prompt!));
  const answered = quests.some(q => q.status !== 'running' && markedTurn(q) === step.turn);
  const agentCue = useAgentModeCue();
  const cue = sent ? null : agentCue;

  // A cue's control can sit outside the step's scope (the phone menu is a drawer portalled to the body).
  const cueAnchor = cue?.anchor;
  useEffect(
    () => setAnchor(cueAnchor, cueAnchor === undefined ? undefined : { scope: undefined }),
    [cueAnchor, setAnchor]
  );

  const paste = useCallback(() => {
    if (!step.prompt) return;
    const input = useChatInput.getState();
    input.setDraft(sessionId, step.prompt);
    input.setChatInputValue(step.prompt);
    input.requestFocus();
  }, [sessionId, step.prompt]);

  // Turn 0 is sent from the host's start box and may still be in flight, so it is pasted only on request
  // (a resume whose opening never landed). Never over text the user is typing.
  useEffect(() => {
    if (step.turn !== 0 && !sent && !useChatInput.getState().chatInputValue.trim()) paste();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Once the turn is sent, the prompt still in the composer is a stale copy of it, whether the send left it there
  // or a draft restore put it back afterwards. Text the user typed is left alone.
  useEffect(() => {
    if (!sent || !step.prompt) return;
    const prompt = step.prompt;
    const clearSent = () => {
      const input = useChatInput.getState();
      if (!input.chatInputValue.trim() || !samePrompt(input.chatInputValue, prompt)) return;
      input.setChatInputValue('');
      input.clearDraft(sessionId);
    };
    clearSent();
    return useChatInput.subscribe(clearSent);
  }, [sent, step.prompt, sessionId]);

  useEffect(() => {
    if (answered) complete();
  }, [answered, complete]);

  return (
    <Stack direction="row" alignItems="center" justifyContent="flex-end" gap={1}>
      {cue && (
        <Typography level="body-sm" color="warning" sx={{ flex: 1 }} data-testid="tutorial-agent-mode-hint">
          {cue.hint}
        </Typography>
      )}
      {sent ? (
        <Typography level="body-xs" data-testid="tutorial-step-waiting">
          Sent. The answer is on its way.
        </Typography>
      ) : (
        <Button size="sm" variant="plain" onClick={paste} data-testid="tutorial-step-paste">
          {step.turn === 0 ? 'Paste the message' : 'Paste it again'}
        </Button>
      )}
    </Stack>
  );
}

const ADD_BUTTON = 'file-browser-add-files-btn';

/**
 * The File Browser's bulk actions, which sit beside Add once a file is selected: one slip on Delete
 * removes the module's sheet mid-demo. The attach step hides them by testid, since the toolbar is core's.
 */
const BULK_FILE_ACTIONS = [
  'file-browser-delete-btn',
  'file-browser-share-btn',
  'file-browser-tag-menu-btn',
  'file-browser-lake-menu-btn',
  'file-browser-select-all-btn',
];

/** Must stay in sync with CoachMark's step pill testid. */
const COACH_PILL = 'tutorial-coach-pill';

/**
 * Hides the bulk actions for as long as it is mounted, so they come back when the step ends or the user
 * leaves. A card tucked into its pill stays mounted, so the rule also stands down while the pill shows.
 * Only the attach dialog's toolbar: other file browsers open meanwhile keep theirs.
 */
const HIDE_BULK_FILE_ACTIONS_SELECTOR = `body:not(:has([data-testid="${COACH_PILL}"])) [data-testid="file-browser-dialog"] :is(${BULK_FILE_ACTIONS.map(
  testid => `[data-testid="${testid}"]`
).join(', ')})`;

function HideBulkFileActions() {
  return <GlobalStyles styles={{ [HIDE_BULK_FILE_ACTIONS_SELECTOR]: { display: 'none !important' } }} />;
}
const FILE_ROWS = ['file-browser-list-item', 'file-browser-grid-item-card'];
const DEFAULT_ADD_LABEL = 'Add 1 File to Notebook';

export interface AttachCue {
  anchor: string | undefined;
  hint: string;
  placement?: TutorialCardSide;
}

const byTestid = (root: ParentNode, testid: string) =>
  root.querySelector<HTMLElement>(`[data-testid="${CSS.escape(testid)}"]`);

/**
 * What the attach card points at and says. In the File Browser it rings the sheet itself, then Add once a
 * file is selected. The card finds anchors by testid, so a row is rung only while it is the first one.
 */
export function readAttachCue(fileId: string | null, fileName: string): AttachCue {
  const dialog = byTestid(document, 'file-browser-dialog');
  if (!dialog) {
    return byTestid(document, 'add-from-file-browser-btn')
      ? { anchor: 'add-from-file-browser-btn', hint: 'Choose Add from File Browser.', placement: 'right' }
      : { anchor: undefined, hint: 'Press the + button beside the message box.' };
  }
  const add = byTestid(dialog, ADD_BUTTON);
  if (add && !(add as HTMLButtonElement).disabled) {
    const label = add.textContent?.trim() || DEFAULT_ADD_LABEL;
    return { anchor: ADD_BUTTON, hint: `Press ${label} to add ${fileName}.` };
  }
  if (fileId && byTestid(dialog, `recent-file-${fileId}`)) {
    return { anchor: `recent-file-${fileId}`, hint: `Select ${fileName}.` };
  }
  const row = FILE_ROWS.find(testid => {
    const first = byTestid(dialog, testid);
    if (!first) return false;
    const name = byTestid(first, 'file-browser-item-name');
    if (name) return name.textContent?.trim() === fileName;
    return Array.from(first.querySelectorAll('[title]')).some(node => node.getAttribute('title') === fileName);
  });
  if (row) return { anchor: row, hint: `Select ${fileName}.` };
  if (byTestid(dialog, 'file-browser-search-input')) {
    return { anchor: 'file-browser-search-input', hint: `Search for ${fileName}, then select it.` };
  }
  return { anchor: ADD_BUTTON, hint: `Select ${fileName}, then press ${DEFAULT_ADD_LABEL}.` };
}

/** Follows the attach flow as the user opens it, searches, and selects. */
function useAttachCue(fileId: string | null, fileName: string): AttachCue {
  const [cue, setCue] = useState<AttachCue>(() => readAttachCue(fileId, fileName));
  useEffect(() => {
    const sync = () => {
      const next = readAttachCue(fileId, fileName);
      setCue(current => (current.anchor === next.anchor && current.hint === next.hint ? current : next));
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['disabled'],
    });
    return () => observer.disconnect();
  }, [fileId, fileName]);
  return cue;
}

/**
 * Walks the user through the chat's own attach flow, a control at a time, and moves on once the
 * module's sheet is in the session. `params.fileName` names the sheet as the File Browser lists it.
 */
export function AttachStep({ step, sessionId, complete, setAnchor, sheetFileId }: TutorialStepProps) {
  const files = useWorkBenchFiles(sessionId);
  const [fileId, setFileId] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const fileName = typeof step.params?.fileName === 'string' ? step.params.fileName : 'the sheet';

  useEffect(() => {
    let live = true;
    setFailed(false);
    sheetFileId()
      .then(id => live && setFileId(id))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [sheetFileId, attempt]);

  const cue = useAttachCue(fileId, fileName);
  useEffect(
    () => setAnchor(cue.anchor, cue.placement && { placement: cue.placement }),
    [cue.anchor, cue.placement, setAnchor]
  );

  const attached =
    fileId !== null &&
    files.some(
      file => String((file as { id?: unknown; _id?: unknown }).id ?? (file as { _id?: unknown })._id) === fileId
    );
  useEffect(() => {
    if (attached) complete();
  }, [attached, complete]);

  if (failed) {
    return (
      <Stack direction="row" alignItems="center" justifyContent="space-between" gap={1}>
        <HideBulkFileActions />
        <Typography level="body-sm" data-testid="tutorial-attach-hint" color="danger">
          Could not look up {fileName}. Try again, or start the tutorial over to add it again.
        </Typography>
        <Button size="sm" variant="plain" onClick={() => setAttempt(n => n + 1)} data-testid="tutorial-attach-retry">
          Try again
        </Button>
      </Stack>
    );
  }
  return (
    <>
      <HideBulkFileActions />
      <Typography level="body-sm" data-testid="tutorial-attach-hint">
        {cue.hint}
      </Typography>
    </>
  );
}

/** Explains what is on screen; the user moves on when ready. */
export function PointStep({ step, complete }: TutorialStepProps) {
  return (
    <Stack direction="row" justifyContent="flex-end">
      <Button size="sm" variant="solid" onClick={complete} data-testid="tutorial-step-next" data-tutorial-primary>
        {step.action ?? 'Next'}
      </Button>
    </Stack>
  );
}

const DISMISS_GRACE_MS = 1000;

/** Waits for the user to close whatever the step's anchor belongs to, so the next card is not hidden behind it. */
export function DismissStep(props: TutorialStepProps) {
  const { step, complete } = props;
  const anchor = props.anchor ?? step.anchor;
  const scope = 'anchorScope' in props ? props.anchorScope : step.anchorScope;
  const open = useCallback(
    () => Boolean(anchor && document.querySelector(`${scope ? `${scope} ` : ''}[data-testid="${CSS.escape(anchor)}"]`)),
    [anchor, scope]
  );
  const seen = useRef(false);
  const [gone, setGone] = useState(!anchor);
  useEffect(() => {
    const check = () => {
      if (open()) seen.current = true;
      else if (seen.current) setGone(true);
    };
    check();
    const observer = new MutationObserver(check);
    observer.observe(document.body, { childList: true, subtree: true });
    // An anchor that never shows up has nothing to wait for.
    const grace = setTimeout(() => !seen.current && setGone(true), DISMISS_GRACE_MS);
    return () => {
      observer.disconnect();
      clearTimeout(grace);
    };
  }, [open]);
  useEffect(() => {
    if (gone) complete();
  }, [gone, complete]);
  return null;
}

// A host draws its own closing card over `bridge`; without one, the card closes on its action.
export const GENERIC_TUTORIAL_STEPS: TutorialStepRegistry = {
  prompt: PromptStep,
  attach: AttachStep,
  point: PointStep,
  dismiss: DismissStep,
  bridge: PointStep,
};
