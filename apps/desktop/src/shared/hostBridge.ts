import type { HostError, HostNotification } from './hostProtocol';

/** The machine Desktop itself runs on, registered as a host like any other. */
export const LOCAL_HOST_ID = 'local';

/** One host request's answer as it crosses the renderer bridge. Errors travel as data: an error thrown across IPC keeps only its message. */
export type HostBridgeResponse = { ok: true; result: unknown } | { ok: false; error: HostError };

/** A host notification as it reaches a window, tagged with the host it came from. */
export type HostNotificationDelivery = { hostId: string; notification: HostNotification };

/**
 * The renderer's way to the hosts. Not a generic passthrough: main serves only the methods in
 * hostMethods, and checks each request's params against its method's schema before dispatch.
 */
export type HostBridgeApi = {
  request(hostId: string, method: string, params?: unknown): Promise<HostBridgeResponse>;
  onNotification(listener: (delivery: HostNotificationDelivery) => void): () => void;
};
