import type { ReactNode } from 'react';
import { styled } from '@mui/system';
import { STUDIO_MICRO_LABEL, studioColor, studioRadius } from './studioTokens';

type PanelTone = 'surface' | 'sunken';

const PanelRoot = styled('section')({
  display: 'flex',
  flexDirection: 'column',
  gap: '14px',
  minWidth: 0,
  padding: '16px',
  borderRadius: studioRadius('xl'),
  border: `1px solid ${studioColor('border')}`,
  backgroundColor: studioColor('surface'),
  '&[data-tone="sunken"]': {
    backgroundColor: studioColor('sunken'),
    borderColor: studioColor('hairline'),
  },
});

type StudioPanelProps = {
  children: ReactNode;
  /** Names the region for assistive tech; the panel is a landmark-less section otherwise. */
  'aria-label'?: string;
  tone?: PanelTone;
  testId?: string;
  className?: string;
};

/** The hairline-bordered surface Studio groups controls on: 14px corners, no shadow. */
export const StudioPanel = ({ children, tone = 'surface', testId = 'studio-panel', ...rest }: StudioPanelProps) => (
  <PanelRoot data-tone={tone} data-testid={testId} {...rest}>
    {children}
  </PanelRoot>
);

const LabelRoot = styled('p')({ ...STUDIO_MICRO_LABEL, margin: 0 });
const ControlLabelRoot = styled('label')({ ...STUDIO_MICRO_LABEL, margin: 0 });

type StudioSectionLabelProps = {
  children: ReactNode;
  /** Render as a `<label>` tied to a control. */
  htmlFor?: string;
  testId?: string;
};

/** The uppercase micro-label that heads a Studio section ("DESCRIBE THE IMAGE", "SHAPE"). */
export const StudioSectionLabel = ({ children, htmlFor, testId = 'studio-section-label' }: StudioSectionLabelProps) =>
  htmlFor ? (
    <ControlLabelRoot htmlFor={htmlFor} data-testid={testId}>
      {children}
    </ControlLabelRoot>
  ) : (
    <LabelRoot data-testid={testId}>{children}</LabelRoot>
  );
