import type { ILogger } from '@bike4mind/observability';

/**
 * Failure statuses that mean GitHub no longer lets us reach the installation or repository:
 * an installation removed or suspended (404/403 on its access token), a repository deleted or
 * no longer granted to the App (404/403), or one GitHub reports gone (410). These are user-side
 * states the callers already handle, so they log at warn. A 403 that is really a rate limit is
 * still reported loudly by the caller's own rate-limit handling (see GitHubService).
 */
const ACCESS_LOSS_STATUSES: ReadonlySet<number> = new Set([403, 404, 410]);

// @octokit/plugin-request-log's failure line: "METHOD /path - STATUS with id REQUEST_ID in Nms".
const REQUEST_LOG_FAILURE = /^[A-Z]+ \S+ - (\d{3}) with id \S+ in \d+ms$/;

/** The HTTP status in a request-log failure line, or null for any other message. */
export function requestLogFailureStatus(message: string): number | null {
  const match = REQUEST_LOG_FAILURE.exec(message);
  return match ? Number(match[1]) : null;
}

export function isGitHubAccessLossStatus(status: number | null): boolean {
  return status !== null && ACCESS_LOSS_STATUSES.has(status);
}

export type OctokitLog = {
  debug: (message: string, ...additionalInfo: unknown[]) => void;
  info: (message: string, ...additionalInfo: unknown[]) => void;
  warn: (message: string, ...additionalInfo: unknown[]) => void;
  error: (message: string, ...additionalInfo: unknown[]) => void;
};

/**
 * The `log` option for an Octokit client. Without one, Octokit writes every failed request to
 * console.error, which the Lambda runtime tags ERROR and the log monitor turns into an alert
 * (infra/logMonitor.ts), even for an expected 404 the caller handles. Access-loss statuses go to
 * warn; 401, 429, 5xx, network failures and anything unrecognised stay at error.
 */
export function createOctokitLog(logger: ILogger): OctokitLog {
  return {
    // The request-log plugin emits a debug line per request and an info line per success.
    debug: () => {},
    info: () => {},
    warn: (message, ...additionalInfo) => logger.warn(`[Octokit] ${message}`, ...additionalInfo),
    error: (message, ...additionalInfo) => {
      const status = requestLogFailureStatus(message);
      if (isGitHubAccessLossStatus(status)) {
        logger.warn('[Octokit] GitHub request failed: installation or repository access lost', {
          status,
          request: message,
        });
        return;
      }
      logger.error(`[Octokit] ${message}`, ...additionalInfo);
    },
  };
}
