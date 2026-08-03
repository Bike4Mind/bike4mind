import type { ReactNode } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import DataLakeExplorer from './DataLakeExplorer';

// The browse hooks hit react-query; stub them to an empty, non-loading result so the
// explorer renders its header without a QueryClientProvider.
vi.mock('@client/app/hooks/data/fabFiles', () => ({
  useGetDataLakeTagCounts: () => ({ data: undefined, isLoading: false, isError: false }),
  useGetDataLakeArticles: () => ({ data: undefined }),
}));

// Heavy children are irrelevant to the header assertion - keep them inert.
vi.mock('./DataLakeTree', () => ({ default: () => null }));
vi.mock('./DataLakeArticle', () => ({ default: () => null }));
vi.mock('@client/app/components/DataLakeWizard/DataLakeIngestPickerModal', () => ({ default: () => null }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

describe('DataLakeExplorer - persistent Data Lakes info tooltip (#834)', () => {
  it('shows a persistent info icon next to the header that reveals the RAG explanation on hover', async () => {
    render(
      <Wrapper>
        <DataLakeExplorer onBack={vi.fn()} onAskAbout={vi.fn()} />
      </Wrapper>
    );

    const trigger = screen.getByTestId('field-tooltip-data-lake-explorer');
    expect(trigger).toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-label', 'Help: Data Lakes');

    fireEvent.mouseOver(trigger);
    expect(
      await screen.findByText(/curated knowledge base the AI grounds its answers in \(RAG\)/i)
    ).toBeInTheDocument();
  });
});

describe('DataLakeExplorer - create-first affordance (#837)', () => {
  it('renders a header Create button when onCreate is provided and invokes it on click', () => {
    const onCreate = vi.fn();
    render(
      <Wrapper>
        <DataLakeExplorer onBack={vi.fn()} onAskAbout={vi.fn()} onCreate={onCreate} />
      </Wrapper>
    );

    const createBtn = screen.getByTestId('datalake-create-btn');
    expect(createBtn).toBeInTheDocument();

    fireEvent.click(createBtn);
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it('omits the create affordance entirely when no onCreate is provided', () => {
    render(
      <Wrapper>
        <DataLakeExplorer onBack={vi.fn()} onAskAbout={vi.fn()} />
      </Wrapper>
    );

    expect(screen.queryByTestId('datalake-create-btn')).not.toBeInTheDocument();
  });
});

describe('DataLakeExplorer - Create primary alongside Manage secondary', () => {
  it('renders both buttons, Create first, each wired to its own handler', () => {
    const onCreate = vi.fn();
    const onManage = vi.fn();
    render(
      <Wrapper>
        <DataLakeExplorer onBack={vi.fn()} onAskAbout={vi.fn()} onCreate={onCreate} onManage={onManage} />
      </Wrapper>
    );

    const createBtn = screen.getByTestId('datalake-create-btn');
    const manageBtn = screen.getByTestId('datalake-manage-btn');
    expect(createBtn.compareDocumentPosition(manageBtn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(createBtn);
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onManage).not.toHaveBeenCalled();

    fireEvent.click(manageBtn);
    expect(onManage).toHaveBeenCalledTimes(1);
  });

  it('gives Create the primary treatment and Manage the secondary one', () => {
    render(
      <Wrapper>
        <DataLakeExplorer onBack={vi.fn()} onAskAbout={vi.fn()} onCreate={vi.fn()} onManage={vi.fn()} />
      </Wrapper>
    );

    // Joy's variant/color modifier classes are a stable public API (unlike its emotion
    // hashes), so they are the only way to assert visual hierarchy without a snapshot.
    const createBtn = screen.getByTestId('datalake-create-btn');
    expect(createBtn.className).toMatch(/MuiButton-variantSolid/);
    expect(createBtn.className).toMatch(/MuiButton-colorPrimary/);

    const manageBtn = screen.getByTestId('datalake-manage-btn');
    expect(manageBtn.className).toMatch(/MuiButton-variantOutlined/);
    expect(manageBtn.className).toMatch(/MuiButton-colorNeutral/);
  });
});
