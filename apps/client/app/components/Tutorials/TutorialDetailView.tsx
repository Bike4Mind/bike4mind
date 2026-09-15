import { Box, Button, IconButton, Sheet, Typography } from '@mui/joy';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { tutorialDetailFor, type TutorialItem } from './tutorialCatalog';

/**
 * The long-form view behind a card: the four explanation sections and a single
 * call to action.
 *
 * The CTA is inert for now, as on the cards. When it is wired it follows the
 * gear's own `ctaAction` grammar (navigate:<path> / external:<url> / files),
 * which the Gears page already interprets.
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

const TutorialDetailView = ({ item, onBack }: { item: TutorialItem; onBack: () => void }) => {
  const detail = tutorialDetailFor(item);

  return (
    <Sheet
      variant="outlined"
      data-testid={`tutorial-detail-${item.key}`}
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
          aria-label="Back to the tutorial list"
          data-testid="tutorial-detail-back-btn"
        >
          <ArrowBackIcon />
        </IconButton>
        <Typography level="title-md" sx={{ fontSize: '18px', fontWeight: 500 }}>
          {item.title}
        </Typography>
      </Box>

      <Box sx={{ p: '24px 20px 28px' }}>
        <Section heading="What it does" body={detail.whatItDoes} />
        <Section heading="Why it works this way" body={detail.whyItWorks} />
        <Section heading="When to use it" body={detail.whenToUse} />
        <Section heading="Gotchas" body={detail.gotchas} />

        <Box sx={{ mt: '32px', display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
          <Button
            variant="solid"
            color="primary"
            data-testid={`tutorial-detail-cta-${item.key}`}
            // The arrow is a decorator rather than part of the label, so Joy's own
            // gap sets the spacing instead of a literal space in the text.
            endDecorator={<>&rarr;</>}
            sx={{ '--Button-minHeight': '40px', '--Button-gap': '10px' }}
          >
            {item.cta}
          </Button>
          {detail.ctaHelper && (
            <Typography level="body-sm" sx={{ fontSize: '13px', color: 'text.tertiary' }}>
              {detail.ctaHelper}
            </Typography>
          )}
        </Box>
      </Box>
    </Sheet>
  );
};

export default TutorialDetailView;
