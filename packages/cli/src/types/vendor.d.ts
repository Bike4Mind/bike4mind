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

declare module 'fdir' {
  export interface FdirOptions {
    withDirs?: boolean;
    withSymlinks?: boolean;
    withRelativePaths?: boolean;
    withMaxDepth?: number;
    withPathSeparator?: string;
  }

  export class fdir {
    constructor(options?: FdirOptions);
    withRelativePaths(): this;
    withDirs(): this;
    withSymlinks(): this;
    withPathSeparator(separator: string): this;
    withMaxDepth(depth: number): this;
    exclude(callback: (dirPath: string, dirName: string) => boolean): this;
    filter(callback: (filePath: string, isDirectory: boolean) => boolean): this;
    crawl(directory: string): {
      sync(): string[];
      async(): Promise<string[]>;
    };
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
