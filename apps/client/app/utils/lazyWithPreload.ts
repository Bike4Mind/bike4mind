import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

type ModuleWithDefault<T> = { default: T };

/**
 * `React.lazy` plus a `preload()` that, once it has resolved, makes the component's first render
 * synchronous. Plain lazy suspends on its first render even when the chunk is already cached (it
 * only learns the module through a promise), and the router mounts a new route inside a new
 * Suspense boundary, so that suspension paints the fallback - a blank frame - for a route the
 * user can reach mid-flow, like /new -> /notebooks/<id> on a first send.
 */
export function lazyWithPreload<T extends ComponentType>(
  load: () => Promise<ModuleWithDefault<T>>
): LazyExoticComponent<T> & { preload: () => Promise<ModuleWithDefault<T>> } {
  let loaded: ModuleWithDefault<T> | undefined;
  let pending: Promise<ModuleWithDefault<T>> | undefined;
  const preload = () => {
    pending ??= load().then(module => {
      loaded = module;
      return module;
    });
    return pending;
  };
  // React resolves lazy synchronously when the thenable calls back inside then(); a real promise
  // never does, so a loaded module is handed over through a plain thenable instead.
  const Component = lazy(() =>
    loaded
      ? ({ then: (resolve: (module: ModuleWithDefault<T>) => void) => resolve(loaded!) } as Promise<
          ModuleWithDefault<T>
        >)
      : preload()
  );
  return Object.assign(Component, { preload });
}
