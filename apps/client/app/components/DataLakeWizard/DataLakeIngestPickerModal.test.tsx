import type { ReactNode } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import DataLakeIngestPickerModal from './DataLakeIngestPickerModal';

const useGetDataLakes = vi.fn();
vi.mock('@client/app/hooks/data/dataLakes', () => ({
  useGetDataLakes: () => useGetDataLakes(),
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

describe('DataLakeIngestPickerModal', () => {
  it('hides the generated prefix chip of a GitHub connector lake, keeping a typed one', () => {
    useGetDataLakes.mockReturnValue({
      isLoading: false,
      data: [
        { id: 'typed', name: 'Ops', fileTagPrefix: 'ops:', origin: 'curated', canManage: true },
        { id: 'github', name: 'acme/docs', fileTagPrefix: 'gh-1a2b3c4d:', origin: 'connector-fed', canManage: true },
      ],
    });

    render(<DataLakeIngestPickerModal open files={[]} onClose={vi.fn()} />, { wrapper: TestWrapper });

    expect(screen.getByTestId('datalake-ingest-prefix-typed')).toHaveTextContent('ops:');
    expect(screen.getByTestId('datalake-ingest-option-github')).toHaveTextContent('acme/docs');
    expect(screen.queryByTestId('datalake-ingest-prefix-github')).not.toBeInTheDocument();
  });
});
