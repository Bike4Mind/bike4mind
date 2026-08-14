import { api } from '@client/app/contexts/ApiContext';
import { useMutation } from '@tanstack/react-query';
import type {
  BucketSpecValidationError,
  GenerateReportResponse,
  ParsedIdentityMapError,
  SendReportResponse,
} from '@bike4mind/services';

/**
 * PR report generator - client data hooks.
 *
 * Two INDEPENDENT mutations, deliberately not chained. Generate returns editable text;
 * a human reviews and edits it; send posts what they approved. Collapsing these into
 * one call would remove the only checkpoint between a classifier mistake and a
 * channel-wide ping.
 */

export interface GenerateReportResult extends GenerateReportResponse {
  /** Line-numbered identity-map parse problems, for display beside the report. */
  identityMapErrors: ParsedIdentityMapError[];
  /**
   * Non-blocking roster advisories: buckets whose role key has no identity-map entry,
   * so the pool will not be @-mentioned. The digest still generates.
   */
  rosterWarnings: BucketSpecValidationError[];
}

export function useGeneratePrReport() {
  return useMutation({
    mutationFn: async (): Promise<GenerateReportResult> => {
      const { data } = await api.post<GenerateReportResult>('/api/admin/pr-report/generate', {});
      return data;
    },
  });
}

export interface SendPrReportInput {
  text: string;
  /**
   * REQUIRED by the client contract even though the server treats it as optional.
   *
   * Without a key the server falls back to hashing (text, repo), and that fallback has
   * no escape from a held reservation: the key is a function of the text, so every
   * resubmit of the same digest returns `deliveryUnknown` until the window lapses. With
   * a key, a human who has checked the channel can deliberately re-send under a fresh
   * one.
   */
  idempotencyKey: string;
}

export function useSendPrReport() {
  return useMutation({
    mutationFn: async ({ text, idempotencyKey }: SendPrReportInput): Promise<SendReportResponse> => {
      const { data } = await api.post<SendReportResponse>('/api/admin/pr-report/send', {
        text,
        idempotencyKey,
      });
      return data;
    },
  });
}
