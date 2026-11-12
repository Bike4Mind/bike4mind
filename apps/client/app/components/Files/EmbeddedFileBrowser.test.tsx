import { createRef, type ReactNode } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { IFabFileDocument } from '@bike4mind/common';
import { useFileBrowserInstance } from './Browser/instanceContext';

// Replace the heavy FileBrowserContent with a probe that surfaces the instance
// context, so we can verify each EmbeddedFileBrowser mount gets its own isolated
// selection and its own config.onAdd. Keyed by addButtonLabelKey so the two mounts
// can be told apart. Sync factory (referenced lazily on first import) - an async
// factory deadlocks collection through the instanceContext <-> Browser import cycle.
vi.mock('./Browser/Content', () => {
  const ContentProbe = () => {
    const { selectedIds, setSelectedIds, config } = useFileBrowserInstance();
    const key = config.addButtonLabelKey ?? '?';
    return (
      <div>
        <span data-testid={`count-${key}`}>{selectedIds.size}</span>
        <span data-testid={`locked-${key}`}>{JSON.stringify(config.lockedFilters ?? null)}</span>
        <span data-testid={`star-${key}`}>{String(config.enableStar ?? false)}</span>
        <button data-testid={`select-${key}`} onClick={() => setSelectedIds(new Set([...selectedIds, 'f1']))}>
          select
        </button>
        <button
          data-testid={`add-${key}`}
          onClick={() => config.onAdd?.([{ id: 'f1', fileName: 'f1' } as IFabFileDocument])}
        >
          add
        </button>
      </div>
    );
  };
  return { default: ContentProbe };
});

import EmbeddedFileBrowser, { InlineFileBrowser, type EmbeddedFileBrowserHandle } from './EmbeddedFileBrowser';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

describe('EmbeddedFileBrowser', () => {
  it('keeps selection isolated between two mounted instances and routes add to the right one', () => {
    const refA = createRef<EmbeddedFileBrowserHandle>();
    const refB = createRef<EmbeddedFileBrowserHandle>();
    const onAddA = vi.fn();
    const onAddB = vi.fn();

    render(
      <TestWrapper>
        <EmbeddedFileBrowser ref={refA} onAdd={onAddA} addButtonLabelKey="A" />
        <EmbeddedFileBrowser ref={refB} onAdd={onAddB} addButtonLabelKey="B" />
      </TestWrapper>
    );

    act(() => {
      refA.current!.handleOpen();
      refB.current!.handleOpen();
    });

    expect(screen.getByTestId('count-A').textContent).toBe('0');
    expect(screen.getByTestId('count-B').textContent).toBe('0');

    // Selecting in A must not leak into B.
    fireEvent.click(screen.getByTestId('select-A'));
    expect(screen.getByTestId('count-A').textContent).toBe('1');
    expect(screen.getByTestId('count-B').textContent).toBe('0');

    // Add in A calls only A's handler.
    fireEvent.click(screen.getByTestId('add-A'));
    expect(onAddA).toHaveBeenCalledWith([expect.objectContaining({ id: 'f1' })]);
    expect(onAddB).not.toHaveBeenCalled();
  });
});

describe('InlineFileBrowser', () => {
  it('renders the browser in place, without a dialog or an open call', () => {
    render(
      <TestWrapper>
        <InlineFileBrowser addButtonLabelKey="I" lockedFilters={{ source: 'generated' }} enableStar />
      </TestWrapper>
    );

    expect(screen.getByTestId('inline-file-browser')).toBeTruthy();
    expect(screen.queryByTestId('embedded-file-browser-dialog')).toBeNull();
    expect(screen.getByTestId('locked-I').textContent).toBe('{"source":"generated"}');
    expect(screen.getByTestId('star-I').textContent).toBe('true');
  });

  it('keeps its own selection apart from a modal picker on the same screen', () => {
    const ref = createRef<EmbeddedFileBrowserHandle>();
    render(
      <TestWrapper>
        <InlineFileBrowser addButtonLabelKey="I" />
        <EmbeddedFileBrowser ref={ref} addButtonLabelKey="M" />
      </TestWrapper>
    );
    act(() => ref.current!.handleOpen());

    fireEvent.click(screen.getByTestId('select-I'));

    expect(screen.getByTestId('count-I').textContent).toBe('1');
    expect(screen.getByTestId('count-M').textContent).toBe('0');
  });
});
