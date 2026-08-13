/**
 * PR report generator - degradation counters.
 *
 * Every degradation this capability tolerates is silent by construction: the report
 * still generates, still looks normal, and still posts. A one-off log line is not
 * enough, because what matters is whether a degradation is SUSTAINED - and that is
 * only visible as a count over time.
 *
 * Each event is emitted as a single structured line with a stable `metric` field, so a
 * CloudWatch metric filter can turn it into a countable series and alarm on it. The
 * alerting shapes the blueprint asks for:
 *
 *   - approvalDataUnavailable      alarm on SUSTAINED failure (every report is then
 *                                  missing its approved-awaiting-author routing)
 *   - openPrListTruncated          alarm on CONSECUTIVE runs - one truncated digest is
 *                                  a busy day, a run of them means the page bound sits
 *                                  permanently below the repo's steady state and the
 *                                  digest is permanently dropping the oldest,
 *                                  most-stuck PRs
 *   - deliveryUnknown              alarm on ANY occurrence: this is the one state
 *                                  meaning a post to a shared channel may or may not
 *                                  have landed, and it always needs a human to
 *                                  reconcile the channel by hand
 *   - dedupeReserveUnavailable     alarm on any run - sending is BLOCKED, which looks
 *                                  to admins like a broken button
 *   - dedupeWriteFailed            the insidious one: it leaves stale reservations that
 *                                  make later legitimate sends return deliveryUnknown
 *                                  for a full TTL, so a run of these explains a run of
 *                                  check-the-channel advisories nothing else accounts for
 */

import type { Logger } from '@bike4mind/observability';
import type { PrReportMetricName, PrReportMetrics } from '@bike4mind/services';

export function createPrReportMetrics(logger: Logger): PrReportMetrics {
  return {
    increment(name: PrReportMetricName, detail?: Record<string, string | number | boolean | null>) {
      // `metric` and `value` are the fields a metric filter keys on; `detail` carries
      // the non-sensitive context (retry advice, counts, cause) that makes an alarm
      // actionable. No credential or full URL is ever passed in here.
      logger.warn('[PrReport] degradation', { metric: name, value: 1, ...detail });
    },
  };
}
