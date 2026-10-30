import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
  type SyntheticEvent,
} from 'react';
import Alert from '@mui/joy/Alert';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import CircularProgress from '@mui/joy/CircularProgress';
import IconButton from '@mui/joy/IconButton';
import Stack from '@mui/joy/Stack';
import Textarea from '@mui/joy/Textarea';
import Tooltip from '@mui/joy/Tooltip';
import Typography from '@mui/joy/Typography';
import type { ChatQueuedMessage, ChatSessionMode } from '@shared/chat';
import { AttachmentRow } from './Attachments';
import { findCommand, matchCommands, type ComposerCommand } from './commands';
import { ComposerHighlight, type HighlightToken } from './ComposerHighlight';
import {
  attachShortcut,
  COMPOSER_BUTTON_LABELS,
  composerButtonAction,
  composerEscapeAction,
  composerKeyAction,
  composerMenuAction,
  composerPlaceholder,
  composerSubmitAction,
  isAttachChord,
  shownSuggestion,
} from './composerInput';
import { useShowDollarCosts } from './costDisplay';
import { ArrowUpIcon, StopIcon } from './icons';
import { contentColumnSx } from './layout';
import { isMac } from './platform';
import { QueuedMessageList } from './QueuedMessageList';
import { mergeIntoDraft } from './queuedMessages';
import { highlightedTokens, insertSkill, matchSkills, skillChipColor, skillQuery } from './skillMenu';
import { SkillPicker } from './SkillPicker';
import {
  allowanceArc,
  allowanceColor,
  creditAllowancePercent,
  describeUsage,
  usageLabel,
  type ComposerUsage,
} from './statusLine';
import { toAttachmentInputs, type AttachmentDraft } from './useAttachments';
import type { SkillsController } from './useSkills';

const ATTACH_SHORTCUT = attachShortcut(isMac);

// Joy's Switch, Checkbox, Radio and Slider are all inputs, and focus stays on one after a click.
const TEXT_FIELD = [
  'textarea',
  'select',
  'input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="file"]):not([type="color"])',
].join(', ');

function isTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.matches(TEXT_FIELD);
}

