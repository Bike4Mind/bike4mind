import { toast } from 'sonner';
import type { AdminUsersBulkResult } from '@client/app/utils/adminUsersBulk';
import { useUndoToast } from '../../shared/UndoToast';
import { useAdminUsersBulkUndo } from './useAdminUsersBulk';

const plural = (count: number) => `${count.toLocaleString()} ${count === 1 ? 'user' : 'users'}`;
const domainList = (domains: readonly string[]) => domains.join(', ');

/** Shows the same outcome and recovery for direct and approved bulk actions. */
export function useUsersBulkResult() {
  const showUndoToast = useUndoToast();
  const undo = useAdminUsersBulkUndo();
  return (result: AdminUsersBulkResult, done = 'Updated') => {
    if (result.failed.length > 0) toast.warning(`${result.failed.length.toLocaleString()} users could not be changed.`);
    if (result.partial)
      toast.warning(
        `Stopped after ${plural(result.applied)}; ${plural(result.remaining)} not changed. Run it again for the rest.`
      );
    if (result.subscriptionCancelFailures.length > 0)
      toast.warning(
        `Could not cancel the Stripe subscriptions of ${plural(result.subscriptionCancelFailures.length)}. Cancel them in Stripe.`
      );
    const changed = result.applied > 0 || result.blockedDomains.length > 0;
    if (!changed) {
      toast.info('No users were changed.');
      return;
    }
    const message =
      `${done} ${plural(result.applied)}` +
      (result.blockedDomains.length > 0 ? `; blocked signups from ${result.blockedDomains.join(', ')}` : '') +
      (result.canceledSubscriptions > 0
        ? `; canceled ${result.canceledSubscriptions.toLocaleString()} Stripe subscription(s)`
        : '');
    // The server sets undoExpiresAt to no later than now when it could not store an undo record.
    if (Date.parse(result.undoExpiresAt) <= Date.now()) {
      toast.success(message);
      toast.warning('Undo is not available for this batch.');
      return;
    }
    showUndoToast({
      message,
      onUndo: async () => {
        const restored = await undo.mutateAsync(result.batchId);
        if (restored.stillBlockedDomains.length > 0)
          toast.warning(
            `Could not unblock ${domainList(restored.stillBlockedDomains)}. Remove them from the blocked email domains setting.`
          );
        if (restored.partial)
          toast.warning(
            `${plural(restored.remaining)} not restored before the time limit. Check them on their profiles.`
          );
        if (restored.subscriptionsNotRestored.length > 0)
          toast.warning(
            `${restored.subscriptionsNotRestored.length.toLocaleString()} canceled Stripe subscription(s) stay canceled; the users must subscribe again.`
          );
        if (restored.failed.length > 0)
          toast.warning(`${restored.failed.length.toLocaleString()} users could not be restored.`);
        else toast.success(`Restored ${plural(restored.restored)}`);
      },
    });
  };
}
