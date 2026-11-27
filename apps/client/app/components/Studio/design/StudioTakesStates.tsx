import type { ReactNode } from 'react';
import { keyframes, styled } from '@mui/system';
import { studioColor, studioFont, studioRadius } from './studioTokens';

/** The takes grid: tiles at least 220px wide, as many columns as fit. */
export const StudioTakesGrid = styled('div')({
  display: 'grid',
  gap: '16px',
  gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
});

const shimmer = keyframes({
  '0%': { backgroundPosition: '100% 0' },
  '100%': { backgroundPosition: '-100% 0' },
});

const SkeletonTile = styled('div')({
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  borderRadius: studioRadius('lg'),
  border: `1px solid ${studioColor('hairline')}`,
  backgroundColor: studioColor('surface'),
});

/** A shimmering placeholder block; size it with `style`. It holds still under reduced motion. */
export const StudioSkeletonBlock = styled('div')({
  borderRadius: studioRadius('xs'),
  backgroundColor: studioColor('raised'),
  backgroundImage: `linear-gradient(90deg, transparent 0%, ${studioColor('hover')} 50%, transparent 100%)`,
  backgroundSize: '200% 100%',
  animation: `${shimmer} 1.4s ease-in-out infinite`,
  '@media (prefers-reduced-motion: reduce)': { animation: 'none', backgroundImage: 'none' },
});

// Enough placeholder tiles to suggest a gallery without implying how many takes are coming.
const SKELETON_TILE_COUNT = 4;

/** The takes grid while the first page loads: placeholder tiles in place of a lone spinner. */
export const StudioTakesLoading = ({ testId, label }: { testId: string; label: string }) => (
  <StudioTakesGrid role="status" aria-label={label} data-testid={testId}>
    {Array.from({ length: SKELETON_TILE_COUNT }, (_, index) => (
      <SkeletonTile key={index} aria-hidden>
        <StudioSkeletonBlock style={{ aspectRatio: '1 / 1', borderRadius: 0 }} />
        <div style={{ display: 'flex', gap: '8px', padding: '12px' }}>
          <StudioSkeletonBlock style={{ height: '10px', flex: 1 }} />
          <StudioSkeletonBlock style={{ height: '10px', width: '48px' }} />
        </div>
      </SkeletonTile>
    ))}
  </StudioTakesGrid>
);

const MessageRoot = styled('div')({
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: '8px',
  padding: '40px 24px',
  textAlign: 'center',
  borderRadius: studioRadius('xl'),
  border: `1px dashed ${studioColor('border')}`,
  backgroundColor: studioColor('sunken'),
  color: studioColor('text-secondary'),
  font: `400 13px/1.5 ${studioFont('ui')}`,
  '& svg': { fontSize: '28px', color: studioColor('text-muted') },
  '&[data-tone="danger"]': {
    borderStyle: 'solid',
    borderColor: studioColor('danger-border'),
    backgroundColor: studioColor('danger-soft'),
    color: studioColor('danger'),
    '& svg': { color: studioColor('danger') },
  },
  // Inline: a single line under the grid (a failed "Load more"), not a full panel.
  '&[data-inline="true"]': { padding: '10px 16px', flexDirection: 'row', justifyContent: 'center' },
});

type StudioTakesMessageProps = {
  children: ReactNode;
  icon?: ReactNode;
  tone?: 'neutral' | 'danger';
  inline?: boolean;
  testId: string;
};

/** The gallery's empty and failed-to-load states: a quiet dashed panel, or a danger-toned one. */
export const StudioTakesMessage = ({
  children,
  icon,
  tone = 'neutral',
  inline = false,
  testId,
}: StudioTakesMessageProps) => (
  <MessageRoot
    data-tone={tone}
    data-inline={inline}
    role={tone === 'danger' ? 'alert' : undefined}
    data-testid={testId}
  >
    {icon}
    <span>{children}</span>
  </MessageRoot>
);
