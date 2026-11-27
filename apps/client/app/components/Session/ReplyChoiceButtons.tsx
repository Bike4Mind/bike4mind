import { FC, ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Box, Typography } from '@mui/joy';
import { useQueryClient } from '@tanstack/react-query';
import { formatChoiceReply, type SuggestedChoices } from '@bike4mind/common';
import useChatActions from '@client/app/hooks/useChatActions';
import { useReplyChoices } from '@client/app/hooks/useReplyChoices';
import { recordReplyChoice } from '@client/app/hooks/data/quests';
import { gray } from '@client/app/utils/themes/colors';

interface ReplyChoiceButtonsProps {
  questId: string;
  sessionId: string;
  suggestedChoices: SuggestedChoices;
}

const Glyph: FC<{ path: ReactNode; size?: number }> = ({ path, size = 16 }) => (
  <Box
    component="svg"
    viewBox="0 0 24 24"
    width={size}
    height={size}
    fill="none"
    stroke="currentColor"
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
    sx={{ flexShrink: 0, display: 'block' }}
  >
    {path}
  </Box>
);

const CHECK = <path d="M5 12.5l4.5 4.5L19 7.5" />;

/** True while the user is typing somewhere, so a digit belongs to that field, not to the choices. */
const isTypingTarget = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

/**
 * The numbered next steps a reply offered. A click (or its digit key) sends the option's visible
 * text through the composer's normal send path, exactly as typing its number would (see
 * expandChoiceKey). Live only on the session's newest turn and until one is picked; afterwards it
 * folds into a one-line receipt of the pick.
 */
