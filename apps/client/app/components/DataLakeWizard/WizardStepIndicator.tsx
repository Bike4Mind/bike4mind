import { Box, Typography } from '@mui/joy';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import { useTheme } from '@mui/joy/styles';
import type { WizardStep } from '@client/app/stores/useDataLakeWizardStore';

const STEPS: { key: WizardStep; label: string }[] = [
  { key: 'source', label: 'Select Source' },
  { key: 'preview', label: 'Preview' },
  { key: 'taxonomy', label: 'AI Taxonomy' },
  { key: 'config', label: 'Configure' },
  { key: 'upload', label: 'Upload' },
];

interface WizardStepIndicatorProps {
  currentStep: WizardStep;
  /** Optional subset/order of step keys to display (e.g. append mode skips taxonomy). */
  stepKeys?: WizardStep[];
}

export default function WizardStepIndicator({ currentStep, stepKeys }: WizardStepIndicatorProps) {
  const theme = useTheme();
  // Honor the caller-supplied order (not the static STEPS order); drop unknown keys.
  const STEPS_TO_SHOW = stepKeys
    ? stepKeys.map(k => STEPS.find(s => s.key === k)).filter((s): s is (typeof STEPS)[number] => Boolean(s))
    : STEPS;
  const currentIndex = STEPS_TO_SHOW.findIndex(s => s.key === currentStep);

  return (
    <Box
      data-testid="wizard-step-indicator"
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 0,
        py: 1.5,
        px: 2,
      }}
    >
      {STEPS_TO_SHOW.map((step, index) => {
        const isCompleted = index < currentIndex;
        const isCurrent = index === currentIndex;

        return (
          <Box key={step.key} sx={{ display: 'flex', alignItems: 'center' }}>
            {/* Step circle + label */}
            <Box
              sx={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                minWidth: 80,
              }}
            >
              <Box
                aria-current={isCurrent ? 'step' : undefined}
                sx={{
                  width: 28,
                  height: 28,
                  borderRadius: '50%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  bgcolor: isCurrent
                    ? 'primary.500'
                    : isCompleted
                      ? 'success.500'
                      : theme.palette.mode === 'dark'
                        ? 'neutral.700'
                        : 'neutral.200',
                  color: isCurrent || isCompleted ? '#fff' : 'text.secondary',
                  fontSize: 13,
                  fontWeight: 'bold',
                  transition: 'all 0.2s',
                }}
              >
                {isCompleted ? <CheckCircleIcon sx={{ fontSize: 18 }} /> : index + 1}
              </Box>
              <Typography
                level="body-xs"
                sx={{
                  mt: 0.5,
                  fontWeight: isCurrent ? 'bold' : 'normal',
                  color: isCurrent ? 'primary.plainColor' : 'text.secondary',
                  whiteSpace: 'nowrap',
                }}
              >
                {step.label}
              </Typography>
            </Box>

            {/* Connecting line */}
            {index < STEPS_TO_SHOW.length - 1 && (
              <Box
                sx={{
                  width: 40,
                  height: 2,
                  bgcolor: index < currentIndex ? 'success.500' : 'divider',
                  mx: 0.5,
                  mb: 2.5, // align with circle center
                  transition: 'background-color 0.2s',
                }}
              />
            )}
          </Box>
        );
      })}
    </Box>
  );
}
