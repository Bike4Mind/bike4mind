import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { describe, expect, it } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import ResearchTaskDetailWarnings from './Warnings';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderWarnings = (warnings?: string[]) =>
  render(
    <CssVarsProvider theme={appTheme}>
      <ResearchTaskDetailWarnings warnings={warnings} />
    </CssVarsProvider>
  );

describe('ResearchTaskDetailWarnings', () => {
  it('lists each warning from the latest run', () => {
    renderWarnings(['Storage limit reached: kept the previous copy of https://example.com']);

    expect(screen.getByTestId('research-task-warnings').textContent).toContain(
      'Storage limit reached: kept the previous copy of https://example.com'
    );
  });

  it('renders nothing when the run had no warnings', () => {
    renderWarnings([]);
    renderWarnings(undefined);

    expect(screen.queryByTestId('research-task-warnings')).toBeNull();
  });
});
