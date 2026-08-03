import type { ReactNode } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { toast } from 'sonner';
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

describe('DataLakeExplorer - drag-and-drop discoverability (#839)', () => {
  it('advertises drag-to-add at rest, before any drag has started', () => {
    render(
      <Wrapper>
        <DataLakeExplorer onBack={vi.fn()} onAskAbout={vi.fn()} />
      </Wrapper>
    );

    // No drag is underway, so the drag-active overlay must stay hidden while the
    // resting affordances carry the invitation.
    expect(screen.queryByTestId('datalake-dropzone')).not.toBeInTheDocument();
    expect(screen.getByTestId('datalake-drop-hint')).toHaveTextContent(/drag files here to add/i);
    expect(screen.getByTestId('datalake-drop-prompt')).toBeInTheDocument();
  });

  it('swaps the resting hint for the drag overlay once a file drag enters', () => {
    render(
      <Wrapper>
        <DataLakeExplorer onBack={vi.fn()} onAskAbout={vi.fn()} />
      </Wrapper>
    );

    fireEvent.dragEnter(screen.getByTestId('datalake-explorer'), {
      dataTransfer: { types: ['Files'] },
    });

    expect(screen.getByTestId('datalake-dropzone')).toBeInTheDocument();
    expect(screen.queryByTestId('datalake-drop-hint')).not.toBeInTheDocument();
    expect(screen.queryByTestId('datalake-drop-prompt')).not.toBeInTheDocument();
  });

  it('confirms a successful drop with a toast naming the file count', async () => {
    render(
      <Wrapper>
        <DataLakeExplorer onBack={vi.fn()} onAskAbout={vi.fn()} />
      </Wrapper>
    );

    fireEvent.drop(screen.getByTestId('datalake-explorer'), {
      dataTransfer: {
        types: ['Files'],
        items: [],
        files: [new File(['a'], 'a.txt'), new File(['b'], 'b.txt')],
      },
    });

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/^2 files /)));
  });
});
