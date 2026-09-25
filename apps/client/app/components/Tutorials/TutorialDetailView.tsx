import { Box, Typography } from '@mui/joy';
import FeatureDetailView from '@client/app/components/common/FeatureDetailView';
import type { TutorialItem } from './tutorialCatalog';

/**
 * Tutorials' detail view: the shared layout with a CTA that is deliberately
 * inert.
 *
 * The CTA renders as a label, not a control, for the reason given in
 * TutorialCard: nothing here is wired, and something that looks clickable and
 * does nothing is worse than something that plainly is not. The Gears copy of
 * this view passes a real Button, because there the gear's `ctaAction` grammar
 * is interpreted.
 */
const TutorialDetailView = ({ item, onBack }: { item: TutorialItem; onBack: () => void }) => (
  <FeatureDetailView
    item={item}
    onBack={onBack}
    testIdPrefix="tutorial-detail"
    cta={
      // An entity rather than the arrow character keeps this file ASCII -
      // Prettier rewrites a unicode escape back to the glyph.
      <Typography
        level="title-sm"
        data-testid={`tutorial-detail-cta-${item.key}`}
        sx={{ fontSize: '14px', fontWeight: 500, color: 'text.primary' }}
      >
        {item.cta}
        <Box component="span" sx={{ ml: '6px' }}>
          &rarr;
        </Box>
      </Typography>
    }
  />
);

export default TutorialDetailView;
