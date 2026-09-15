import type { ReactNode } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import DataLakeLakePicker from './DataLakeLakePicker';
import DataLakeTreeEmptyState from './DataLakeTreeEmptyState';
import { DataLakeSurfaceProvider } from './surfaceTokens';
import type { DataLakeSurfaceOverrides } from './surfaceTokens';

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children, tokens }: { children: ReactNode; tokens?: DataLakeSurfaceOverrides }) => (
  <CssVarsProvider theme={appTheme}>
    {tokens ? <DataLakeSurfaceProvider tokens={tokens}>{children}</DataLakeSurfaceProvider> : children}
  </CssVarsProvider>
);

const pickerProps = {
  lakes: [],
  isLoading: false,
  isError: false,
  onRetry: vi.fn(),
  selectedLakeId: null,
  onSelect: vi.fn(),
  lakeFileCounts: undefined,
  totalFileCount: 0,
};

/** Product-flavored wording the shared surface must never render on its own. */
const BRANDED = /sonar|on the scope|currents|talking track|mission hub|optimization knowledge/i;

describe('Data Lake surface - brand-agnostic defaults (#842)', () => {
  it('renders neutral empty-state copy with no product flavor', () => {
    render(
      <Wrapper>
        <DataLakeTreeEmptyState variant="no-lakes" />
      </Wrapper>
    );

    const empty = screen.getByTestId('datalake-tree-empty');
    expect(empty).toHaveTextContent('Nothing here yet');
    expect(empty.textContent ?? '').not.toMatch(BRANDED);
  });

  it('names the all-lakes scope neutrally on the lake picker', () => {
    render(
      <Wrapper>
        <DataLakeLakePicker {...pickerProps} />
      </Wrapper>
    );

    const trigger = screen.getByTestId('datalake-lake-picker-btn');
    expect(trigger).toHaveTextContent('All data lakes');
    expect(trigger.textContent ?? '').not.toMatch(BRANDED);
  });
});

describe('Data Lake surface - injected tokens (#842)', () => {
  it('takes empty-state copy from the provider', () => {
    render(
      <Wrapper tokens={{ copy: { zeroTitle: 'Sonar idle', zeroHint: 'Drop into the richest currents.' } }}>
        <DataLakeTreeEmptyState variant="no-lakes" />
      </Wrapper>
    );

    const empty = screen.getByTestId('datalake-tree-empty');
    expect(empty).toHaveTextContent('Sonar idle');
    expect(empty).toHaveTextContent('Drop into the richest currents.');
  });

  it('takes the create label from the provider, so the picker and the empty state agree', () => {
    render(
      <Wrapper tokens={{ copy: { createLabel: 'Chart a new scope' } }}>
        <DataLakeTreeEmptyState variant="no-lakes" onCreate={vi.fn()} />
      </Wrapper>
    );

    expect(screen.getByTestId('datalake-tree-empty-create-btn')).toHaveTextContent('Chart a new scope');
  });

  it('takes the all-lakes label from the provider', () => {
    render(
      <Wrapper tokens={{ copy: { allLakesLabel: 'Every scope' } }}>
        <DataLakeLakePicker {...pickerProps} />
      </Wrapper>
    );

    expect(screen.getByTestId('datalake-lake-picker-btn')).toHaveTextContent('Every scope');
  });
});
