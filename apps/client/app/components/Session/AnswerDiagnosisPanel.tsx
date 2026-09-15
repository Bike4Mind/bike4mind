import { Alert, Box, Stack, Typography } from '@mui/joy';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorIcon from '@mui/icons-material/Error';
import HelpIcon from '@mui/icons-material/Help';
import WarningIcon from '@mui/icons-material/Warning';
import { diagnoseAnswer, type DiagnosisStatus, type PromptMeta } from '@bike4mind/common';

/**
 * "Why was this answer bad?" for one turn, rendered as a full checklist rather than a problem list.
 *
 * The completeness is the feature: when every bucket passes, this says so and hands the reader the
 * honest "this one is on the model" verdict. An empty problem list reads as "we don't know", which
 * is exactly the impression the panel exists to replace.
 *
 * The fold itself lives in `@bike4mind/common` (answerDiagnosis.ts) so the same verdicts can be
 * counted across turns server-side; this file is only the rendering of it.
 *
 * RELATIONSHIP TO RetrievalCoverageBanner (mounted inline in PromptReplies): the two are kept
 * separate on purpose, and the overlap is one bucket wide. The banner is UNSOLICITED - it fires on
 * a partially-covered turn to stop a reader concluding "my library has nothing on this" from a
 * scan that never reached most of the library, and that conclusion is drawn by a reader who has no
 * reason to open a diagnosis panel. This panel is the on-demand half: it is opened only once
 * someone already suspects the answer, and it reports all four buckets, including the three the
 * banner cannot see. Folding the banner in here would move a warning from "shown" to "findable".
 */

const STATUS_COLOR: Record<DiagnosisStatus, 'success' | 'warning' | 'danger' | 'neutral'> = {
  ok: 'success',
  warn: 'warning',
  fail: 'danger',
  unknown: 'neutral',
};

/** Material icons take the Material palette, not Joy's, so the tint is applied as a Joy token. */
const STATUS_ICON_SX: Record<DiagnosisStatus, string> = {
  ok: 'success.500',
  warn: 'warning.500',
  fail: 'danger.500',
  unknown: 'neutral.500',
};

const STATUS_ICON: Record<DiagnosisStatus, typeof CheckCircleIcon> = {
  ok: CheckCircleIcon,
  warn: WarningIcon,
  fail: ErrorIcon,
  unknown: HelpIcon,
};

export function AnswerDiagnosisPanel({ promptMeta }: { promptMeta: PromptMeta }) {
  const { checks, verdict } = diagnoseAnswer(promptMeta);

  return (
    <Stack spacing={1} data-testid="answer-diagnosis-panel">
      <Alert
        data-testid={`answer-diagnosis-verdict-${verdict.status}`}
        color={STATUS_COLOR[verdict.status]}
        variant="soft"
        sx={{ flexDirection: 'column', alignItems: 'flex-start', gap: 0.5 }}
      >
        <Typography level="title-sm">{verdict.headline}</Typography>
        {/* textColor inherit: body-sm's tertiary default drops below contrast minimums inside a
            soft Alert (same reason RetrievalCoverageBanner sets it). */}
        <Typography level="body-sm" textColor="inherit">
          {verdict.body}
        </Typography>
      </Alert>

      <Stack component="ul" spacing={1} sx={{ listStyle: 'none', m: 0, p: 0 }}>
        {checks.map(check => {
          const Icon = STATUS_ICON[check.status];
          return (
            <Box
              component="li"
              key={check.id}
              data-testid={`answer-diagnosis-check-${check.id}`}
              data-status={check.status}
              sx={{ display: 'flex', gap: 1, alignItems: 'flex-start' }}
            >
              <Icon fontSize="small" sx={{ mt: '2px', flexShrink: 0, color: STATUS_ICON_SX[check.status] }} />
              <Box>
                <Typography level="title-sm">{check.label}</Typography>
                <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
                  {check.detail}
                </Typography>
                {!!check.remedy && (
                  <Typography
                    level="body-xs"
                    data-testid={`answer-diagnosis-remedy-${check.id}`}
                    sx={{ color: 'text.tertiary' }}
                  >
                    {check.remedy}
                  </Typography>
                )}
              </Box>
            </Box>
          );
        })}
      </Stack>
    </Stack>
  );
}
