import { useMemo, useState } from 'react';

import Alert from '@mui/joy/Alert';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import IconButton from '@mui/joy/IconButton';
import Typography from '@mui/joy/Typography';
import Close from '@mui/icons-material/Close';
import BugReportIcon from '@mui/icons-material/BugReport';
import { diagnoseAnswer, type PromptMeta } from '@bike4mind/common';

import {
  dismissAnswerFeedbackPrompt,
  isAnswerFeedbackPromptCapped,
  isAnswerFeedbackPromptDismissed,
} from '@client/app/utils/answerFeedbackPrompt';

/** Follows the CTA rather than the headline: the headline is the diagnosis, this is the ask. */
const PROMPT_BODY = 'Telling us what you expected is the part we cannot recover from the logs.';

type AnswerFeedbackPromptProps = {
  promptMeta: PromptMeta | null | undefined;
  /** Absent for a turn the server has no row for; such a turn cannot anchor a sticky dismissal. */
  questId: string | undefined;
  /** Already-reported turns are never nagged - the user has said their piece on this one. */
  isReported: boolean;
  /** Opens the same BugReportModal the persistent Report button opens. */
  onReport: () => void;
};

/**
 * Asks for feedback on a turn the pipeline itself says went wrong (#1873).
 *
 * This inverts the discovery problem behind the persistent Report button: that button is always
 * there and therefore never noticed, and the moment a user is most willing to explain what they
 * expected is the moment they have just read a bad answer. So the ask goes to them.
 *
 * RELATIONSHIP TO AnswerDiagnosisPanel: same fold, opposite direction. The panel is opened by
 * someone who already suspects the answer and wants all four buckets; this is unsolicited and
 * carries one sentence. Both render `diagnoseAnswer`'s own `verdict.headline` verbatim rather than
 * paraphrasing it, so the proactive line and the panel a curious user then opens cannot describe
 * the same turn two different ways. Only the second line differs: the panel shows `verdict.body`
 * (what broke), this shows the ask (what we need from the user).
 *
 * GATED ON 'fail' ALONE, not on "not ok". The other two non-ok arms would each be a false positive
 * generator, and the issue's own warning is that false positives train users to ignore this:
 *   - 'warn' is mostly context truncation, which already renders its own banner in PromptReplies
 *     explaining exactly what happened. There is nothing for the user to tell us.
 *   - 'unknown' means the turn went unrecorded. Prompting on "we did not measure this" asks the
 *     user to explain our own instrumentation gap.
 * We gate on the STATUS, not on an enumeration of the arms that produce it, so an arm added to
 * diagnoseAnswer later is picked up here without a change. Today it grades 'fail' for retrieval
 * that errored or was never wired up, a corpus that was never indexed, a search that ran and
 * compared nothing, and a tool call that failed - turns that really did break, where what the
 * user was trying to get is the part we cannot recover from telemetry.
 */
export function AnswerFeedbackPrompt({ promptMeta, questId, isReported, onReport }: AnswerFeedbackPromptProps) {
  // Local, so acting on the prompt closes it without spending a day's dismissal budget. A submitted
  // report flips `isReported` and keeps it closed for good; an abandoned one gets one more chance
  // on the next load, which is the honest reading of "they never actually told us".
  const [handled, setHandled] = useState(false);

  const verdict = useMemo(() => (promptMeta ? diagnoseAnswer(promptMeta).verdict : undefined), [promptMeta]);

  if (!questId || isReported || handled || verdict?.status !== 'fail') return null;
  // Ordered after the free checks so a healthy turn never touches storage to render nothing.
  if (isAnswerFeedbackPromptDismissed(questId) || isAnswerFeedbackPromptCapped()) return null;

  const handleDismiss = () => {
    dismissAnswerFeedbackPrompt(questId);
    setHandled(true);
  };

  const handleReport = () => {
    setHandled(true);
    onReport();
  };

  return (
    <Alert
      data-testid="answer-feedback-prompt"
      color="warning"
      variant="soft"
      // No vertical margin: unlike the PromptReplies banners this sits in the message stack,
      // which already spaces its children.
      sx={{ flexDirection: 'column', alignItems: 'flex-start', gap: 1 }}
    >
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1, width: '100%' }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography level="title-sm">{verdict.headline}</Typography>
          {/* Explicit text.primary, matching the headline above. The two obvious alternatives both
              fail WCAG AA here in light mode: body-sm's own default is a 50%-alpha tertiary tint,
              and inheriting the Alert's color gives warning.softColor, which this theme sets to the
              same orange as softBg (themePrimitives.ts) - measured 1.66:1 against the soft
              background, versus 5.85:1 for this token. */}
          <Typography level="body-sm" textColor="text.primary">
            {PROMPT_BODY}
          </Typography>
        </Box>
        <IconButton
          data-testid="answer-feedback-prompt-dismiss-btn"
          size="sm"
          variant="plain"
          color="neutral"
          onClick={handleDismiss}
          aria-label="Dismiss this feedback request"
        >
          <Close fontSize="small" />
        </IconButton>
      </Box>
      <Button
        data-testid="answer-feedback-prompt-report-btn"
        size="sm"
        variant="solid"
        color="warning"
        startDecorator={<BugReportIcon sx={{ fontSize: 16 }} />}
        onClick={handleReport}
      >
        Tell us what went wrong
      </Button>
    </Alert>
  );
}

export default AnswerFeedbackPrompt;
