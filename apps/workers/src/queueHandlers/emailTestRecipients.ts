/**
 * Normalize (trim + lowercase) and order-preservingly dedupe a test-recipient
 * list. Defensive at the queue/job-payload boundary: the emailJobOrchestrator
 * handler accepts testRecipients directly from its SQS payload, so a caller that
 * enqueues a job without going through the UI could still pass duplicates.
 */
export function dedupeTestRecipients(list: string[]): string[] {
  const seen = new Set<string>();
  return list.map(e => e.trim().toLowerCase()).filter(e => e.length > 0 && !seen.has(e) && seen.add(e));
}
