import { Resource } from 'sst';

/**
 * Base URL for the always-on ChatCompletion service, resolved per stage.
 *
 * prod/dev/self-host expose it behind an ALB (`.url`, e.g. http://<alb-dns>, or
 * http://chatcompletion:8080 in self-host via the @bike4mind/resource shim). Preview stages
 * have no ALB and register in Cloud Map, exposing only a hostname via `.service`; the
 * container listens on 8080. Prefer the ALB url, fall back to the Cloud Map host. Exactly one
 * is defined per stage.
 *
 * Cast: SST generates the Resource type per-stage from live link outputs and omits properties
 * that are undefined at generation time, so the committed sst-env.d.ts carries only whichever
 * of url/service the last generating stage had. Both are present in the link shape at runtime,
 * so read them defensively.
 *
 * Callers append their path (`/process`, `/health`).
 */
export function chatCompletionBaseUrl(): string {
  const svc = Resource.ChatCompletion as { url?: string; service?: string };
  if (svc.url) return svc.url;
  if (svc.service) return `http://${svc.service}:8080`;
  // Neither present = a misconfigured stage (e.g. a preview deployed without
  // CLOUDMAP_NAMESPACE_ID/NAME, so SST attached no namespace and dropped serviceRegistry).
  // Throw loudly instead of building `http://undefined:8080` and failing opaquely downstream.
  throw new Error(
    'ChatCompletion exposes neither an ALB url nor a Cloud Map service host — the stage is misconfigured.'
  );
}
