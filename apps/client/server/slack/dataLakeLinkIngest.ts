import { FabFileSourceType, type IFabFileDocument } from '@bike4mind/common';
import { BadRequestError } from '@bike4mind/utils';
import {
  authorizeLakeForWrite,
  refuseMockActor,
  resolveLakeTags,
  type LakeAuthzDeps,
  type LakeWriteRefusalReason,
  type SlackIngestActor,
} from './dataLakeIngestAuthz';

/**
 * LINK ingest for `@datalake add` (M3).
 *
 * Shares its entire authorize-first prologue with the FILE path via `dataLakeIngestAuthz.ts`, so
 * the two cannot drift: same gate, same status rule, same meta-tag check, same class-based refusal
 * mapping. Only what happens AFTER authorization differs - the bytes come from an HTTP fetch rather
 * than from Slack.
 *
 * The fetch itself is `fabFilesService.createFabFileByUrl`, which already does
 * fetchAndParseURL -> createFabFile; this path supplies the lake tag and the provenance stamp as
 * server-side adapters. SSRF is enforced inside `fetchAndParseURL` (`validateUrlForFetch` on every
 * redirect hop, not just the URL the user pasted), which matters more here than anywhere else in
 * the app: these URLs arrive from whoever can type in a Slack channel.
 *
 * KNOWN GAP - no dedup. The FILE path hashes the downloaded buffer and checks
 * `findByContentHashesInDataLake`, but here the fetch happens INSIDE the service, so there are no
 * bytes to hash before the row exists. Re-adding the same link therefore adds a second copy. Not
 * worked around by hashing the URL instead: the same URL legitimately yields different content over
 * time, so a URL match is not a content match and would refuse honest re-adds of updated pages.
 */

/** Parameters for `fabFilesService.createFabFileByUrl`, narrowed to what this path supplies. */
export interface CreateLakeLinkParams {
  url: string;
  tags: Array<{ name: string; strength: number }>;
  provenance: { sourceType: FabFileSourceType; sourceMetadata: Record<string, unknown> };
  /**
   * Forwarded to `createFabFile`'s own tag gate, which `createFabFileByUrl` relays
   * (`createByUrl.ts:108`). Same requirement and same reason as the FILE path's field - see
   * `CreateLakeFileParams.administeredOrgIds`. Declared here too rather than on one path only,
   * because FILE and LINK must not diverge on who is allowed to write.
   */
  administeredOrgIds: string[];
}

export interface SlackLinkIngestDeps extends LakeAuthzDeps {
  /** Bound to `fabFilesService.createFabFileByUrl` by the caller so this module stays wiring-free. */
  createLakeFileFromUrl(userId: string, params: CreateLakeLinkParams): Promise<IFabFileDocument>;
}

export interface SlackLinkIngestParams {
  actor: SlackIngestActor;
  lakeSlug: string;
  link: string;
  /** Slack origin recorded on the created file so a lake editor can audit where it came from. */
  channel: string;
  messageTs: string;
}

export type SlackLinkIngestRefusal = LakeWriteRefusalReason | 'no_link' | 'link_rejected' | 'link_fetch_failed';

export type SlackLinkIngestOutcome =
  | { ok: true; lakeName: string; fileName: string; sourceUrl: string }
  | { ok: false; reason: SlackLinkIngestRefusal; message: string };

/**
 * Drop any embedded credentials before a URL is logged or persisted. `https://user:pass@host/doc`
 * is a valid thing to paste in Slack, and both destinations outlive the message: the log, and the
 * FabFile's `sourceMetadata` where every editor of the lake can read it. The FETCH still uses the
 * original URL - only what we record is redacted.
 */
function sanitizeUrlForRecord(raw: string): string {
  try {
    const parsed = new URL(raw);
    if (!parsed.username && !parsed.password) return raw;
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    // Unparseable by URL despite passing the scheme check - record nothing rather than guess.
    return '[unparseable url]';
  }
}

export async function ingestSlackLinkIntoLake(
  params: SlackLinkIngestParams,
  deps: SlackLinkIngestDeps
): Promise<SlackLinkIngestOutcome> {
  const { actor, lakeSlug, link, channel, messageTs } = params;

  const mockRefusal = refuseMockActor(actor, lakeSlug, deps);
  if (mockRefusal) return mockRefusal;

  // Mirrors the FILE path's no-attachments refusal, and placed in the same position (before
  // authorization) for the same reason: there is nothing to authorize against yet.
  if (!link) {
    return {
      ok: false,
      reason: 'no_link',
      message: 'Include a link in your message to add it to a data lake.',
    };
  }

  // The parser only ever matches `https?://`, so this is defense in depth rather than the primary
  // check - it exists so a future grammar change cannot quietly hand a `file://` or `gopher://` URL
  // to the fetcher. The SSRF guard rejects non-HTTP(S) schemes too; failing here keeps the refusal
  // a clean user-facing message instead of a generic fetch failure.
  if (!/^https?:\/\//i.test(link)) {
    return {
      ok: false,
      reason: 'link_rejected',
      message: 'Only `http` and `https` links can be added to a data lake.',
    };
  }

  // Authorization first: resolve + write-gate the lake before anything is fetched.
  const authorized = await authorizeLakeForWrite(actor, lakeSlug, deps);
  if (!authorized.ok) return authorized;
  const { lake, datalakeTag, ctx } = authorized;

  const tags = await resolveLakeTags(datalakeTag, deps);
  const recordedUrl = sanitizeUrlForRecord(link);

  try {
    const fabFile = await deps.createLakeFileFromUrl(actor.id, {
      url: link,
      tags,
      provenance: {
        sourceType: FabFileSourceType.SLACK,
        // `sourceUrl` alongside the Slack origin: for a link the message is where it was ASKED for
        // and the URL is where the content actually came from, and an auditor needs both.
        sourceMetadata: { channel, messageTs, sourceUrl: recordedUrl },
      },
      administeredOrgIds: ctx.administeredOrgIds ?? [],
    });

    return { ok: true, lakeName: lake.name, fileName: fabFile.fileName, sourceUrl: recordedUrl };
  } catch (err) {
    // Split on error CLASS, as everywhere else on this path, and deliberately NOT on the message.
    //
    // A BadRequestError here is createFabFile's own content-level validation (unsupported type,
    // over MaxFileSize), which is safe and useful to repeat back to the user.
    //
    // Anything else - a network failure, a parse failure, or an SSRF refusal - gets ONE fixed
    // sentence, and the detail is logged server-side only. That is a security requirement, not
    // tidiness: `validateUrlForFetch` reports "Hostname resolves to private IP address (10.1.2.3)",
    // so echoing it back would turn `@datalake add` into an internal-network scanner for anyone who
    // can type in Slack - they could map private space by reading our own error messages.
    if (err instanceof BadRequestError) {
      deps.logger.info('@datalake add refused a link by content validation', { lakeSlug, message: err.message });
      return {
        ok: false,
        reason: 'link_rejected',
        message: `Could not add that link: ${err.message}`,
      };
    }

    deps.logger.error('Failed to ingest a link into a data lake', {
      lakeSlug,
      // Logged (credential-stripped), not surfaced, so an operator can still diagnose it.
      sourceUrl: recordedUrl,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      ok: false,
      reason: 'link_fetch_failed',
      message: 'Could not fetch that link. Check it opens publicly, or attach the file to your message instead.',
    };
  }
}
