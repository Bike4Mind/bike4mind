// Shared by every generation job kind (video, music, ...). Defined in common because the job payload persists them.

/** Opaque to everything but its adapter; persisted on the job as JSON. Re-exported by @bike4mind/utils/generationProviders. */
export type GenerationProviderJobHandle<TProviderId extends string = string> = {
  provider: TProviderId;
  data: Record<string, unknown>;
};

export type ProviderOutput =
  | { kind: 'inline'; base64: string; contentType: string }
  | { kind: 'url'; url: string; requiresAuth: boolean; contentType?: string };

// Whether a succeeded job's output can be downloaded now, later, or never: the one field that tells a client
// whether to keep re-reading the job for a url. Must stay in sync with signOutputUrl in apps/client.
export const GENERATION_OUTPUT_AVAILABILITIES = ['ready', 'pending_scan', 'unavailable'] as const;
export type GenerationOutputAvailability = (typeof GENERATION_OUTPUT_AVAILABILITIES)[number];

/**
 * How Studio introduces a model on its card: a one-line strength and the provider's display name. The data lives in
 * {image,video,music}/profiles.ts; the v1 model lists publish it as `blurb` / `provider_label`.
 */
export type ModelProfile = { blurb: string; providerLabel: string };
