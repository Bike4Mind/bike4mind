import { Box, IconButton, Sheet, Typography } from '@mui/joy';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { tutorialDetailFor, type TutorialItem } from './tutorialCatalog';

/**
 * The long-form view behind a card: the four explanation sections and a single
 * call to action.
 *
 * The CTA renders as a label, not a control, for the reason given in
 * TutorialCard: nothing here is wired, and something that looks clickable and
 * does nothing is worse than something that plainly is not. When it is wired it
 * follows the gear's own `ctaAction` grammar (navigate:<path> / external:<url> /
 * files), which the Gears page already interprets.
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
          {/* A label, not a Button: the same rule TutorialCard applies to its own
              un-wired CTA. An entity rather than the arrow character keeps this
              file ASCII - Prettier rewrites a unicode escape back to the glyph. */}
          <Typography
            level="title-sm"
            data-testid={`tutorial-detail-cta-${item.key}`}
            sx={{ fontSize: '14px', fontWeight: 500, color: 'text.primary' }}
          >
            {item.cta} &rarr;
          </Typography>
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
