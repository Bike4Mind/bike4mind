import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { ContextCompactionNote } from './ContextCompactionNote';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

describe('ContextCompactionNote', () => {
  it('renders nothing when show is false', () => {
    const { container } = render(
      <TestWrapper>
        <ContextCompactionNote show={false} turns={3} onDismiss={vi.fn()} />
      </TestWrapper>
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('states how many turns were condensed (pluralized)', () => {
    render(
      <TestWrapper>
        <ContextCompactionNote show turns={3} onDismiss={vi.fn()} />
      </TestWrapper>
    );
    expect(screen.getByTestId('context-compaction-note-text').textContent).toContain('Condensed 3 earlier turns');
  });

  it('uses the singular form for one turn', () => {
    render(
      <TestWrapper>
        <ContextCompactionNote show turns={1} onDismiss={vi.fn()} />
      </TestWrapper>
    );
    expect(screen.getByTestId('context-compaction-note-text').textContent).toContain('1 earlier turn ');
  });

  it('fires onDismiss when the close button is clicked', () => {
    const onDismiss = vi.fn();
    render(
      <TestWrapper>
        <ContextCompactionNote show turns={2} onDismiss={onDismiss} />
      </TestWrapper>
    );
    fireEvent.click(screen.getByTestId('context-compaction-note-dismiss'));
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
