import { describe, it, expect } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { Suspense } from 'react';
import { lazyWithPreload } from './lazyWithPreload';

const Page = () => <div data-testid="page-content">page</div>;
const fallback = <div data-testid="page-fallback">loading</div>;

describe('lazyWithPreload', () => {
  it('renders a preloaded component on its first render, never the fallback', async () => {
    const LazyPage = lazyWithPreload(async () => ({ default: Page }));
    await LazyPage.preload();

    // No awaiting inside act: the very first commit must already hold the content.
    act(() => {
      render(<Suspense fallback={fallback}>{<LazyPage />}</Suspense>);
    });

    expect(screen.getByTestId('page-content')).toBeTruthy();
    expect(screen.queryByTestId('page-fallback')).toBeNull();
  });

  it('suspends like plain lazy when rendered before the preload resolved', async () => {
    const LazyPage = lazyWithPreload(async () => ({ default: Page }));

    act(() => {
      render(<Suspense fallback={fallback}>{<LazyPage />}</Suspense>);
    });
    expect(screen.getByTestId('page-fallback')).toBeTruthy();

    expect(await screen.findByTestId('page-content')).toBeTruthy();
  });

  it('loads the chunk once however often it is preloaded', async () => {
    let loads = 0;
    const LazyPage = lazyWithPreload(async () => {
      loads++;
      return { default: Page };
    });
    await Promise.all([LazyPage.preload(), LazyPage.preload()]);
    await LazyPage.preload();
    expect(loads).toBe(1);
  });
});
