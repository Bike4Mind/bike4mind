import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from 'react';
import Alert from '@mui/joy/Alert';
import Box from '@mui/joy/Box';
import CircularProgress from '@mui/joy/CircularProgress';
import IconButton from '@mui/joy/IconButton';
import Stack from '@mui/joy/Stack';
import Textarea from '@mui/joy/Textarea';
import Tooltip from '@mui/joy/Tooltip';
import Typography from '@mui/joy/Typography';
import type { ChatQueuedMessage } from '@shared/chat';
import { AttachmentRow } from './Attachments';
import { matchCommands, type ComposerCommand } from './commands';
import {
  COMPOSER_BUTTON_LABELS,
  composerButtonAction,
  composerEscapeAction,
  composerKeyAction,
  composerMenuAction,
  composerPlaceholder,
  composerSubmitAction,
  shownSuggestion,
} from './composerInput';
import { ArrowUpIcon, StopIcon } from './icons';
import { contentColumnSx } from './layout';
import { QueuedMessageList } from './QueuedMessageList';
import { mergeIntoDraft } from './queuedMessages';
import { matchSkills, skillQuery } from './skillMenu';
import { SkillPicker } from './SkillPicker';
import {
  contextPercent,
  describeUsage,
  occupancyArc,
  occupancyColor,
  usageLabel,
  type ComposerUsage,
} from './statusLine';
import { toAttachmentInputs, type AttachmentDraft } from './useAttachments';
import type { SkillsController } from './useSkills';

