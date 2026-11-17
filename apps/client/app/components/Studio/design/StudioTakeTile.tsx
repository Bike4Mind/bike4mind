import type { ReactNode } from 'react';
import { styled } from '@mui/system';
import { STUDIO_FOCUS_VISIBLE, studioColor, studioFont, studioRadius } from './studioTokens';

// A class rather than a component selector: emotion component selectors need its babel plugin.
const ACTION_BAR_CLASS = 'StudioTakeTile-actions';

const ActionBar = styled('div')({
  position: 'absolute',
  left: '10px',
  right: '10px',
  bottom: '10px',
  display: 'flex',
  gap: '4px',
  padding: '4px',
  borderRadius: studioRadius('md'),
  border: `1px solid ${studioColor('border-strong')}`,
  backgroundColor: studioColor('scrim'),
  backdropFilter: 'blur(6px)',
  opacity: 0,
  transform: 'translateY(4px)',
  transition: 'opacity 140ms ease, transform 140ms ease',
  pointerEvents: 'none',
  '@media (prefers-reduced-motion: reduce)': { transition: 'none', transform: 'none' },
});

const TileRoot = styled('article')({
  display: 'flex',
  flexDirection: 'column',
  minWidth: 0,
  margin: 0,
  overflow: 'hidden',
  borderRadius: studioRadius('lg'),
  border: `1px solid ${studioColor('border')}`,
  backgroundColor: studioColor('surface'),
  transition: 'border-color 120ms ease, box-shadow 120ms ease',
  '&[data-selected="true"]': {
    borderColor: studioColor('accent-bright'),
    boxShadow: `0 0 0 1px ${studioColor('accent-bright')}`,
  },
  // The bar shows on hover, on keyboard focus inside the tile, on the picked take, and always on touch.
  [`&:hover .${ACTION_BAR_CLASS}, &:focus-within .${ACTION_BAR_CLASS}, &[data-selected="true"] .${ACTION_BAR_CLASS}`]: {
    opacity: 1,
    transform: 'none',
    pointerEvents: 'auto',
  },
  '@media (hover: none)': { [`& .${ACTION_BAR_CLASS}`]: { opacity: 1, transform: 'none', pointerEvents: 'auto' } },
  '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
});

const Media = styled('div')({
  position: 'relative',
  display: 'grid',
  placeItems: 'center',
  overflow: 'hidden',
  backgroundColor: studioColor('raised'),
  '& > img, & > video': { width: '100%', height: '100%', objectFit: 'cover', display: 'block' },
});

const Caption = styled('div')({
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  minWidth: 0,
  padding: '10px 12px',
});

const Title = styled('span')({
  font: `600 13px/1.3 ${studioFont('ui')}`,
  color: studioColor('text'),
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});

const Meta = styled('span')({
  fontFamily: studioFont('mono'),
  fontSize: '11px',
  color: studioColor('text-muted'),
  whiteSpace: 'nowrap',
});

type StudioTakeTileProps = {
  /** The take itself: an `<img>`/`<video>` fills the frame, anything else is centred (progress, failure). */
  media: ReactNode;
  title: ReactNode;
  /** Mono detail beside the title: a seed, a duration, "developing". */
  meta?: ReactNode;
  /** CSS aspect ratio of the frame, e.g. `4 / 5`. */
  aspectRatio?: string;
  selected?: boolean;
  /** StudioTakeAction buttons for the floating bar. */
  actions?: ReactNode;
  testId?: string;
};

/** One generated take: the media is the hero, its actions float over it in a quiet bar. */
export const StudioTakeTile = ({
  media,
  title,
  meta,
  aspectRatio = '1 / 1',
  selected = false,
  actions,
  testId = 'studio-take-tile',
}: StudioTakeTileProps) => (
  <TileRoot data-selected={selected} data-testid={testId}>
    <Media style={{ aspectRatio }} data-testid={`${testId}-media`}>
      {media}
      {actions != null && (
        <ActionBar
          className={ACTION_BAR_CLASS}
          role="group"
          aria-label="Take actions"
          data-testid={`${testId}-actions`}
        >
          {actions}
        </ActionBar>
      )}
    </Media>
    <Caption>
      <Title>{title}</Title>
      {meta != null && <Meta data-testid={`${testId}-meta`}>{meta}</Meta>}
    </Caption>
  </TileRoot>
);

const ActionButton = styled('button')({
  display: 'grid',
  placeItems: 'center',
  width: '36px',
  height: '36px',
  borderRadius: studioRadius('sm'),
  border: '1px solid transparent',
  backgroundColor: 'transparent',
  color: studioColor('text-secondary'),
  cursor: 'pointer',
  '&:hover': { backgroundColor: studioColor('hover'), borderColor: studioColor('border'), color: studioColor('text') },
  '&:focus-visible': STUDIO_FOCUS_VISIBLE,
  '&[data-push-end="true"]': { marginLeft: 'auto' },
  '&[aria-pressed="true"]': { color: studioColor('star') },
});

type StudioTakeActionProps = {
  /** Accessible name and tooltip; the button shows only its icon. */
  label: string;
  icon: ReactNode;
  onClick?: () => void;
  /** For toggles like Star: drawn in the warm star color while on. */
  pressed?: boolean;
  /** Pushes this and later actions to the right end of the bar. */
  pushEnd?: boolean;
  testId?: string;
};

/** An icon button for a StudioTakeTile action bar. */
export const StudioTakeAction = ({ label, icon, onClick, pressed, pushEnd, testId }: StudioTakeActionProps) => (
  <ActionButton
    type="button"
    aria-label={label}
    title={label}
    aria-pressed={pressed}
    data-push-end={pushEnd || undefined}
    onClick={onClick}
    data-testid={testId}
  >
    {icon}
  </ActionButton>
);
