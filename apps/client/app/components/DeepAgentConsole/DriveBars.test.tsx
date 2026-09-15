import { describe, it, expect } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import DriveBars from './DriveBars';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

describe('DriveBars', () => {
  it('renders all six drives with their values', () => {
    render(
      <TestWrapper>
        <DriveBars
          drives={{ curiosity: 0.75, progress: 0.5, social: 0.25, novelty: 0.4, caution: 0.85, aesthetic: 0.1 }}
        />
      </TestWrapper>
    );
    expect(screen.getByTestId('deep-agent-drive-bars')).toBeTruthy();
    for (const label of ['Curiosity', 'Progress', 'Social', 'Novelty', 'Caution', 'Aesthetic']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(screen.getByText('0.75')).toBeTruthy();
    expect(screen.getByText('0.85')).toBeTruthy();
  });
});
