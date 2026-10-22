import { FC, useRef, useState } from 'react';
import { Box, Button, Typography } from '@mui/joy';
import { useQueryClient } from '@tanstack/react-query';
import { formatChoiceReply, type SuggestedChoices } from '@bike4mind/common';
import useChatActions from '@client/app/hooks/useChatActions';
import { useReplyChoices } from '@client/app/hooks/useReplyChoices';
import { recordReplyChoice } from '@client/app/hooks/data/quests';
import { compactButtonSx } from '@client/app/utils/buttonStyles';

interface ReplyChoiceButtonsProps {
  questId: string;
  sessionId: string;
  suggestedChoices: SuggestedChoices;
}

/**
 * The numbered next steps a reply offered. A click sends the option's visible text (label and
 * description, both shown on the button) through the composer's normal send path, exactly as
 * typing its number would (see expandChoiceKey). Live only on the session's newest turn and until
 * one is picked; afterwards the pick stays marked. Rendered inside NavigationButtons' row so
 * choices and navigation read as one set.
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

  const pickedIndex = suggestedChoices.selectedIndex ?? localPick ?? pendingPick;
  const live = isNewest && pickedIndex == null && sendPrompt != null;

  const pick = async (index: number) => {
    if (!live || inFlight.current) return;
    inFlight.current = true;
    setPendingPick(index);
    try {
      const sent = await sendPrompt(formatChoiceReply(suggestedChoices.options[index]), { respectBlockedState: true });
      if (sent) {
        setLocalPick(index);
        void recordReplyChoice(queryClient, { sessionId, questId, suggestedChoices, index });
      }
    } finally {
      inFlight.current = false;
      setPendingPick(null);
    }
  };

  return (
    <>
      {suggestedChoices.options.map((option, index) => {
        const key = index + 1;
        const picked = pickedIndex === index;
        return (
          <Button
            key={key}
            variant={picked ? 'soft' : 'outlined'}
            color="neutral"
            size="sm"
            // The picked one stays enabled so it keeps its colour; clicking it is a no-op.
            disabled={!live && !picked}
            aria-pressed={picked}
            onClick={() => void pick(index)}
            data-testid={`choice-btn-${key}`}
            sx={{
              ...compactButtonSx,
              maxWidth: '320px',
              justifyContent: 'flex-start',
              textAlign: 'left',
              paddingBlock: '6px',
              ...(picked ? {} : { backgroundColor: 'background.surface' }),
            }}
          >
            <Box sx={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              <span data-testid={`choice-btn-${key}-label`}>
                <Box component="span" sx={{ color: 'text.tertiary', mr: '6px' }}>
                  {key}
                </Box>
                {option.label}
              </span>
              <Typography
                level="body-xs"
                data-testid={`choice-btn-${key}-description`}
                sx={{ color: 'text.tertiary', fontWeight: 400, mt: '2px' }}
              >
                {option.description}
              </Typography>
            </Box>
          </Button>
        );
      })}
    </>
  );
};

export default ReplyChoiceButtons;
