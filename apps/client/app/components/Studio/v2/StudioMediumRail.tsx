import { styled } from '@mui/system';
import { useNavigate } from '@tanstack/react-router';
import { STUDIO_FOCUS_VISIBLE, studioColor, studioFont, studioRadius } from '../design/studioTokens';
import { useStudioFeature } from '../useStudioFeature';
import type { StudioMedium } from '../studioModality';
import { STUDIO_CREATE_DEFINITIONS, STUDIO_CREATE_MEDIA } from './studioCreateMedia';

const DESKTOP = '@media (min-width: 900px)';

// Line glyphs from the Studio mock, drawn on a 24px grid with a 1.6 stroke.
const MEDIUM_GLYPHS: Record<StudioMedium, string> = {
  image: 'M3 4h18v16H3zM9 12a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM21 16l-5-5-9 9',
  video: 'M3 6h13v12H3zM16 10l5-3v10l-5-3',
  music: 'M9 18V5l11-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM20 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
  speech: 'M9 3h6v11H9zM5 11a7 7 0 0 0 14 0M12 18v3',
  'sound-effects': 'M2 12h3l2-6 4 12 3-9 2 3h6',
};

// A column beside the stage on desktop; a scrolling row under the header below that.
const Rail = styled('nav')({
  display: 'flex',
  gap: '6px',
  padding: '10px 16px',
  overflowX: 'auto',
  scrollbarWidth: 'none',
  borderBottom: `1px solid ${studioColor('hairline')}`,
  [DESKTOP]: {
    flex: '0 0 88px',
    flexDirection: 'column',
    padding: '20px 10px',
    overflowX: 'visible',
    borderBottom: 0,
    borderRight: `1px solid ${studioColor('hairline')}`,
  },
});

const Glyph = styled('span')({
  display: 'grid',
  placeItems: 'center',
  width: '36px',
  height: '36px',
  borderRadius: studioRadius('md'),
  backgroundColor: studioColor('raised'),
  transition: 'background-color 120ms ease',
  '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
});

const MediumButton = styled('button')({
  flex: '0 0 auto',
  minWidth: '64px',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: '6px',
  padding: '8px 4px',
  borderRadius: studioRadius('md'),
  border: '1px solid transparent',
  backgroundColor: 'transparent',
  color: studioColor('text-secondary'),
  font: `500 12px/1.2 ${studioFont('ui')}`,
  whiteSpace: 'nowrap',
  cursor: 'pointer',
  '&:hover': { color: studioColor('text'), '& .studio-rail-glyph': { backgroundColor: studioColor('hover') } },
  '&:focus-visible': STUDIO_FOCUS_VISIBLE,
  '&[aria-current="page"]': {
    borderColor: studioColor('accent-border'),
    backgroundColor: studioColor('accent-soft'),
    color: studioColor('text-strong'),
    '& .studio-rail-glyph': { backgroundColor: studioColor('accent'), color: studioColor('accent-contrast') },
  },
});

/** Create's medium picker: icon tiles in a column beside the stage on desktop, a scrolling row above it on narrow screens. */
const StudioMediumRail = ({ medium }: { medium: StudioMedium }) => {
  const navigate = useNavigate();
  const isImageOpen = useStudioFeature('image');
  const media = STUDIO_CREATE_MEDIA.filter(candidate => candidate !== 'image' || isImageOpen);

  return (
    <Rail aria-label="Medium" data-testid="studio-medium-rail">
      {media.map(candidate => (
        <MediumButton
          key={candidate}
          type="button"
          aria-current={candidate === medium ? 'page' : undefined}
          onClick={() => {
            if (candidate !== medium) void navigate({ to: '/studio/$modality', params: { modality: candidate } });
          }}
          data-testid={`studio-rail-${candidate}`}
        >
          <Glyph className="studio-rail-glyph" aria-hidden="true">
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d={MEDIUM_GLYPHS[candidate]} />
            </svg>
          </Glyph>
          {STUDIO_CREATE_DEFINITIONS[candidate].railLabel}
        </MediumButton>
      ))}
    </Rail>
  );
};

export default StudioMediumRail;
