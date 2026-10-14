import { isAxiosError, type AxiosInstance, type InternalAxiosRequestConfig } from 'axios';
import { useAccessToken } from '@client/app/hooks/useAccessToken';
import { useStepUpStore } from '@client/app/stores/useStepUpStore';

type StepUpRetryConfig = InternalAxiosRequestConfig & { _stepUpRetried?: boolean };

const STEP_UP_ROUTE_PREFIX = '/api/auth/step-up';

/** Set on the rejected error when the user dismissed the verification prompt. */
const STEP_UP_CANCELLED = Symbol('stepUpCancelled');

/**
 * True when a request failed only because the user cancelled the verification prompt: the call
 * site should stay silent rather than report an error the user chose.
 */
export const isStepUpCancelled = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && STEP_UP_CANCELLED in error;

const isStepUpRequired = (error: unknown): boolean =>
  isAxiosError(error) &&
  error.response?.status === 403 &&
  (error.response.data as { code?: unknown } | undefined)?.code === 'step_up_required';

/**
 * On a 403 `step_up_required`, prompts for verification (one shared prompt for concurrent
 * requests) and replays the request once. If the user cancels, the original error is rejected.
 * Registered after the 401 refresh interceptor; the two never match the same response.
 */
export function registerStepUpInterceptor(client: AxiosInstance): void {
  client.interceptors.response.use(
    response => response,
    async (error: unknown) => {
      if (!isStepUpRequired(error) || !isAxiosError(error)) return Promise.reject(error);

      const config = error.config as StepUpRetryConfig | undefined;
      if (!config || config._stepUpRetried) return Promise.reject(error);
      if (config.url?.includes(STEP_UP_ROUTE_PREFIX)) return Promise.reject(error);
      // An mfaPending sign-in token never reaches gated routes, and could not step up if it did.
      const { accessToken, mfaPending } = useAccessToken.getState();
      if (!accessToken || mfaPending) return Promise.reject(error);

      try {
        await useStepUpStore.getState().requestStepUp();
      } catch {
        Object.defineProperty(error, STEP_UP_CANCELLED, { value: true });
        return Promise.reject(error);
      }

      config._stepUpRetried = true;
      return client.request(config);
    }
  );
}
