import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';

const { starred, toggleStar } = vi.hoisted(() => ({ starred: new Set<string>(), toggleStar: vi.fn() }));
vi.mock('@client/app/hooks/data/fileStars', () => ({
  useStarredFileIds: () => starred,
  useToggleFileStar: () => ({ mutate: toggleStar }),
}));

import FileStarButton from './FileStarButton';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const renderStar = (onParentClick = vi.fn()) => {
  render(
    <TestWrapper>
      <div onClick={onParentClick}>
        <FileStarButton fileId="f1" />
      </div>
    </TestWrapper>
  );
  return onParentClick;
};

describe('FileStarButton', () => {
  beforeEach(() => {
    starred.clear();
    toggleStar.mockReset();
  });

  it('stars an unstarred file without selecting the tile under it', () => {
    const onParentClick = renderStar();
    const button = screen.getByTestId('file-browser-item-star-btn');
    expect(button).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(button);

    expect(toggleStar).toHaveBeenCalledWith({ fileId: 'f1', starred: true });
    expect(onParentClick).not.toHaveBeenCalled();
  });

  it('unstars a starred file', () => {
    starred.add('f1');
    renderStar();
    const button = screen.getByTestId('file-browser-item-star-btn');
    expect(button).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(button);

    expect(toggleStar).toHaveBeenCalledWith({ fileId: 'f1', starred: false });
  });
});
