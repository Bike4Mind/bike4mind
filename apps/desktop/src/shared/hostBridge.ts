import type { HostError, HostNotification } from './hostProtocol';

/** The machine Desktop itself runs on, registered as a host like any other. */
export const LOCAL_HOST_ID = 'local';

/** One host request's answer as it crosses the renderer bridge. Errors travel as data: an error thrown across IPC keeps only its message. */
export type HostBridgeResponse = { ok: true; result: unknown } | { ok: false; error: HostError };

/** A host notification as it reaches a window, tagged with the host it came from. */
export type HostNotificationDelivery = { hostId: string; notification: HostNotification };
