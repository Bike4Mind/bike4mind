import { Box, Typography } from '@mui/joy';
import { useMemo } from 'react';
import { useLLM } from '@client/app/contexts/LLMContext';
import { useModelInfo } from '@client/app/hooks/data/useModelInfo';
import { useSignupGrantCredits } from '@client/app/hooks/useSignupGrantCredits';
import { useEffectiveCredits } from '@client/app/hooks/useEffectiveCredits';
import { estimateAnswerCount, typicalAnswerCredits } from '@client/app/utils/creditEstimate';
import { formatCreditAmount } from '@client/app/utils/formatCredits';
import SignupGrantStatus from './SignupGrantStatus';

const CreditsExplanation = () => {
  const model = useLLM(state => state.model);
  const organizationId = useLLM(state => state.organizationId);
  const defaultFreeCredits = useSignupGrantCredits();
  const showFreeCreditsNote = defaultFreeCredits > 0 && !organizationId;
  const credits = useEffectiveCredits();
  const { data: models } = useModelInfo();
  const selected = useMemo(() => models?.find(candidate => candidate.id === model), [models, model]);
  const answerCost = selected ? typicalAnswerCredits(selected) : null;
  const answers = answerCost ? estimateAnswerCount(credits, answerCost) : null;

  return (
    <Box data-testid="credits-explanation" sx={{ mt: 2 }}>
      <Typography level="body-md" sx={{ color: 'text.secondary' }}>
        Credits measure AI usage. Longer answers, larger conversations, files and more capable models use more.
      </Typography>
      <Box sx={{ py: 1 }}>
        <Typography level="title-sm" data-testid="credits-explanation-answers">
          {selected?.freeToRun
            ? "This model doesn't use credits"
            : answers === null
              ? 'Answer estimate unavailable'
              : credits <= 0
                ? 'No typical answers left'
                : answers < 1
                  ? 'Less than 1 typical answer left'
                  : `About ${answers.toLocaleString('en-US')} typical ${answers === 1 ? 'answer' : 'answers'} left`}
        </Typography>
        <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
          {selected?.freeToRun
            ? `On ${selected.name}.`
            : selected
              ? `On ${selected.name}, based on a typical answer.`
              : 'Based on a typical answer.'}
        </Typography>
        <Typography level="body-sm" data-testid="credits-explanation-balance" sx={{ mt: 1, color: 'text.tertiary' }}>
          {formatCreditAmount(credits)} credits available
        </Typography>
      </Box>
      <SignupGrantStatus />
      <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
        {showFreeCreditsNote && 'Free starting credits require no card. '}Your chats and files remain yours if the
        balance runs out.
      </Typography>
    </Box>
  );
};

export default CreditsExplanation;
