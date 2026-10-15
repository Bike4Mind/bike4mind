// Type declarations for packages without bundled types

declare module 'fzf' {
  export interface FzfResultItem<T> {
    item: T;
    score: number;
    positions: Set<number>;
  }

  export class AsyncFzf<T> {
    constructor(items: T[]);
    find(query: string): Promise<FzfResultItem<T>[]>;
  }

  export class Fzf<T> {
    constructor(items: T[]);
    find(query: string): FzfResultItem<T>[];
  }
}

declare module 'ignore' {
  interface Ignore {
    add(pattern: string | string[]): this;
    ignores(pathname: string): boolean;
    filter(paths: string[]): string[];
    createFilter(): (path: string) => boolean;
  }

  function ignore(): Ignore;
  export = ignore;
}