export function Composer({
  sessionId,
  disabled,
  streaming,
  attachments,
  blockedReason,
  blockedAction,
  notReady,
  usage,
  placeholder = 'Send a message...',
  disabledPlaceholder,
  onSend,
  onStop,
  onRunCommand,
  sessionMode = 'chat',
  queued,
  onCancelQueued,
  onSendQueuedNow,
  returned,
  onReturnedConsumed,
  fill,
  onFillConsumed,
  footer,
  leading,
  skills,
  suggestion,
  onSuggestionDismissed,
  onBrowseSkillMarket,
}: {
  sessionId: string | null;
  disabled: boolean;
  streaming: boolean;
  attachments: AttachmentDraft;
  /** Prompt for an empty composer. A Code session asks for a task, a Chat session for a message. */
  placeholder?: string;
  /**
   * Why this turn cannot be sent as composed - an image on a model known not to read them, or
   * a Code session with no project folder chosen. Shown in full and blocks Send: the
   * alternative is a request that is refused for reasons the user never sees.
   */
  blockedReason?: string | null;
  /** A button beside `blockedReason` that fixes it. */
  blockedAction?: { label: string; onClick: () => void } | null;
  /**
   * A word for the idle indicator naming a state that is not ready to send - "No folder" for a
   * Code session with no project. It blocks Send and draws NO banner: the control that answers
   * it is a few pixels above, and a line of prose repeating what that control already says is
   * noise. Main refuses the turn regardless; this is so the button agrees with it.
   */
  notReady?: string | null;
  /**
   * What the idle indicator says INSTEAD of a bare "Ready": the personal credit balance against
   * its monthly allowance. Only the idle case - the three states above all name something the user may
   * need to act on, and those still win.
   */
  usage?: ComposerUsage | null;
  /**
   * What the placeholder says while `disabled` holds - the step that IS open, named by the
   * owner, which is the only side that knows whether there is no session, or one being made.
   */
  disabledPlaceholder?: string;
  onSend: (text: string) => void;
  onStop: () => void;
  /**
   * Run a slash command. Omitted in tests and in any host that offers none, which leaves the
   * command rows out of the `/` menu and `/clear` an ordinary message.
   *
   * It is a separate channel from `onSend` on purpose: a command is an action this app takes,
   * and nothing typed here can reach the model through it. See commands.ts.
   */
  onRunCommand?: (name: string, args: string) => void;
  /** Opens the Skill Market, offered from the `/` menu when there are no skills to pick. */
  onBrowseSkillMarket?: () => void;
  /** Decides which commands are offered: some act only on a Code session. */
  sessionMode?: ChatSessionMode;
  /** Typed ahead of the live turn, waiting to be sent. Drawn above the input. */
  queued?: readonly ChatQueuedMessage[];
  onCancelQueued?: (queuedId: string) => void;
  /**
   * Cut a queued message in front of the reply it is waiting behind: the live turn is stopped
   * and this one runs next. Only offered while `streaming` - see QueuedMessageList.
   */
  onSendQueuedNow?: (queuedId: string) => void;
  /**
   * Messages the queue handed back, to take into the draft. Anything the user is midway
   * through typing is kept: the returned text is appended to it, never swapped for it.
   * `onReturnedConsumed` acknowledges the batch so it is taken in exactly once.
   */
  returned?: { id: number; messages: ChatQueuedMessage[] } | null;
  onReturnedConsumed?: () => void;
  /**
   * Text to put in the box in place of the draft, focused with the caret at its end - a blank
   * chat's suggestion. Taken once per id, like `returned`, so picking the same card twice works.
   */
  fill?: { id: number; text: string } | null;
  onFillConsumed?: () => void;
  /** Controls that belong to the next turn rather than to the app - the model picker. */
  footer?: ReactNode;
  /**
   * Sits beside the attach button, on the left of the same row - the approval-mode pill. Its
   * place is load-bearing: a permission the user cannot see without opening something is a
   * permission they will forget they granted.
   */
  leading?: ReactNode;
  /**
   * The skills `/name` can run here. Omitted in tests and in any host that has none, which
   * simply leaves `/` an ordinary character.
   */
  skills?: SkillsController;
  /**
   * A guess at the next message, drawn greyed out INSIDE the empty input - the one place a user
   * looking at a finished reply is already looking. Tab takes it into the draft.
   *
   * It is a draft and never a turn. Tab fills the box and stops there; Enter still sends
   * whatever is actually in the box, so taking a suggestion and sending it are two separate
   * keystrokes with the user's own decision in between. Nothing here submits, and there is no
   * setting that makes it - a hint that sent itself would let model output choose the next turn.
   */
  suggestion?: string | null;
  /**
   * A draft went out, so the hint has served its turn. Typing over it or taking it with Tab does
   * NOT end it: emptying the box again brings it back, until a send or the next turn.
   */
  onSuggestionDismissed?: () => void;
}) {
  const showDollars = useShowDollarCosts();
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // Where the caret is, so the `/` menu answers the token being typed wherever it sits in the draft.
  const [caret, setCaret] = useState(0);
  // A caret position to restore once a programmatic draft change has rendered.
  const pendingCaret = useRef<number | null>(null);

  /** Replace the draft and put the caret at `at` (the end by default), as typing would have. */
  const replaceDraft = (next: string, at: number = next.length) => {
    setText(next);
    setCaret(at);
    pendingCaret.current = at;
  };

  useLayoutEffect(() => {
    const target = pendingCaret.current;
    if (target === null) return;
    pendingCaret.current = null;
    textareaRef.current?.setSelectionRange(target, target);
  }, [text]);

  const hasContent = text.trim().length > 0 || attachments.attachments.length > 0;
  const blocked = !!blockedReason || !!notReady;

  const shownUsage = !disabled && !notReady ? (usage ?? null) : null;
  const usageText = shownUsage && usageLabel(shownUsage);
  const usageDetail = shownUsage ? describeUsage(shownUsage, showDollars) : null;
  const allowancePercent = shownUsage
    ? creditAllowancePercent(shownUsage.credits, shownUsage.monthlyAllowance ?? null)
    : null;

  // See composerInput.ts for what wins here and why.
  const shown = shownSuggestion({ disabled, text, suggestion });
  // `streaming` is NOT here: a send during a live turn is queued, not dropped. It used to be
  // the first condition, which is why pressing Enter mid-reply did nothing at all.
  const canSubmit = hasContent && !disabled && !attachments.busy && !blocked;

  // A draft that names a command is sendable whatever is blocking a TURN: see submit. Without
  // this the button would sit disabled on `/clear` in exactly the conversations most in need of
  // it, while Enter ran it anyway.
  const commandDraft = !!onRunCommand && !disabled && composerSubmitAction(text, sessionMode).kind === 'command';

  // Which of Send/Stop/Queue the one button is. See composerButtonAction, and
  // composerEscapeAction for the way to Stop that Queue takes the button away from.
  // A command draft is never queued: it is an action on this conversation, not the next turn,
  // so the button has to offer to run it now rather than to hold it behind the live reply.
  const buttonAction = composerButtonAction({ streaming: streaming && !commandDraft, hasContent });

  /**
   * Send what is in the box - or run it, when what is in the box names a command.
   *
   * The command branch bypasses `canSubmit`'s attachment and blocked checks, because those
   * describe a TURN: `/clear` with an image half uploaded, or in a Code session with no folder
   * chosen, is still a perfectly good thing to ask for. It does need a conversation to act on,
   * which `disabled` is.
   */
  const submit = () => {
    const draft = text.trim();
    const action = composerSubmitAction(draft, sessionMode);
    if (action.kind === 'command' && onRunCommand && !disabled) {
      replaceDraft('');
      onSuggestionDismissed?.();
      onRunCommand(action.invocation.command.name, action.invocation.args);
      return;
    }
    if (!canSubmit) return;
    replaceDraft('');
    onSuggestionDismissed?.();
    onSend(draft);
  };

  // Text coming back out of the queue - cancelled, or its turn stopped or failed. Tracked by
  // batch id rather than by content, so cancelling the same message twice lands twice, and so a
  // re-render between the merge and the acknowledgement cannot merge it again.
  const consumedReturn = useRef<number | null>(null);
  useEffect(() => {
    if (!returned || consumedReturn.current === returned.id) return;
    consumedReturn.current = returned.id;
    setText(current => mergeIntoDraft(current, returned.messages));
    onReturnedConsumed?.();
  }, [returned, onReturnedConsumed]);

  const consumedFill = useRef<number | null>(null);
  const [caretRequest, setCaretRequest] = useState(0);
  useEffect(() => {
    if (!fill || consumedFill.current === fill.id) return;
    consumedFill.current = fill.id;
    setText(fill.text);
    setCaretRequest(request => request + 1);
    onFillConsumed?.();
  }, [fill, onFillConsumed]);
  // After the commit that put the text in, so the caret lands past it and not at its old length.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!caretRequest || !el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [caretRequest]);

  /**
   * The `/` menu.
   *
   * Open is DERIVED from the text and caret rather than stored, so there is no state to get out
   * of step with what is on screen: the menu is showing exactly when the caret ends a bare
   * `/token`, at the start of the draft or after a space (see skillQuery). Escape is the one
   * thing that needs memory, and it is remembered against the text that was dismissed - so
   * typing another character brings the menu back, which is what makes Escape "not this one"
   * rather than "not until I reload".
   *
   * Commands are offered only when the token is the whole draft: running one replaces the turn,
   * so a command taken from mid-sentence would discard the sentence. Skills go anywhere.
   */
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const token = (skills || onRunCommand) && !disabled ? skillQuery(text, caret) : null;
  const query = token?.query ?? null;
  const offerCommands = !!onRunCommand && !!token?.wholeDraft;
  const commandMatches = useMemo(
    () => (offerCommands && query !== null ? matchCommands(query, sessionMode) : []),
    [offerCommands, query, sessionMode]
  );
  const wholeDraft = token?.wholeDraft;
  const matches = useMemo(
    () => (skills && query !== null ? matchSkills(skills.skills, query, !wholeDraft) : []),
    [skills, query, wholeDraft]
  );
  // One list for the keyboard: commands first, then skills, which is also the order drawn.
  const menuCount = commandMatches.length + matches.length;
  const pickerOpen = query !== null && dismissed !== text && (menuCount > 0 || !!skills);

  // Whenever the filter changes the old highlight means nothing: it pointed into a different
  // list, and leaving it would arm Enter with whatever now happens to sit at that index.
  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  // Re-read on the keystroke that opens the menu, not on an interval: a skill written since the
  // window opened should be there, and this is the only moment anyone is looking.
  const justOpened = useRef(false);
  useEffect(() => {
    if (!pickerOpen) {
      justOpened.current = false;
      return;
    }
    if (justOpened.current) return;
    justOpened.current = true;
    void skills?.refresh();
  }, [pickerOpen, skills]);

  const pick = (name: string) => {
    if (!token) return;
    // In place, so a skill picked mid-sentence keeps the words around it. See insertSkill for
    // the trailing space, which is what closes the menu.
    const next = insertSkill(text, token, name);
    replaceDraft(next.text, next.caret);
    setDismissed(null);
    textareaRef.current?.focus();
  };

  /**
   * The tokens drawn as pills behind the text: known skills anywhere, a command only where it
   * would run. Coloured like the picker's source chips, so the pill says where a skill came from.
   */
  const highlights = useMemo<HighlightToken[]>(() => {
    const bySkill = new Map((skills?.skills ?? []).map(skill => [skill.name, skill]));
    const isCommand = (name: string) => !!onRunCommand && !!findCommand(name, sessionMode);
    return highlightedTokens(text, new Set(bySkill.keys()), isCommand).map(mention => {
      const skill = bySkill.get(mention.name);
      return { ...mention, color: skill ? skillChipColor(skill.source) : 'primary' };
    });
  }, [text, skills, onRunCommand, sessionMode]);

  /**
   * Taking a command out of the menu RUNS it, where taking a skill only fills the draft.
   *
   * The difference is which way round the argument works. A skill's arguments are the point of
   * invoking it, so the menu hands the user a line to finish; a command's are optional, and
   * `/compact focus on the auth work` is typed in full and sent without the menu being involved
   * at all - by then the draft is no longer a bare token, so the menu has already closed.
   */
  const runCommand = (command: ComposerCommand) => {
    setDismissed(null);
    if (command.requiresArgument) {
      replaceDraft(`/${command.name} `);
      textareaRef.current?.focus();
      return;
    }
    replaceDraft('');
    onRunCommand?.(command.name, '');
    textareaRef.current?.focus();
  };

  const takeMenuRow = (index: number) => {
    const command = commandMatches[index];
    if (command) {
      runCommand(command);
      return;
    }
    const skill = matches[index - commandMatches.length];
    if (skill) pick(skill.name);
  };

  /**
   * Enter sends, Shift+Enter breaks the line, Tab takes the hint, Escape closes the menu or
   * stops the turn. Which is which lives in composerInput.ts, where the rule that accepting is
   * not sending and the rule that Escape stops a live turn are both stated and tested.
   *
   * The skill menu is asked FIRST, because while it is open it is the list the user is looking
   * at and Enter/Tab/Escape belong to it. Enter and Tab cannot both be wanted in practice - a
   * suggestion is only offered into an EMPTY input, and the menu only opens once a `/` has been
   * typed - but the order is stated rather than left to that coincidence, so a later change to
   * either condition cannot quietly make Tab do the wrong one. Escape genuinely is contested,
   * and its precedence is decided in one place rather than by where the branches happen to sit.
   */
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      const escape = composerEscapeAction({ pickerOpen, streaming });
      if (escape === 'default') return;
      event.preventDefault();
      if (escape === 'dismiss-picker') setDismissed(text);
      else onStop();
      return;
    }

    const menu = composerMenuAction(event.key, event.shiftKey, { open: pickerOpen, count: menuCount });
    if (menu !== 'default') {
      event.preventDefault();
      if (menu === 'next') setActiveIndex(current => (current + 1) % menuCount);
      else if (menu === 'previous') setActiveIndex(current => (current - 1 + menuCount) % menuCount);
      else takeMenuRow(Math.min(activeIndex, menuCount - 1));
      return;
    }

    const action = composerKeyAction(event.key, event.shiftKey, !!shown);
    if (action === 'default') return;
    event.preventDefault();
    if (action === 'submit') {
      submit();
      return;
    }
    // Fills the draft and stops. The user still has to press Enter, on text they can now read
    // and edit - which is the whole reason this is a different key from the one that sends.
    if (shown) replaceDraft(shown);
  };

  // Read inside the window listener so it is bound once, not rebuilt on every draft keystroke.
  const attach = useRef({ blocked: disabled || attachments.busy, pick: attachments.pick });
  attach.current = { blocked: disabled || attachments.busy, pick: attachments.pick };

  /**
   * Cmd/Ctrl+U opens the picker wherever focus is on the conversation screen - the draft, a
   * button, or nothing - except another text field, which is someone typing elsewhere, and
   * under a modal. The settings, customize and artifacts screens need no check: they replace
   * the conversation, and unmount this component with it.
   */
  useEffect(() => {
    const onWindowKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || !isAttachChord(event)) return;
      if (event.target !== textareaRef.current && isTextField(event.target)) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      event.preventDefault();
      // A held chord auto-repeats, and each repeat would queue another OS dialog behind this one.
      if (event.repeat || attach.current.blocked) return;
      void attach.current.pick();
    };
    window.addEventListener('keydown', onWindowKeyDown);
    return () => window.removeEventListener('keydown', onWindowKeyDown);
  }, []);

  /**
   * The screenshot path, and the one that has to feel free: cmd-shift-4 then cmd-v.
   *
   * Only claims the paste when the clipboard actually carries files. Pasting text alongside an
   * image (a browser copy) must still land in the textarea, so the default is left alone unless
   * there is nothing but files to take.
   */
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData?.files ?? []);
    if (files.length === 0) return;
    event.preventDefault();
    void toAttachmentInputs(files).then(inputs => attachments.add(inputs));
  };

  return (
    <Box>
      {attachments.rejected.length > 0 && (
        <Box sx={{ ...contentColumnSx, mt: 1 }}>
          <Alert
            size="sm"
            color="warning"
            variant="soft"
            sx={{ cursor: 'pointer' }}
            onClick={attachments.dismissRejected}
            data-testid="attachment-rejected"
          >
            <Stack>
              {attachments.rejected.map(item => (
                <Typography key={`${item.name}:${item.reason}`} level="body-xs">
                  {item.name}: {item.reason}
                </Typography>
              ))}
            </Stack>
          </Alert>
        </Box>
      )}

      {blockedReason && (
        <Box sx={{ ...contentColumnSx, mt: 1 }}>
          <Alert
            size="sm"
            color="warning"
            variant="soft"
            data-testid="composer-blocked-reason"
            endDecorator={
              blockedAction && (
                <Button
                  size="sm"
                  variant="soft"
                  color="warning"
                  onClick={blockedAction.onClick}
                  data-testid="composer-blocked-action-btn"
                >
                  {blockedAction.label}
                </Button>
              )
            }
          >
            {blockedReason}
          </Alert>
        </Box>
      )}

      <QueuedMessageList
        messages={queued ?? []}
        onCancel={onCancelQueued ?? (() => undefined)}
        onSendNow={onSendQueuedNow}
        canSendNow={streaming}
      />

      {attachments.attachments.length > 0 && (
        <Box sx={{ ...contentColumnSx, pt: 1.5 }}>
          <AttachmentRow sessionId={sessionId} attachments={attachments.attachments} onRemove={attachments.remove} />
        </Box>
      )}

      {/* Above the input, where an autocomplete belongs: the list has to sit between what was
          typed and the transcript, not cover the transcript the user is answering. */}
      {pickerOpen && (
        <SkillPicker
          commands={commandMatches}
          skills={matches}
          activeIndex={activeIndex}
          untrustedProject={skills?.untrustedProject ?? null}
          onPickCommand={runCommand}
          onPick={skill => pick(skill.name)}
          onTrustProject={() => void skills?.trustProject()}
          onBrowseMarket={onBrowseSkillMarket}
        />
      )}

      <Box sx={{ ...contentColumnSx, pt: 1.5 }}>
        {/* The button rides INSIDE the input rather than beside it. As a sibling in a row it
            took its own width out of the column, so the input's right edge stopped ~74px short
            of where the transcript ends while every other composer row reached it. */}
        <Textarea
          value={text}
          // Only hides the hint (see shownSuggestion), never ends it: emptying the box again
          // brings the same guess back, since nothing has been sent and it still fits the reply.
          onChange={event => {
            pendingCaret.current = null;
            setText(event.target.value);
            setCaret(event.target.selectionStart);
          }}
          onKeyDown={onKeyDown}
          placeholder={composerPlaceholder({ disabled, text, suggestion, placeholder, disabledPlaceholder })}
          disabled={disabled}
          minRows={1}
          maxRows={8}
          // Joy lays a Textarea's root out as a COLUMN, which is what put Send on a second line
          // inside the border. A row puts it on the text's line, and flex-end keeps it against
          // the last one as the box grows. The button stays a flex item rather than being lifted
          // out and positioned over the text, so the width it needs is subtracted from the
          // text's by the layout itself - which is what keeps text off it as the button swaps
          // between states mid-reply. Nothing reserves a fixed width for it, so collapsing the
          // pair to one control needed no number changed here.
          // fontSize rather than size="sm": the smaller size would also shrink the padding and
          // the min-height, and it is only the text that reads too large here. The inner
          // textarea inherits it, so this sets the placeholder and the suggestion hint too.
          // `position: relative` anchors the skill highlight, which is laid over the textarea.
          sx={{ flexDirection: 'row', alignItems: 'flex-end', fontSize: 'sm', position: 'relative' }}
          startDecorator={
            highlights.length > 0 ? (
              <ComposerHighlight text={text} tokens={highlights} textareaRef={textareaRef} />
            ) : undefined
          }
          endDecorator={
            /* One button, never two. Stopping this turn and queueing the next one are still
               different intentions - that has not stopped being true - but a pair of buttons in
               the corner the user is already typing in made the common click a choice, and only
               ever one of the two is the obvious one. So the button is whichever the state makes
               obvious, and the intention it displaces keeps a way through: Escape stops the
               running turn whatever is in the draft, which is what makes Queue safe to show in
               Stop's place. See composerButtonAction and composerEscapeAction.

               The testid stays `chat-send-btn` through all three states rather than changing
               under a test that thought it was asserting presence; `data-composer-action` is
               what says which control this is. */
            <Tooltip
              title={buttonAction === 'stop' ? 'Stop generating (Esc)' : COMPOSER_BUTTON_LABELS[buttonAction]}
              size="sm"
              variant="soft"
              placement="top"
            >
              {/* Wrapped so the tooltip still has an element to hang off while Send is
                  disabled - a disabled button fires no pointer events of its own. */}
              <Box component="span" sx={{ display: 'inline-flex' }}>
                <IconButton
                  size="sm"
                  variant={buttonAction === 'stop' ? 'soft' : 'solid'}
                  color={buttonAction === 'stop' ? 'neutral' : 'primary'}
                  onClick={buttonAction === 'stop' ? onStop : submit}
                  disabled={buttonAction !== 'stop' && !canSubmit && !commandDraft}
                  aria-label={COMPOSER_BUTTON_LABELS[buttonAction]}
                  data-composer-action={buttonAction}
                  data-testid="chat-send-btn"
                >
                  {buttonAction === 'stop' ? <StopIcon /> : <ArrowUpIcon />}
                </IconButton>
              </Box>
            </Tooltip>
          }
          // onPaste goes on the inner textarea, not Joy's root: the root is a div, and typing
          // the handler for it would lose the element the paste actually happened in.
          slotProps={{
            // Joy's own decorator margins assume the column: a gap ABOVE, and an inline-start
            // pulled back by the difference between the two paddings. In a row that gap is the
            // wrong axis and the negative start would drag the button over the text. The gap
            // between text and button is the textarea's own paddingInlineEnd.
            endDecorator: { sx: { marginBlockStart: 0, marginInlineStart: 0 } },
            // The highlight layer, lifted out of the flex row so it takes no width, and under
            // the textarea (which is raised and transparent) so clicks and text stay its own.
            startDecorator: {
              sx: { position: 'absolute', inset: 0, margin: 0, display: 'block', pointerEvents: 'none' },
            },
            textarea: {
              // Joy stretches the textarea to the flex line, and the button's min-height makes
              // that line taller than one line of text - so the text rendered at the top of the
              // band and every spare pixel fell underneath it (6px above, 13px below). Centring
              // splits them. Only bites while the box is one row; once the text is the tallest
              // item it drives the height itself and this does nothing.
              sx: { alignSelf: 'center', position: 'relative', zIndex: 1, backgroundColor: 'transparent' },
              'data-testid': 'chat-composer-input',
              onPaste,
              // Arrow keys and clicks move the caret without a change event; the `/` menu follows it.
              onSelect: (event: SyntheticEvent<HTMLTextAreaElement>) => setCaret(event.currentTarget.selectionStart),
              // Held so selecting a skill can put focus back where the arguments get typed.
              ref: textareaRef,
              // So the hint is distinguishable from the ordinary placeholder without reading
              // the text, and so a screen reader is told Tab does something here.
              ...(shown ? { 'data-suggested-prompt': shown, 'aria-keyshortcuts': 'Tab' } : {}),
            },
          }}
        />
      </Box>

      {/* Attach on the left, what answers the turn on the right - the shape Claude Code uses.
          The window's last row, so a wider gap below than above. */}
      <Stack direction="row" alignItems="center" sx={{ ...contentColumnSx, pt: 1, pb: 2, gap: 1 }}>
        {/* No correction of its own: its box goes on the content edge like every other control
            in the column, and the '+' rides inside it. Pulling the box left so the glyph alone
            sat on the line is what used to send its hover surface outside the column. */}
        <Tooltip title={`Attach a file (${ATTACH_SHORTCUT.label})`} size="sm" variant="soft" placement="top">
          <Box component="span" sx={{ display: 'inline-flex' }}>
            <IconButton
              size="sm"
              variant="plain"
              color="neutral"
              disabled={disabled || attachments.busy}
              onClick={() => void attachments.pick()}
              aria-label="Attach a file"
              aria-keyshortcuts={ATTACH_SHORTCUT.aria}
              data-testid="composer-attach-btn"
            >
              <Typography level="body-lg">+</Typography>
            </IconButton>
          </Box>
        </Tooltip>

        {leading}

        <Box sx={{ flex: 1 }} />

        {footer}

        {shownUsage && (
          <Tooltip
            title={usageDetail ?? ''}
            placement="top"
            variant="soft"
            size="sm"
            disableHoverListener={!usageDetail}
            // Preserved so the tooltip keeps the one-fact-per-line shape it is built with.
            sx={{ whiteSpace: 'pre-line', maxWidth: 360 }}
          >
            {/* A wrapper rather than the ring itself, so the hover target keeps its own box
                and the tooltip has something to hold on to at any ring size. */}
            <Box sx={{ display: 'inline-flex' }} data-testid="composer-status">
              <CircularProgress
                determinate
                value={allowancePercent === null ? 0 : allowanceArc(allowancePercent)}
                color={allowanceColor(allowancePercent)}
                // Sized off the text rather than off Joy's own scale: this sits in a row of
                // body-xs controls, and the smallest preset is half again as tall as they are.
                sx={{
                  '--CircularProgress-size': '14px',
                  '--CircularProgress-trackThickness': '2px',
                  '--CircularProgress-progressThickness': '2px',
                  ...(allowancePercent === null ? { opacity: 0.5 } : {}),
                }}
                aria-label={usageText ?? 'Credits'}
                data-testid="composer-status-ring"
              />
            </Box>
          </Tooltip>
        )}
      </Stack>
    </Box>
  );
}
