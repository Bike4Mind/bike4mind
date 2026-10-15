import { sanitizeTelemetryError, type ToolErrorCategory, type ToolTelemetry } from '@bike4mind/common';
import { categorizeToolError } from './TelemetryBuilder';

/** One recorded tool call, as persisted on promptMeta.functionCalls. */
interface ToolInvocation {
  name?: string;
  success?: boolean;
}

/** Per-tool health from ToolValidator.getAllToolsHealth. */
interface ToolHealth {
  available: boolean;
  failureCount: number;
  lastError?: string;
}

function emptyEntry(toolName: string): ToolTelemetry {
  return {
    toolName,
    isMcpTool: toolName.includes(':') || toolName.startsWith('mcp_'),
    mcpServerName: toolName.includes(':') ? toolName.split(':')[0] : undefined,
    invocationCount: 0,
    successCount: 0,
    failureCount: 0,
    totalDurationMs: 0, // Not tracked per-call yet
    maxDurationMs: 0,
    retryCount: 0,
  };
}

/**
 * Per-tool invocation telemetry for a turn. A call counts as failed when its recorded `success` is
 * false (the adapters set it when a tool throws); a call with no recorded outcome counts as a
 * success. Validator health can raise the failure count but never lowers it.
 */
export function buildToolInvocationTelemetry(
  functionCalls: readonly ToolInvocation[],
  toolHealth: ReadonlyMap<string, ToolHealth>
): Map<string, ToolTelemetry> {
  const telemetry = new Map<string, ToolTelemetry>();

  for (const fc of functionCalls) {
    const toolName = fc.name ?? 'unknown';
    const entry = telemetry.get(toolName) ?? emptyEntry(toolName);
    entry.invocationCount++;
    if (fc.success === false) entry.failureCount++;
    else entry.successCount++;
    telemetry.set(toolName, entry);
  }

  for (const [toolName, health] of toolHealth) {
    const existing = telemetry.get(toolName);
    const errorCategories: ToolErrorCategory[] | undefined = health.lastError
      ? [categorizeToolError(health.lastError)]
      : undefined;
    const lastError = health.lastError ? sanitizeTelemetryError(health.lastError, 200) : undefined;
    if (existing) {
      existing.failureCount = Math.max(existing.failureCount, health.failureCount);
      if (!health.available) {
        existing.successCount = Math.max(0, existing.invocationCount - existing.failureCount);
      }
      if (lastError) {
        existing.lastError = lastError;
        existing.errorCategories = errorCategories;
      }
    } else if (health.failureCount > 0) {
      // Tool failed without successful invocation
      telemetry.set(toolName, {
        ...emptyEntry(toolName),
        invocationCount: health.failureCount,
        failureCount: health.failureCount,
        lastError,
        errorCategories,
      });
    }
  }

  return telemetry;
}
