import type { ReactNode } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import DataLakeArticle from './DataLakeArticle';
import DataLakeTree from './DataLakeTree';
import { SURFACE_HUES } from './surfaceChrome';
import { DataLakeSurfaceProvider } from './surfaceTokens';
import type { DataLakeSurfaceOverrides } from './surfaceTokens';
import type { IFabFileDocument } from '@bike4mind/common';

vi.mock('@client/app/hooks/data/fabFiles', () => ({
  useGetFabFileContent: () => ({ data: undefined, isLoading: false }),
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children, tokens }: { children: ReactNode; tokens?: DataLakeSurfaceOverrides }) => (
  <CssVarsProvider theme={appTheme}>
    {tokens ? <DataLakeSurfaceProvider tokens={tokens}>{children}</DataLakeSurfaceProvider> : children}
  </CssVarsProvider>
);

const treeProps = {
  tree: [
    { segment: 'opti', fullPath: 'opti', fileCount: 3, children: [] },
    { segment: 'shared-notes', fullPath: 'shared-notes', fileCount: 1, children: [] },
  ],
  articles: [],
  breadcrumb: [],
  onNavigate: vi.fn(),
  selectedFileId: null,
  onSelectFile: vi.fn(),
  isLoading: false,
};

const FILE = { id: 'f1', fileName: 'Ion traps.md', tags: [] } as unknown as IFabFileDocument;

const StubLeafIcon = () => <span data-testid="stub-leaf-icon" />;

/** Product-flavored wording the shared surface must never render on its own. */
const BRANDED = /sonar|on the scope|currents|talking track|mission hub|optimization knowledge/i;

describe('Data Lake surface - brand-agnostic defaults (#842)', () => {
  it('renders neutral empty-state copy with no product flavor', () => {
    render(
      <Wrapper>
        <DataLakeArticle file={null} onAskAbout={vi.fn()} />
      </Wrapper>
    );

    const empty = screen.getByTestId('datalake-article-empty');
    expect(empty).toHaveTextContent('Nothing selected yet');
    expect(empty.textContent ?? '').not.toMatch(BRANDED);
  });

  it('sends a neutral prompt from the article actions', () => {
    const onAskAbout = vi.fn();
    render(
      <Wrapper>
        <DataLakeArticle file={FILE} onAskAbout={onAskAbout} />
      </Wrapper>
    );

    fireEvent.click(screen.getByTestId('datalake-secondary-action'));
    expect(onAskAbout).toHaveBeenCalledWith(expect.stringContaining('Summarize the key points of "Ion traps"'));
    expect(onAskAbout.mock.calls[0][0]).not.toMatch(BRANDED);
  });

  it('labels tree branches from the raw segment when no taxonomy is injected', () => {
    render(
      <Wrapper>
        <DataLakeTree {...treeProps} />
      </Wrapper>
    );

    expect(screen.getByTestId('datalake-node-opti')).toHaveTextContent('Opti');
    expect(screen.getByTestId('datalake-node-opti').textContent ?? '').not.toMatch(BRANDED);
    // De-slugged in place, not looked up in a product taxonomy.
    expect(screen.getByTestId('datalake-node-shared-notes')).toHaveTextContent('Shared notes');
  });
});

describe('Data Lake surface - injected tokens (#842)', () => {
  it('takes empty-state copy from the provider', () => {
    render(
      <Wrapper tokens={{ copy: { emptyTitle: 'Sonar idle', emptyHint: 'Drop into the richest currents.' } }}>
        <DataLakeArticle file={null} onAskAbout={vi.fn()} />
      </Wrapper>
    );

    expect(screen.getByTestId('datalake-article-empty')).toHaveTextContent('Sonar idle');
  });

  it('takes the article secondary action label and prompt from the provider', () => {
    const onAskAbout = vi.fn();
    render(
      <Wrapper
        tokens={{
          copy: {
            secondaryActionLabel: 'Turn into a talking track',
            secondaryActionPrompt: title => `Talking track for ${title}`,
          },
        }}
      >
        <DataLakeArticle file={FILE} onAskAbout={onAskAbout} />
      </Wrapper>
    );

    const action = screen.getByTestId('datalake-secondary-action');
    expect(action).toHaveTextContent('Turn into a talking track');
    fireEvent.click(action);
    expect(onAskAbout).toHaveBeenCalledWith('Talking track for Ion traps');
  });

  it('drops the secondary action when its copy is cleared', () => {
    render(
      <Wrapper tokens={{ copy: { secondaryActionLabel: undefined, secondaryActionPrompt: undefined } }}>
        <DataLakeArticle file={FILE} onAskAbout={vi.fn()} />
      </Wrapper>
    );

    expect(screen.getByTestId('datalake-ask-about')).toBeInTheDocument();
    expect(screen.queryByTestId('datalake-secondary-action')).not.toBeInTheDocument();
  });

  it('takes tree labels, branch hues, and icons from the provider', () => {
    render(
      <Wrapper
        tokens={{
          taxonomy: { prefixLabels: { opti: 'Optimization Knowledge' } },
          theme: { branchHues: { opti: SURFACE_HUES.emerald } },
          icons: { leafBranch: StubLeafIcon },
        }}
      >
        <DataLakeTree {...treeProps} />
      </Wrapper>
    );

    const node = screen.getByTestId('datalake-node-opti');
    expect(node).toHaveTextContent('Optimization Knowledge');
    expect(node.querySelector('[data-testid="stub-leaf-icon"]')).not.toBeNull();
  });
});
