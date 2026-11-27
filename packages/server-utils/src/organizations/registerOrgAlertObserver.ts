import { setOrgEventObserver } from '@bike4mind/services/organizationService/orgEventObserver';

let registered = false;

/**
 * Idempotent; safe to call from every lambda entry family. The dispatcher is imported on the first
 * event so baseApi, which runs this on every route, does not load the database and event bus with it.
 */
export function registerOrgAlertObserver(): void {
  if (registered) return;
  registered = true;
  try {
    setOrgEventObserver(async event => {
      const { handleOrgEvent } = await import('./orgAlertDispatcher');
      await handleOrgEvent(event);
    });
  } catch {
    // a partially-mocked services module throws on the missing export; alerts just stay off
  }
}
