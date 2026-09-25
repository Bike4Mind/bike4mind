import type { ReactNode } from 'react';
import { Box, IconButton, Sheet, Typography } from '@mui/joy';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { gearDetailFor } from '@client/lib/gears/detail';

/**
 * The long-form view behind a feature card: the four explanation sections and a
 * single call to action, shared by Tutorials and Gears.
 *
 * The CTA is passed in rather than built here, because the two surfaces mean
 * different things by it: on Tutorials nothing is wired, so it is a label, and
 * something that looks clickable and does nothing is worse than something that
 * plainly is not. On Gears the gear's `ctaAction` is interpreted, so it is a
 * real control.
 */

const SECTION_MEASURE = 'min(100%, 72ch)';

const Section = ({ heading, body }: { heading: string; body?: string }) => {
  if (!body) return null;
  return (
    <Box sx={{ mt: '28px', '&:first-of-type': { mt: 0 } }}>
      <Typography level="title-sm" sx={{ fontSize: '16px', fontWeight: 500 }}>
        {heading}
      </Typography>
      {/* Capped at a reading measure: the frame is wide for the card grid, which
          is far past a comfortable line length for paragraphs. */}
      <Typography
        level="body-sm"
        sx={{ mt: '10px', fontSize: '14px', color: 'text.tertiary', maxWidth: SECTION_MEASURE }}
      >
        {body}
      </Typography>
    </Box>
  );
};

const FeatureDetailView = ({
  item,
  cta,
  onBack,
  testIdPrefix,
}: {
  item: { key: string; title: string; intro: string };
  cta: ReactNode;
  onBack: () => void;
  /** Namespaces this view's test ids, e.g. `tutorial-detail` / `gear-detail`. */
  testIdPrefix: string;
}) => {
  const detail = gearDetailFor(item);

  return (
    <Sheet
      variant="outlined"
      data-testid={`${testIdPrefix}-${item.key}`}
      sx={theme => ({
        borderRadius: '12px',
        borderColor: theme.palette.divider,
        backgroundColor: theme.palette.background.body,
        overflow: 'hidden',
      })}
    >
      <Box
        sx={theme => ({
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          px: '20px',
          py: '16px',
          borderBottom: `1px solid ${theme.palette.divider}`,
        })}
      >
        <IconButton
          variant="plain"
          color="neutral"
          size="sm"
          onClick={onBack}
          aria-label="Back to the feature list"
          data-testid={`${testIdPrefix}-back-btn`}
        >
          <ArrowBackIcon />
        </IconButton>
        <Typography level="title-md" sx={{ fontSize: '18px', fontWeight: 500 }}>
          {item.title}
        </Typography>
      </Box>

      <Box sx={{ p: '24px 20px 28px' }}>
        <Section heading="What it does" body={detail.whatItDoes} />
        {!detail.authored && (
          <Typography
            level="body-sm"
            data-testid={`${testIdPrefix}-wip-${item.key}`}
            sx={{ mt: '10px', fontSize: '14px', fontWeight: 500, color: 'primary.500', maxWidth: SECTION_MEASURE }}
          >
            Description in progress
          </Typography>
        )}
        <Section heading="Why it works this way" body={detail.whyItWorks} />
        <Section heading="When to use it" body={detail.whenToUse} />
        <Section heading="Gotchas" body={detail.gotchas} />

        <Box sx={{ mt: '32px' }}>{cta}</Box>
      </Box>
    </Sheet>
  );
};

export default FeatureDetailView;
