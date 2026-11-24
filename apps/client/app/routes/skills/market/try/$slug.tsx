import { FC, useEffect, useRef } from 'react';
import { Alert, Box, Button, CircularProgress, Typography } from '@mui/joy';
import { useNavigate, useParams } from '@tanstack/react-router';
import { useDocumentTitle } from '@client/app/hooks/useDocumentTitle';
import { useTrySkillTemplate } from '@client/app/hooks/data/skillTemplate';
import { NEW_NOTEBOOK_DRAFT_KEY, useChatInput } from '@client/app/hooks/useChatInput';
import { getErrorMessage } from '@client/app/utils/error';
import { clearFreeRunInput, readFreeRunInput, skillTemplateGoal } from '@client/app/utils/skillTemplateTry';

/**
 * "Try with Bike4Mind" from a public template page (/t/<slug>): import the skill (or reuse the
 * visitor's copy) and open a new chat with the composer prefilled. The `goal` param never auto-sends
 * from a link (routes/notebooks/new.tsx).
 */
const SkillTemplateTryPage: FC = () => {
  const { slug } = useParams({ strict: false }) as { slug: string };
  const navigate = useNavigate();
  const tryTemplate = useTrySkillTemplate();
  const started = useRef(false);
  useDocumentTitle('Opening skill');

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    tryTemplate
      .mutateAsync(slug)
      .then(({ skillName, examplePrompt }) => {
        const goal = skillTemplateGoal(skillName, readFreeRunInput(slug) || examplePrompt);
        clearFreeRunInput(slug);
        // A saved new-chat draft is restored after `goal` is applied (useMessageDraft) and would replace it.
        useChatInput.getState().clearDraft(NEW_NOTEBOOK_DRAFT_KEY);
        void navigate({ to: '/new', search: { goal }, replace: true });
      })
      // Shown from the mutation's error state below.
      .catch(() => undefined);
  }, [slug, navigate, tryTemplate]);

  return (
    <Box
      data-testid="skill-template-try-page"
      sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, p: 4, mt: 8 }}
    >
      {tryTemplate.isError ? (
        <>
          <Alert color="danger" data-testid="skill-template-try-error" sx={{ maxWidth: 480 }}>
            {getErrorMessage(tryTemplate.error)}
          </Alert>
          <Button
            variant="outlined"
            data-testid="skill-template-try-market-btn"
            onClick={() => void navigate({ to: '/skills/market' })}
          >
            Browse the Skill Market
          </Button>
        </>
      ) : (
        <>
          <CircularProgress data-testid="skill-template-try-loading" />
          <Typography level="body-md">Getting the skill ready...</Typography>
        </>
      )}
    </Box>
  );
};

export default SkillTemplateTryPage;
