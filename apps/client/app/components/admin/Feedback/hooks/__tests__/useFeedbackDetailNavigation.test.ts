import { describe, it, expect, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useFeedbackDetailNavigation } from '../useFeedbackDetailNavigation';

type Params = Parameters<typeof useFeedbackDetailNavigation>[0];

const setup = (overrides: Partial<Params> = {}) => {
  const open = vi.fn();
  const onPageChange = vi.fn();
  const initial: Params = {
    rowIds: ['a', 'b', 'c'],
    openId: 'b',
    page: 1,
    pageSize: 3,
    total: 3,
    settled: true,
    onPageChange,
    open,
    ...overrides,
  };
  const hook = renderHook((props: Params) => useFeedbackDetailNavigation(props), { initialProps: initial });
  return { ...hook, open, onPageChange, initial };
};

describe('useFeedbackDetailNavigation', () => {
  it('opens the neighbouring rows on the page', () => {
    const { result, open } = setup();

    act(() => result.current.onPrevious?.());
    expect(open).toHaveBeenLastCalledWith('a');
    act(() => result.current.onNext?.());
    expect(open).toHaveBeenLastCalledWith('c');
  });

  it('gives the place across the whole filtered list, not the page', () => {
    const { result } = setup({ page: 2, total: 8 });

    expect(result.current.position).toEqual({ index: 5, total: 8 });
  });

  it('has no previous on the first report and no next on the last', () => {
    expect(setup({ openId: 'a' }).result.current.onPrevious).toBeUndefined();
    expect(setup({ openId: 'c' }).result.current.onNext).toBeUndefined();
  });

  it('turns to the next page and opens its first report once it has loaded', () => {
    const { result, rerender, open, onPageChange, initial } = setup({ openId: 'c', total: 6 });

    act(() => result.current.onNext?.());
    expect(onPageChange).toHaveBeenCalledWith(2);
    expect(open).not.toHaveBeenCalled();

    // keepPreviousData: page 2 is requested but page 1's rows are still on screen.
    rerender({ ...initial, openId: 'c', total: 6, page: 2, settled: false });
    expect(open).not.toHaveBeenCalled();

    rerender({ ...initial, openId: 'c', total: 6, page: 2, settled: true, rowIds: ['d', 'e', 'f'] });
    expect(open).toHaveBeenCalledWith('d');
  });

  it('turns to the previous page and opens its last report', () => {
    const { result, rerender, open, onPageChange, initial } = setup({
      rowIds: ['d', 'e', 'f'],
      openId: 'd',
      page: 2,
      total: 6,
    });

    act(() => result.current.onPrevious?.());
    expect(onPageChange).toHaveBeenCalledWith(1);

    rerender({ ...initial, openId: 'd', total: 6, page: 1, rowIds: ['a', 'b', 'c'] });
    expect(open).toHaveBeenCalledWith('c');
  });

  // Closing a report under the "New" filter drops it from the list; next should still go on.
  it('keeps going from the place of a report that left the filtered list', () => {
    const { result, rerender, open, initial } = setup();

    rerender({ ...initial, rowIds: ['a', 'c'], total: 2 });

    expect(result.current.position).toBeUndefined();
    act(() => result.current.onNext?.());
    expect(open).toHaveBeenLastCalledWith('c');
    act(() => result.current.onPrevious?.());
    expect(open).toHaveBeenLastCalledWith('a');
  });

  it('offers no navigation for a linked report that was never in the list', () => {
    const { result } = setup({ openId: 'elsewhere' });

    expect(result.current).toEqual({});
  });

  it('waits for the new page to settle before opening its edge report', () => {
    const { result, rerender, open, initial } = setup({ openId: 'c', total: 6 });

    act(() => result.current.onNext?.());
    rerender({ ...initial, openId: 'c', total: 6, page: 2, settled: false, rowIds: ['d', 'e', 'f'] });
    expect(open).not.toHaveBeenCalled();

    rerender({ ...initial, openId: 'c', total: 6, page: 2, settled: true, rowIds: ['d', 'e', 'f'] });
    expect(open).toHaveBeenCalledWith('d');
  });

  it('drops a page turn that lands on an empty page', () => {
    const { result, rerender, open, initial } = setup({ openId: 'c', total: 6 });

    act(() => result.current.onNext?.());
    expect(result.current).toEqual({});

    rerender({ ...initial, openId: 'c', total: 6, page: 2, settled: true, rowIds: [] });

    expect(open).not.toHaveBeenCalled();
    // pending is cleared, so the hook is no longer stuck on {} (the open report is now unlisted).
    rerender({ ...initial, openId: 'c', total: 6, page: 2, settled: true, rowIds: ['d', 'e', 'f'] });
    expect(open).not.toHaveBeenCalled();
    expect(result.current.onNext).toBeUndefined();
  });

  it('turns to the next page from a dropped report that was last on its page', () => {
    const { result, rerender, onPageChange, initial } = setup({ openId: 'c', total: 6 });

    rerender({ ...initial, openId: 'c', total: 5, rowIds: ['a', 'b'] });
    // c was on index 2; rowIds[2] is now undefined, so next falls through to the page turn.
    expect(result.current.onNext).toBeDefined();
    act(() => result.current.onNext?.());

    expect(onPageChange).toHaveBeenCalledWith(2);
  });

  it('turns to the previous page from a dropped report that was first on a later page', () => {
    const { result, rerender, onPageChange, initial } = setup({
      rowIds: ['d', 'e', 'f'],
      openId: 'd',
      page: 2,
      total: 6,
    });

    rerender({ ...initial, rowIds: ['e', 'f'], openId: 'd', page: 2, total: 5 });
    expect(result.current.onPrevious).toBeDefined();
    act(() => result.current.onPrevious?.());

    expect(onPageChange).toHaveBeenCalledWith(1);
  });

  it('forgets a pending page turn when the drawer closes', () => {
    const { result, rerender, open, initial } = setup({ openId: 'c', total: 6 });

    act(() => result.current.onNext?.());
    rerender({ ...initial, openId: undefined, total: 6, page: 2, settled: false, rowIds: ['a', 'b', 'c'] });
    rerender({ ...initial, openId: undefined, total: 6, page: 2, settled: true, rowIds: ['d', 'e', 'f'] });

    expect(open).not.toHaveBeenCalled();
  });

  it('forgets a pending page turn when a different report is opened', () => {
    const { result, rerender, open, initial } = setup({ openId: 'c', total: 6 });

    act(() => result.current.onNext?.());
    rerender({ ...initial, openId: 'a', total: 6, page: 1, settled: true });
    rerender({ ...initial, openId: 'a', total: 6, page: 2, settled: true, rowIds: ['d', 'e', 'f'] });

    expect(open).not.toHaveBeenCalled();
  });
});
