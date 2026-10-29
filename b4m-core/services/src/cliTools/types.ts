/**
 * Server-side tool execution types for B4M CLI
 *
 * These tools run server-side using B4M company API keys,
 * providing a seamless experience without requiring users to
 * configure their own API keys.
 */

/**
 * Tools available for server-side execution
 */
export type ServerToolName = 'weather_info' | 'web_search' | 'web_fetch' | 'decide';

/**
 * Implementations the host supplies for server tools whose code lives in the app tier (the
 * decision runner needs its credit hold, which b4m-core cannot import). Absent, that tool fails
 * with a clear error instead of running un-billed.
 */
export type ServerToolExecutor = (request: ToolExecutionRequest) => Promise<string>;
export type ServerToolExecutors = Partial<Record<'decide', ServerToolExecutor>>;

/**
 * Error categories for analytics and monitoring
 * Helps identify patterns in tool failures without changing user-facing behavior
 */
export enum ToolErrorType {
  /** Invalid or missing input parameters */
  INVALID_INPUT = 'INVALID_INPUT',
  /** API key not configured or invalid */
  API_KEY_MISSING = 'API_KEY_MISSING',
  /** External API returned an error */
  EXTERNAL_API_ERROR = 'EXTERNAL_API_ERROR',
  /** Rate limit exceeded (external service) */
  RATE_LIMIT = 'RATE_LIMIT',
  /** Network or connectivity issues */
  NETWORK_ERROR = 'NETWORK_ERROR',
  /** Unknown or unexpected error */
  UNKNOWN = 'UNKNOWN',
}

/**
 * Request to execute a tool server-side
 */
export interface ToolExecutionRequest {
  /** Name of the tool to execute */
  toolName: ServerToolName;
  /** Tool input matching Anthropic tool input schema */
  input: Record<string, unknown>;
  /** User ID for logging and rate limiting */
  userId: string;
}

/**
 * Result of a tool execution
 */
export interface ToolExecutionResult {
  /** Whether the tool executed successfully */
  success: boolean;
  /** Tool result content (if successful) */
  content?: unknown;
  /** Error message (if failed) */
  error?: string;
  /** Error category for analytics (if failed) */
  errorType?: ToolErrorType;
  /** Execution time in milliseconds */
  executionTimeMs?: number;
}

/**
 * Audit log entry for tool execution
 */
export interface ToolExecutionLog {
  /** User who executed the tool */
  userId: string;
  /** Tool that was executed */
  toolName: string;
  /** When the tool was executed */
  timestamp: Date;
  /** Whether the execution succeeded */
  success: boolean;
  /** Execution time in milliseconds */
  executionTimeMs: number;
  /** Error message (if failed) */
  error?: string;
  /** Error category for analytics (if failed) */
  errorType?: ToolErrorType;
}
