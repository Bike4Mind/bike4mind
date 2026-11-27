import type { HostBridgeApi } from '@shared/hostBridge';
import {
  HOST_ERROR_CODES,
  HostRequestError,
  hostMethods,
  hostNotifications,
  isHostNotificationName,
  type HostMethod,
  type HostNotificationName,
  type HostNotificationParams,
  type HostParams,
  type HostResult,
} from '@shared/hostProtocol';

/** A session as this layer names it: session ids are unique only within their host. */
export type HostSessionRef = { hostId: string; sessionId: string };

/** Methods whose params the protocol lets a caller leave out take them as an optional argument. */
type ParamsArgument<M extends HostMethod> =
  undefined extends HostParams<M> ? [params?: HostParams<M>] : [params: HostParams<M>];

export type HostNotificationListener<N extends HostNotificationName> = (
  params: HostNotificationParams<N>,
  hostId: string
) => void;

export type HostClient = {
  /** Rejects with HostRequestError when the host, or main on its behalf, answers with an error. */
  request<M extends HostMethod>(hostId: string, method: M, ...params: ParamsArgument<M>): Promise<HostResult<M>>;
  /** `listener` hears `name` from every host; a notification whose params break the protocol is reported and dropped. */
  onNotification<N extends HostNotificationName>(name: N, listener: HostNotificationListener<N>): () => void;
};

/** `bridge` is read per call, so a test can stub `window.b4m` after this module loads. */
export function createHostClient(
  bridge: () => HostBridgeApi,
  reportError: (message: string, detail: unknown) => void = (message, detail) => console.warn(message, detail)
): HostClient {
  return {
    async request(hostId, method, ...[params]) {
      const response = await bridge().request(hostId, method, params);
      if (!response.ok) throw new HostRequestError(response.error);
      const result = hostMethods[method].result.safeParse(response.result);
      if (!result.success) {
        throw new HostRequestError({
          code: HOST_ERROR_CODES.internalError,
          message: `Host ${hostId} answered ${method} outside the protocol`,
          data: result.error.issues,
        });
      }
      return result.data as HostResult<typeof method>;
    },
    onNotification(name, listener) {
      return bridge().onNotification(({ hostId, notification }) => {
        if (notification.method !== name || !isHostNotificationName(notification.method)) return;
        const params = hostNotifications[name].params.safeParse(notification.params);
        if (!params.success) {
          reportError(`Host ${hostId} sent ${name} outside the protocol`, params.error.issues);
          return;
        }
        listener(params.data as HostNotificationParams<typeof name>, hostId);
      });
    },
  };
}

export const hostClient = createHostClient(() => window.b4m.host);
