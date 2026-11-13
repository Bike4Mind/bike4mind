import type { ReactNode } from 'react';
import { styled } from '@mui/system';
import { useNavigate } from '@tanstack/react-router';
import StudioSegmentedControl, { type StudioSegmentOption } from '../design/StudioSegmentedControl';
import StudioThemeScope from '../design/StudioThemeScope';
import { studioColor } from '../design/studioTokens';
import { useStudioFeature } from '../useStudioFeature';
import StudioCreditsBalance from './StudioCreditsBalance';

export type StudioArea = 'create' | 'productions' | 'library';

const PHONE = '@media (max-width: 599.95px)';
const DESKTOP = '@media (min-width: 900px)';

// Full bleed, unlike PageFrame's inset card: Studio is its own space. The app shell's page area is
// fixed-height, so the stage owns the scroll (as PageFrame does).
const Stage = styled(StudioThemeScope)({
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  overflowY: 'auto',
  overflowX: 'hidden',
});

const Header = styled('header')({
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: '12px 24px',
  padding: '14px 24px',
  borderBottom: `1px solid ${studioColor('hairline')}`,
  [PHONE]: { padding: '12px 16px' },
});

const Title = styled('h1')({
  margin: 0,
  fontSize: '18px',
  fontWeight: 700,
  lineHeight: 1.2,
  letterSpacing: '-0.01em',
  color: studioColor('text-strong'),
});

// On a phone the area switcher drops to its own full-width row under the title and balance.
const AreaSwitcher = styled('div')({
  minWidth: 0,
  [PHONE]: {
    order: 3,
    flexBasis: '100%',
    '& [role="tablist"]': { display: 'flex', width: '100%' },
    '& [role="tab"]': { flex: 1 },
  },
});

const HeaderEnd = styled('div')({ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '12px' });

const Body = styled('div')({
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  minWidth: 0,
  [DESKTOP]: { flexDirection: 'row' },
});

const Main = styled('main')({
  flex: 1,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: '20px',
  padding: '24px',
  [PHONE]: { padding: '16px' },
});

type StudioV2FrameProps = {
  area: StudioArea;
  testId: string;
  /** A side rail between the header and the content: Create's medium rail. */
  rail?: ReactNode;
  children: ReactNode;
};

/** The Studio stage every v2 area sits on: the header (title, area switcher, balance), an optional rail, then the area. */
const StudioV2Frame = ({ area, testId, rail, children }: StudioV2FrameProps) => {
  const navigate = useNavigate();
  const isImageOpen = useStudioFeature('image');
  const isProductionsOpen = useStudioFeature('productions');

  const areas: StudioSegmentOption<StudioArea>[] = [
    { value: 'create', label: 'Create', testId: 'studio-area-create' },
    ...(isProductionsOpen
      ? [{ value: 'productions' as const, label: 'Productions', testId: 'studio-area-productions' }]
      : []),
    { value: 'library', label: 'Library', testId: 'studio-area-library' },
  ];

  const goTo = (target: StudioArea) => {
    if (target === area) return;
    if (target === 'create') {
      void navigate({ to: '/studio/$modality', params: { modality: isImageOpen ? 'image' : 'video' } });
      return;
    }
    void navigate({ to: target === 'productions' ? '/studio/productions' : '/studio/library' });
  };

  return (
    <Stage testId={testId}>
      <Header data-testid="studio-header">
        <Title>Studio</Title>
        <AreaSwitcher>
          <StudioSegmentedControl
            aria-label="Studio areas"
            semantics="tabs"
            options={areas}
            value={area}
            onChange={goTo}
            testId="studio-area-tabs"
          />
        </AreaSwitcher>
        <HeaderEnd>
          <StudioCreditsBalance />
        </HeaderEnd>
      </Header>
      <Body>
        {rail}
        <Main>{children}</Main>
      </Body>
    </Stage>
  );
};

export default StudioV2Frame;
