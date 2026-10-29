export type EnvTarget = 'dev' | 'prod';

export declare const ENV_FLAG_MAP: Record<string, EnvTarget>;

export declare const VALUE_OPTIONS: ReadonlySet<string>;

export declare const ARRAY_OPTIONS: ReadonlySet<string>;

export interface SplitEnvFlags {
  cleaned: string[];
  envTarget: EnvTarget | null;
  envFlags: string[];
  mcpServe: boolean;
  serveLocal: boolean;
}

export declare function splitEnvFlags(args: string[]): SplitEnvFlags;
