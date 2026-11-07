import type { AbuseAssessmentReason, AbuseAssessmentReasonKey } from '@bike4mind/common';
import { Box, Stack, Typography } from '@mui/joy';
import React from 'react';

/**
 * The advisory model's strongest reasons for an assessment. A reason is a fixed key the model
 * answered yes to with a probability (questions in server/security/abuseAssessment/abuseAssessment.ts),
 * so every line shown here is worded by this file, never by the model.
 */
export const ABUSE_ASSESSMENT_REASON_TEXT: Record<AbuseAssessmentReasonKey, string> = {
  anonymizedNetwork: 'Signed up through a VPN, proxy or hosting network',
  generatedLookingEmail: 'Email addresses look generated or throwaway',
  rushedOnboarding: 'Two-factor or spending started within minutes of signup',
  linkedAccounts: 'Linked to other accounts by network, fingerprint or mailbox',
  concentratedExpensiveSpend: 'Spend concentrated on expensive models right after signup',
  signupBurst: 'Several signups from one network in a short window',
  ordinaryUse: 'Looks like ordinary individual or developer use',
};

const percent = (value: number) => `${Math.round(value * 100)}%`;

type Props = { reasons: readonly AbuseAssessmentReason[] };

export const AbuseAssessmentReasons: React.FC<Props> = ({ reasons }) => {
  if (reasons.length === 0) return null;
  return (
    <Stack gap={0.25} data-testid="abuse-assessment-reasons">
      <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
        What the model weighed most
      </Typography>
      <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
        {reasons.map(reason => (
          <Typography key={reason.key} component="li" level="body-sm" data-testid="abuse-assessment-reason">
            {ABUSE_ASSESSMENT_REASON_TEXT[reason.key]} ({percent(reason.probability)})
          </Typography>
        ))}
      </Box>
    </Stack>
  );
};