const ReplyChoiceButtons: FC<ReplyChoiceButtonsProps> = ({ questId, sessionId, suggestedChoices }) => {
  const queryClient = useQueryClient();
  const sendPrompt = useChatActions(state => state.sendPrompt);
  const isNewest = useReplyChoices(state => state.newestBySession[sessionId]?.questId === questId);
  // The pick is recorded only once the send went through; until then the row is held, so a double
  // tap cannot send twice, and released again if the send is refused.
  const [localPick, setLocalPick] = useState<number | null>(null);
  const [pendingPick, setPendingPick] = useState<number | null>(null);
  const inFlight = useRef(false);

  const { options } = suggestedChoices;
  const pickedIndex = suggestedChoices.selectedIndex ?? localPick ?? pendingPick;
  const live = isNewest && pickedIndex == null && sendPrompt != null;

  const pick = async (index: number) => {
    if (!live || inFlight.current) return;
    inFlight.current = true;
    setPendingPick(index);
    try {
      const sent = await sendPrompt(formatChoiceReply(options[index]), { respectBlockedState: true });
      if (sent) {
        setLocalPick(index);
        void recordReplyChoice(queryClient, { sessionId, questId, suggestedChoices, index });
      }
    } finally {
      inFlight.current = false;
      setPendingPick(null);
    }
  };

  // Through a ref, so a render's new pick does not re-arm the key listener.
  const pickRef = useRef(pick);
  useLayoutEffect(() => {
    pickRef.current = pick;
  });
  useEffect(() => {
    if (!live) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.repeat || isTypingTarget(event.target)) return;
      const index = Number(event.key) - 1;
      if (!Number.isInteger(index) || index < 0 || index >= options.length) return;
      event.preventDefault();
      void pickRef.current(index);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [live, options.length]);

  if (pickedIndex != null) {
    return (
      <Box data-testid="choice-receipt">
        <Typography sx={{ fontSize: '14px', color: 'text.primary', fontWeight: 600 }}>Your call</Typography>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: '8px', mt: '6px', fontSize: '13px' }}>
          <Box component="span" sx={{ color: 'success.plainColor', display: 'inline-flex' }}>
            <Glyph path={CHECK} size={14} />
          </Box>
          <Box component="span" data-testid="choice-receipt-label" sx={{ color: 'text.primary', fontWeight: 500 }}>
            {options[pickedIndex]?.label}
          </Box>
        </Box>
      </Box>
    );
  }

  // Two to four options: never a lone card on a row, so four sit as two by two.
  const wideColumns = options.length === 3 ? 3 : 2;

  return (
    <Box data-testid="choice-block" sx={{ containerType: 'inline-size', containerName: 'choices' }}>
      <Box sx={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', mb: '8px' }}>
        <Typography sx={{ fontSize: '14px', color: 'text.primary', fontWeight: 600 }}>Your call</Typography>
        {live && (
          <Box
            component="span"
            aria-hidden
            sx={{ fontFamily: 'code', fontSize: '11px', color: 'text.tertiary', opacity: 0.6 }}
          >
            {`press 1\u2013${options.length}`}
          </Box>
        )}
      </Box>
      <Box
        role="group"
        aria-label="Your call"
        aria-description={live ? `Press 1 to ${options.length} to pick an option.` : undefined}
        sx={{
          display: 'grid',
          // By the reply column's width, not the window's: the chat is often a narrow pane beside a canvas.
          gridTemplateColumns: '1fr',
          '@container choices (min-width: 440px)': { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' },
          ...(wideColumns === 3 && {
            '@container choices (min-width: 660px)': { gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' },
          }),
          gap: '10px',
        }}
      >
        {options.map((option, index) => {
          const key = index + 1;
          return (
            <Box
              key={key}
              component="button"
              type="button"
              disabled={!live}
              aria-label={`${option.label}: ${option.description}`}
              onClick={() => void pick(index)}
              data-testid={`choice-btn-${key}`}
              // The Gears card (components/gears/GearCard): same ground, soft border, hover lift and focus ring.
              sx={theme => ({
                display: 'flex',
                flexDirection: 'column',
                boxSizing: 'border-box',
                p: '12px',
                textAlign: 'left',
                fontFamily: 'inherit',
                color: 'inherit',
                border: '1px solid',
                borderColor: theme.palette.border.soft,
                borderRadius: 'md',
                backgroundColor: theme.palette.mode === 'dark' ? theme.palette.background.body : gray[0],
                cursor: live ? 'pointer' : 'default',
                opacity: live ? 1 : 0.6,
                outline: 'none',
                transition:
                  'background-color 0.18s ease-out, border-color 0.18s ease-out, transform 0.22s cubic-bezier(0.2, 0.8, 0.3, 1)',
                ...(live && {
                  '&:hover': {
                    backgroundColor: theme.palette.loginRegister.termsAndPrivacy.hoverBg,
                    borderColor: theme.palette.border.light,
                    transform: 'translateY(-2px)',
                  },
                  '&:focus-visible': {
                    outline: `2px solid ${theme.palette.primary[500]}`,
                    outlineOffset: '2px',
                  },
                }),
                '@media (prefers-reduced-motion: reduce)': {
                  transition: 'background-color 0.18s ease-out, border-color 0.18s ease-out',
                  '&:hover': { transform: 'none' },
                },
              })}
            >
              <Box component="span" sx={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%' }}>
                <Box
                  component="span"
                  aria-hidden
                  sx={{
                    width: 16,
                    height: 16,
                    flexShrink: 0,
                    boxSizing: 'border-box',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    border: '1px solid',
                    borderBottomWidth: '2px',
                    borderColor: 'divider',
                    borderRadius: '4px',
                    fontFamily: 'code',
                    fontSize: '10px',
                    color: 'text.tertiary',
                  }}
                >
                  {key}
                </Box>
                <Box
                  component="span"
                  data-testid={`choice-btn-${key}-label`}
                  sx={{
                    flex: 1,
                    minWidth: 0,
                    fontSize: '13px',
                    fontWeight: 600,
                    color: 'text.primary',
                    lineHeight: '18px',
                  }}
                >
                  {option.label}
                </Box>
              </Box>
              <Box
                component="span"
                data-testid={`choice-btn-${key}-description`}
                sx={{
                  mt: '8px',
                  fontSize: '12px',
                  lineHeight: 1.45,
                  color: 'text.secondary',
                  opacity: 0.85,
                  textWrap: 'pretty',
                }}
              >
                {option.description}
              </Box>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
};

export default ReplyChoiceButtons;
