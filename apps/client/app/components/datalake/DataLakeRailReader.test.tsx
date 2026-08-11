import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { IFabFileDocument } from '@bike4mind/common';
import DataLakeRailReader from './DataLakeRailReader';

const { contentState } = vi.hoisted(() => ({
  contentState: { data: undefined as string | undefined, isLoading: false },
}));
vi.mock('@client/app/hooks/data/fabFiles', () => ({
  useGetFabFileContent: () => contentState,
}));
vi.mock('@client/app/components/Knowledge/MarkdownViewer', () => ({
  default: ({ content }: { content: string }) => <div data-testid="mock-markdown">{content}</div>,
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const file = { id: 'f1', fileName: '[Books] Deep Work.pdf', tags: [] } as unknown as IFabFileDocument;

const renderReader = (onBack = vi.fn()) => {
  render(
    <CssVarsProvider theme={appTheme}>
      <DataLakeRailReader file={file} onBack={onBack} />
    </CssVarsProvider>
  );
  return onBack;
};

describe('DataLakeRailReader', () => {
  beforeEach(() => {
    contentState.data = undefined;
    contentState.isLoading = false;
  });

  it('shows the cleaned file name (no extension, no [Category] prefix) in the header', () => {
    renderReader();
    expect(screen.getByTestId('datalake-rail-reader')).toHaveTextContent('Deep Work');
    expect(screen.queryByText('[Books] Deep Work.pdf')).toBeNull();
  });

  it('renders the file content as markdown once loaded', () => {
    contentState.data = '# Chapter 1';
    renderReader();
    expect(screen.getByTestId('mock-markdown')).toHaveTextContent('# Chapter 1');
  });

  it('shows a fallback message when content cannot load', () => {
    renderReader();
    expect(screen.getByTestId('datalake-rail-reader')).toHaveTextContent(/unable to load/i);
  });

  it('back button calls onBack', () => {
    const onBack = renderReader();
    fireEvent.click(screen.getByTestId('datalake-reader-back-btn'));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
