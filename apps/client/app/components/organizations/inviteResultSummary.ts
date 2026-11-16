import { getErrorMessage } from '@client/app/utils/error';

export interface InviteResultSummary {
  kind: 'success' | 'warning' | 'error';
  message: string;
}

/**
 * One toast for a multi-select invite, which sends one request per person: without it a partial
 * failure shows a toast per failed request. Repeated failure reasons are listed once.
 */
export function summarizeInviteResults(results: readonly PromiseSettledResult<unknown>[]): InviteResultSummary {
  const total = results.length;
  const reasons = [
    ...new Set(results.flatMap(result => (result.status === 'rejected' ? [getErrorMessage(result.reason)] : []))),
  ];
  const failed = results.filter(result => result.status === 'rejected').length;
  const sent = total - failed;
  const plural = (count: number) => (count === 1 ? 'invitation' : 'invitations');

  if (failed === 0) {
    return { kind: 'success', message: total === 1 ? 'Invitation sent' : `${total} invitations sent` };
  }
  const why = reasons.join('; ');
  if (sent === 0) {
    return {
      kind: 'error',
      message: total === 1 ? why : `None of the ${total} ${plural(total)} were sent. ${why}`,
    };
  }
  return { kind: 'warning', message: `${sent} of ${total} invitations sent; ${failed} failed. ${why}` };
}
