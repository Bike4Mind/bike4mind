import { useEffect, useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Button, Option, Select, Stack, Typography } from '@mui/joy';
import {
  SIGNUP_SIGNALS,
  SIGNUP_SIGNAL_LABELS,
  SIGNUP_TIMESERIES_RANGES,
  SIGNUP_TIMESERIES_RANGE_LABELS,
  STRONG_SIGNUP_SIGNALS,
  type SignupTimeseriesRange,
} from '@client/app/utils/signupSignals';
import { useSignupTimeseries, useSignupVerdicts } from '../../Signups/useSignupTimeseries';
import { ErrorState, SectionCard, StatusChip, formatUtc } from '../../shared';
import { parseSignupClassificationContext } from './userProfileSearch';

export function SignupClassificationCard({ userId }: { userId: string }) {
  const context = parseSignupClassificationContext(useSearch({ strict: false }));
  const navigate = useNavigate();
  const range = context.signupRange ?? '7d';
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const age = context.signupAsOf ? now - Date.parse(context.signupAsOf) : Number.NaN;
  const snapshot = age >= -60_000 && age < 24 * 60 * 60_000 ? context.signupAsOf : undefined;
  const chart = useSignupTimeseries(range, !snapshot);
  const asOf = snapshot ?? chart.data?.until;
  const verdicts = useSignupVerdicts(range, asOf, [userId], snapshot ? context.signupTzOffset : undefined);
  const verdict = verdicts.data?.verdicts[userId];
  const failed = (!snapshot && chart.isError) || verdicts.isError;
  const loading = (!snapshot && chart.isPending) || verdicts.isPending;
  const changeRange = (signupRange: SignupTimeseriesRange) =>
    navigate({
      to: '/admin/users/$userId',
      params: { userId },
      search: { signupRange },
      replace: true,
    });
  const retry = async () => {
    if (snapshot) {
      await changeRange(range);
    }
    await chart.refetch();
    if (!snapshot && chart.data?.until) await verdicts.refetch();
  };
  return (
    <SectionCard title="Signup classification" data-testid="signup-classification-card">
      <Stack gap={1.5}>
        <Select<SignupTimeseriesRange>
          value={range}
          onChange={(_event, value) => {
            if (value) {
              void changeRange(value);
            }
          }}
          aria-label="Signup classification range"
          size="sm"
        >
          {SIGNUP_TIMESERIES_RANGES.map(value => (
            <Option key={value} value={value}>
              {SIGNUP_TIMESERIES_RANGE_LABELS[value]}
            </Option>
          ))}
        </Select>
        <Typography level="body-sm">
          This explains the Suspected label in the Users table. It is a signup heuristic, separate from the AI advisory
          and account access.
        </Typography>
        {failed ? (
          <ErrorState message="Signup classification could not be loaded." onRetry={retry} />
        ) : loading ? (
          <Typography level="body-sm">Loading signup classification...</Typography>
        ) : !verdict ? (
          <Typography level="body-sm" data-testid="signup-classification-unavailable">
            Not classified in this window. The account may be outside the selected range or beyond the scan cap; this is
            not a legitimate-user verdict.
          </Typography>
        ) : (
          <>
            <StatusChip
              tone={verdict.suspected ? 'warn' : 'neutral'}
              label={verdict.suspected ? 'Suspected' : 'Likely legit'}
            />
            <Typography level="body-sm" data-testid="signup-classification-rule">
              {verdict.suspected
                ? 'Flagged because at least one strong signal or two weaker signals matched.'
                : 'The matched signals do not meet the suspected-signup rule in this window.'}
            </Typography>
            {SIGNUP_SIGNALS.filter(signal => verdict.signals.includes(signal)).map(signal => (
              <Stack gap={0.25} key={signal} data-testid={`signup-classification-reason-${signal}`}>
                <Typography level="title-sm">
                  {SIGNUP_SIGNAL_LABELS[signal].label}
                  {STRONG_SIGNUP_SIGNALS.has(signal) ? ' (strong signal)' : ''}
                </Typography>
                <Typography level="body-sm">{SIGNUP_SIGNAL_LABELS[signal].description}</Typography>
              </Stack>
            ))}
            {verdict.signals.length === 0 && (
              <Typography level="body-sm">No suspected-signup signals matched.</Typography>
            )}
          </>
        )}
        {asOf && (
          <Typography level="body-xs">
            {SIGNUP_TIMESERIES_RANGE_LABELS[range]}, evaluated {formatUtc(new Date(asOf))}. Classification can change
            with the window and new activity.
          </Typography>
        )}
        {(chart.data?.truncated || chart.data?.keysTruncated) && (
          <Typography level="body-sm" color="warning">
            Classification coverage is incomplete because a scan cap was reached. Missing signals are not proof of
            safety.
          </Typography>
        )}
        <Button variant="plain" color="neutral" size="sm" onClick={retry}>
          Refresh classification
        </Button>
      </Stack>
    </SectionCard>
  );
}