export function Composer({
  sessionId,
  disabled,
  streaming,
  attachments,
  blockedReason,
  notReady,
  usage,
  placeholder = 'Send a message...',
  disabledPlaceholder,
  onSend,
  onStop,
  onRunCommand,
  queued,
  onCancelQueued,
  onSendQueuedNow,
  returned,
  onReturnedConsumed,
  footer,
  leading,
  skills,
  suggestion,
  onSuggestionDismissed,
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
  /**
   * A word for the idle indicator naming a state that is not ready to send - "No folder" for a
   * Code session with no project. It blocks Send and draws NO banner: the control that answers
   * it is a few pixels above, and a line of prose repeating what that control already says is
   * noise. Main refuses the turn regardless; this is so the button agrees with it.
   */
  notReady?: string | null;
  /**
   * What the idle indicator says INSTEAD of a bare "Ready": how full the window is and what is
   * left to spend. Only the idle case - the three states above all name something the user may
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
  /** The hint is gone - the user typed over it, or took it. Asks the owner to drop it. */
  onSuggestionDismissed?: () => void;
}) {
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const hasContent = text.trim().length > 0 || attachments.attachments.length > 0;
  const blocked = !!blockedReason || !!notReady;

  /**
   * The usage the ring reports, in flight or not.
   *
   * It used to be blanked while a reply streamed, on the grounds that the turn already has its
   * own line under the transcript. The two do not report the same fact: TurnStatus counts what
   * THIS turn has spent so far, and this reports how full the window was when the last request
   * went out. A turn is also the moment the answer matters most, and a field that empties
   * itself exactly then is a worse answer than a figure a round trip behind.
   *
   * What keeps them from disagreeing is that neither one estimates. The streamed 'usage' events
   * carry the turn's running bill, which is not window occupancy, so this deliberately does not
   * read them: the figure holds the last COMPLETED request and steps when the next one lands -
   * see latestReply, which is where the holding happens. `disabled` and `notReady` stay, because
   * in those there is no conversation and nothing was ever measured to hold - and with the word
   * beside it gone, a ring in those states would be a glyph standing for nothing. The dot in the
   * sidebar is what speaks for them now; see TurnDot.
   */
  const shownUsage = !disabled && !notReady ? (usage ?? null) : null;
  const usageText = shownUsage && usageLabel(shownUsage);
  const usageDetail = shownUsage && usageText ? describeUsage(shownUsage) : null;
  const occupancy = shownUsage ? contextPercent(shownUsage.contextTokens, shownUsage.contextLimit) : null;

  // See composerInput.ts for what wins here and why.
  const shown = shownSuggestion({ disabled, text, suggestion });
  // `streaming` is NOT here: a send during a live turn is queued, not dropped. It used to be
  // the first condition, which is why pressing Enter mid-reply did nothing at all.
  const canSubmit = hasContent && !disabled && !attachments.busy && !blocked;

  // A draft that names a command is sendable whatever is blocking a TURN: see submit. Without
  // this the button would sit disabled on `/clear` in exactly the conversations most in need of
  // it, while Enter ran it anyway.
  const commandDraft = !!onRunCommand && !disabled && composerSubmitAction(text).kind === 'command';

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
    const action = composerSubmitAction(draft);
    if (action.kind === 'command' && onRunCommand && !disabled) {
      setText('');
      onRunCommand(action.invocation.command.name, action.invocation.args);
      return;
    }
    if (!canSubmit) return;
    setText('');
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

  /**
   * The `/` menu.
   *
   * Open is DERIVED from the text rather than stored, so there is no state to get out of step
   * with what is on screen: the menu is showing exactly when the whole input is a bare `/token`
   * (see skillQuery). Escape is the one thing that needs memory, and it is remembered against
   * the text that was dismissed - so typing another character brings the menu back, which is
   * what makes Escape "not this one" rather than "not until I reload".
   */
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const query = (skills || onRunCommand) && !disabled ? skillQuery(text) : null;
  const commandMatches = useMemo(
    () => (onRunCommand && query !== null ? matchCommands(query) : []),
    [onRunCommand, query]
  );
  const matches = useMemo(() => (skills && query !== null ? matchSkills(skills.skills, query) : []), [skills, query]);
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
    // The trailing space is what closes the menu (the text is no longer a bare token) and what
    // leaves the user positioned to type arguments.
    onTextChange(`/${name} `);
    setDismissed(null);
    textareaRef.current?.focus();
  };

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
      setText(`/${command.name} `);
      textareaRef.current?.focus();
      return;
    }
    setText('');
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
    if (shown) {
      setText(shown);
      onSuggestionDismissed?.();
    }
  };

  /**
   * The user is composing their own message, so the hint stops being one.
   *
   * Dropped rather than hidden: it is thrown away on the first keystroke and the ordinary
   * placeholder is what comes back if they delete it all again, because a hint that reappeared
   * under a box the user has already emptied once would be offering the same guess about a
   * conversation they have moved on from. Covers paste and drop too - both change the value.
   */
  const onTextChange = (next: string) => {
    setText(next);
    if (suggestion && next.length > 0) onSuggestionDismissed?.();
  };

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
          <Alert size="sm" color="warning" variant="soft" data-testid="composer-blocked-reason">
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
        />
      )}

      <Box sx={{ ...contentColumnSx, pt: 1.5 }}>
        {/* The button rides INSIDE the input rather than beside it. As a sibling in a row it
            took its own width out of the column, so the input's right edge stopped ~74px short
            of where the transcript ends while every other composer row reached it. */}
        <Textarea
          value={text}
          onChange={event => onTextChange(event.target.value)}
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
          sx={{ flexDirection: 'row', alignItems: 'flex-end', fontSize: 'sm' }}
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
            textarea: {
              // Joy stretches the textarea to the flex line, and the button's min-height makes
              // that line taller than one line of text - so the text rendered at the top of the
              // band and every spare pixel fell underneath it (6px above, 13px below). Centring
              // splits them. Only bites while the box is one row; once the text is the tallest
              // item it drives the height itself and this does nothing.
              sx: { alignSelf: 'center' },
              'data-testid': 'chat-composer-input',
              onPaste,
              // Held so selecting a skill can put focus back where the arguments get typed.
              ref: textareaRef,
              // So the hint is distinguishable from the ordinary placeholder without reading
              // the text, and so a screen reader is told Tab does something here.
              ...(shown ? { 'data-suggested-prompt': shown, 'aria-keyshortcuts': 'Tab' } : {}),
            },
          }}
        />
      </Box>

      {/* Attach on the left, what answers the turn on the right - the shape Claude Code uses. */}
      <Stack direction="row" alignItems="center" sx={{ ...contentColumnSx, py: 1, gap: 1 }}>
        {/* No correction of its own: its box goes on the content edge like every other control
            in the column, and the '+' rides inside it. Pulling the box left so the glyph alone
            sat on the line is what used to send its hover surface outside the column. */}
        <IconButton
          size="sm"
          variant="plain"
          color="neutral"
          disabled={disabled || attachments.busy}
          onClick={() => void attachments.pick()}
          aria-label="Attach a file"
          data-testid="composer-attach-btn"
        >
          <Typography level="body-lg">+</Typography>
        </IconButton>

        {leading}

        <Box sx={{ flex: 1 }} />

        {footer}

        {/* The whole status line: one ring, and the detail one hover behind it.

            The dot and the figure that used to flank it are gone, and nothing went with them.
            A reply in flight already turns the send button into Stop and draws its own line
            under the transcript; a Code session with no folder has the "Choose a folder" chip
            a few pixels above, which is the thing to act on rather than a word repeating it;
            and a window with no conversation says so in the composer's own placeholder. The
            words those two carried were each the second place something was said.

            The figure itself is not lost either - it is the ring's accessible name, and the
            tooltip states it in full alongside the balance. See usageLabel. */}
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
                // An occupancy nobody stated draws the bare track: no arc, and dimmed, so
                // "nothing measured" cannot be read as "the window is empty". A determinate
                // ring has no other way to say unknown, and the tooltip says it in words.
                value={occupancy === null ? 0 : occupancyArc(occupancy)}
                color={occupancyColor(occupancy)}
                // Sized off the text rather than off Joy's own scale: this sits in a row of
                // body-xs controls, and the smallest preset is half again as tall as they are.
                sx={{
                  '--CircularProgress-size': '14px',
                  '--CircularProgress-trackThickness': '2px',
                  '--CircularProgress-progressThickness': '2px',
                  ...(occupancy === null ? { opacity: 0.5 } : {}),
                }}
                aria-label={usageText ?? 'Context window'}
                data-testid="composer-status-ring"
              />
            </Box>
          </Tooltip>
        )}
      </Stack>
    </Box>
  );
}
