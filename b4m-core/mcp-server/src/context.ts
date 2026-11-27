import type { ApiTransport } from './transport/types';
import type { ToolsetId } from './toolsets';

export type ExposureCeiling = 'private' | 'org' | 'public';

/** Everything transport-specific a tool may depend on. The package itself does no I/O. */
export interface ToolContext {
  transport: ApiTransport;
  kind: 'stdio' | 'http';
  /** Scopes the caller's key holds; `'all'` when unknown or keyless (nothing is filtered out). */
  scopes: readonly string[] | 'all';
  /** Widest audience a tool may publish to. Carried for tools that publish; unused by the about toolset. */
  exposureCeiling: ExposureCeiling;
  toolsets: ReadonlySet<ToolsetId>;
  /** Longest a single tool call may block, in seconds. Clamped again to WAIT_BUDGET_SECONDS[kind]. */
  waitBudgetSeconds: number;
  /** Deployment origin, used to render links and install lines. */
  baseUrl: string;
}

/** Hard ceiling per transport: a hosted request must return inside the platform timeout, stdio may wait longer. */
export const WAIT_BUDGET_SECONDS = { http: 25, stdio: 900 } as const;
