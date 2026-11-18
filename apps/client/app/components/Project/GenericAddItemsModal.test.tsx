import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import GenericAddItemsModal from './GenericAddItemsModal';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const theme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: ReactNode }) => <CssVarsProvider theme={theme}>{children}</CssVarsProvider>;

describe('Project GenericAddItemsModal', () => {
  it('gives the close button an accessible name', () => {
    render(
      <GenericAddItemsModal
        open
        onOpenChange={vi.fn()}
        title="Add files"
        buttonLabel="Open"
        items={[{ id: 'a' }]}
        selectedIds={[]}
        onSelectIds={vi.fn()}
        getItemId={item => item.id}
        onAdd={vi.fn()}
        renderItem={item => <span>{item.id}</span>}
      />,
      { wrapper: Wrapper }
    );
    expect(screen.getByRole('button', { name: 'common.close' })).toBeTruthy();
  });
});
