import { FC, PropsWithChildren, ReactNode, useId } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Box, Card, Stack, Typography, Button } from '@mui/joy';
import ScienceOutlinedIcon from '@mui/icons-material/ScienceOutlined';
import { ExperimentalFeature } from '@client/app/contexts/UserSettingsContext';
import { useFeatureEnabled } from '@client/app/hooks/useFeatureEnabled';

interface ExperimentalFeatureGateProps {
  feature: ExperimentalFeature;
  /** Display name shown in the gate panel header. */
  featureName: string;
  /** One-sentence description shown in the gate panel body. */
  description: string;
  /**
   * Rendered while admin settings / user prefs are still hydrating. Defaults to
   * `null` so we never flash the gate panel for users who legitimately have the
   * feature enabled - pass a spinner here when the wrapped route would otherwise
   * be a perceptible blank screen for enabled users.
   */
  loadingFallback?: ReactNode;
}

const ExperimentalFeatureGate: FC<PropsWithChildren<ExperimentalFeatureGateProps>> = ({
  feature,
  featureName,
  description,
  loadingFallback = null,
  children,
}) => {
  const { isFeatureEnabled, isLoading } = useFeatureEnabled();
  const navigate = useNavigate();
  const headingId = useId();

  // Suppress both branches while admin settings load - otherwise users who
  // legitimately have the feature on see a flash of the gate panel before the
  // real page renders.
  if (isLoading) {
    return <>{loadingFallback}</>;
  }

  if (isFeatureEnabled(feature)) {
    return <>{children}</>;
  }

  return (
    <Box
      data-testid={`experimental-gate-${feature}`}
      sx={{
        display: 'flex',
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        p: 4,
      }}
    >
      <Card variant="outlined" role="region" aria-labelledby={headingId} sx={{ maxWidth: 480, p: 4 }}>
        <Stack spacing={2} alignItems="flex-start">
          <ScienceOutlinedIcon sx={{ fontSize: 40, color: 'primary.plainColor' }} />
          <Typography id={headingId} level="h2">
            {featureName} is an experimental feature
          </Typography>
          <Typography level="body-md" sx={{ color: 'text.secondary' }}>
            {description}
          </Typography>
          <Typography level="body-sm" sx={{ color: 'text.tertiary' }}>
            Enable it in <strong>Profile → Settings → Experimental Features</strong> to get started.
          </Typography>
          <Button
            onClick={() => navigate({ to: '/profile', search: { tab: 'settings' } })}
            data-testid={`experimental-gate-${feature}-cta`}
          >
            Open Settings
          </Button>
        </Stack>
      </Card>
    </Box>
  );
};

export default ExperimentalFeatureGate;
