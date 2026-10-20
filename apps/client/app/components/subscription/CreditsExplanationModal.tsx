import { Box, Button, Modal, ModalClose, ModalDialog, Typography } from '@mui/joy';
import { useMemo, useState } from 'react';
import { useLLM } from '@client/app/contexts/LLMContext';
import { useModelInfo } from '@client/app/hooks/data/useModelInfo';
import { useEffectiveCredits } from '@client/app/hooks/useEffectiveCredits';
import { estimateAnswerCount, typicalAnswerCredits } from '@client/app/utils/creditEstimate';
import { formatCreditAmount } from '@client/app/utils/formatCredits';
import BillingModal from './BillingModal';

interface CreditsExplanationModalProps {
  open: boolean;
  onClose: () => void;
}

const CreditsExplanationModal = ({ open, onClose }: CreditsExplanationModalProps) => {
  const [billingOpen, setBillingOpen] = useState(false);
  const model = useLLM(state => state.model);
  const credits = useEffectiveCredits();
  const { data: models } = useModelInfo();
  const selected = useMemo(() => models?.find(candidate => candidate.id === model), [models, model]);
  const answerCost = selected ? typicalAnswerCredits(selected) : null;
  const answers = answerCost ? estimateAnswerCount(credits, answerCost) : null;

  const close = () => {
    setBillingOpen(false);
    onClose();
  };

  return (
    <>
      <Modal open={open && !billingOpen} onClose={close} data-testid="credits-explanation-modal">
        <ModalDialog sx={{ width: 'min(480px, calc(100vw - 32px))', p: 3 }}>
          <ModalClose />
          <Typography level="h3">How credits work</Typography>
          <Typography level="body-md" sx={{ color: 'text.secondary' }}>
            Credits measure AI usage. Longer answers, larger conversations, files and more capable models use more.
          </Typography>
          <Box sx={{ py: 2 }}>
            <Typography level="h2" data-testid="credits-explanation-answers">
              {answers === null
                ? 'Answer estimate unavailable'
                : answers < 1
                  ? 'Less than 1 answer left'
                  : `About ${answers.toLocaleString('en-US')} ${answers === 1 ? 'answer' : 'answers'} left`}
            </Typography>
            <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
              {selected ? `On ${selected.name}, based on a typical answer.` : 'Based on a typical answer.'}
            </Typography>
            <Typography
              level="body-sm"
              data-testid="credits-explanation-balance"
              sx={{ mt: 1, color: 'text.tertiary' }}
            >
              {formatCreditAmount(credits)} credits available
            </Typography>
          </Box>
          <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
            Free starting credits require no card. Your chats and files remain yours if the balance runs out.
          </Typography>
          <Button data-testid="credits-explanation-top-up" onClick={() => setBillingOpen(true)} sx={{ mt: 1 }}>
            See plans and top up
          </Button>
        </ModalDialog>
      </Modal>
      <BillingModal open={billingOpen} focus="credits" onClose={close} />
    </>
  );
};

export default CreditsExplanationModal;
