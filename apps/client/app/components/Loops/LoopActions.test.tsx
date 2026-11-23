import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import type { ILoop } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';

const h = vi.hoisted(() => ({
  update: { mutate: vi.fn(), isPending: false },
  run: { mutate: vi.fn(), isPending: false },
  remove: { mutate: vi.fn(), isPending: false },
}));
vi.mock('@client/app/hooks/data/loops', () => ({
  useUpdateLoop: () => h.update,
  useRunLoop: () => h.run,
  useDeleteLoop: () => h.remove,
}));
vi.mock('./LoopFormModal', () => ({ default: () => null }));

import LoopActions from './LoopActions';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderActions = (status: ILoop['status']) =>
  render(
    <CssVarsProvider theme={appTheme}>
      <LoopActions loop={{ id: 'l1', name: 'Digest', status } as ILoop} />
    </CssVarsProvider>
  );

beforeEach(() => vi.clearAllMocks());

describe('LoopActions', () => {
  it('offers Restart on an errored loop, which sets it live', () => {
    renderActions('error');
    expect(screen.queryByTestId('loop-set-live-btn')).toBeNull();
    const restart = screen.getByTestId('loop-restart-btn');
    expect(restart.textContent).toBe('Restart');
    fireEvent.click(restart);
    expect(h.update.mutate).toHaveBeenCalledWith({ id: 'l1', status: 'live' });
  });

  it.each(['paused', 'needs_you', 'draft'] as const)('keeps "Set live" on a %s loop', status => {
    renderActions(status);
    expect(screen.queryByTestId('loop-restart-btn')).toBeNull();
    expect(screen.getByTestId('loop-set-live-btn').textContent).toBe('Set live');
  });
});
