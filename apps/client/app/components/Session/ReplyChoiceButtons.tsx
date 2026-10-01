import { FC, useState } from 'react';
import { Box, Button, Tooltip } from '@mui/joy';
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
 * The numbered next steps a reply offered. A click sends the option's visible text through the
 * composer's normal send path, exactly as typing its number would (see expandChoiceKey). Live only
 * on the session's newest turn and until one is picked; afterwards the pick stays marked.
 * Rendered inside NavigationButtons' row so choices and navigation read as one set.
 */
const ReplyChoiceButtons: FC<ReplyChoiceButtonsProps> = ({ questId, sessionId, suggestedChoices }) => {
  const queryClient = useQueryClient();
  const sendPrompt = useChatActions(state => state.sendPrompt);
  const isNewest = useReplyChoices(state => state.newestBySession[sessionId]?.questId === questId);
  // Set on click, before the server confirms, so a double tap cannot send twice.
  const [localPick, setLocalPick] = useState<number | null>(null);

  const pickedIndex = suggestedChoices.selectedIndex ?? localPick;
  const live = isNewest && pickedIndex == null && sendPrompt != null;

  const pick = async (index: number) => {
    if (!live) return;
    setLocalPick(index);
    void recordReplyChoice(queryClient, { sessionId, questId, suggestedChoices, index });
    await sendPrompt(formatChoiceReply(suggestedChoices.options[index]));
  };

  return (
    <>
      {suggestedChoices.options.map((option, index) => {
        const key = index + 1;
        const picked = pickedIndex === index;
        return (
          <Tooltip
            key={key}
            title={live ? `${option.description} (or type ${key})` : option.description}
            placement="top"
            arrow
          >
            <Button
              variant={picked ? 'soft' : 'outlined'}
              color="neutral"
              size="sm"
              // The picked one stays enabled so it keeps its colour and tooltip; clicking it is a no-op.
              disabled={!live && !picked}
              aria-pressed={picked}
              onClick={() => void pick(index)}
              data-testid={`choice-btn-${key}`}
              sx={{ ...compactButtonSx, ...(picked ? {} : { backgroundColor: 'background.surface' }) }}
            >
              <Box component="span" sx={{ color: 'text.tertiary', mr: '6px' }}>
                {key}
              </Box>
              {option.label}
            </Button>
          </Tooltip>
        );
      })}
    </>
  );
};

export default ReplyChoiceButtons;
