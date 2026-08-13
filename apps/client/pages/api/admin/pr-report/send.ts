/**
 * POST /api/admin/pr-report/send
 *
 * Phase two: post the FINAL, human-edited text to the configured Slack channel.
 *
 * Admin-gated, body-validated, audited and deduped. Note the accepted consequence of
 * putting a human in the loop: because the admin edits the text and this request
 * carries only that text - with no reference back to a specific generate call - this
 * is an authenticated, admin-gated arbitrary-text-to-shared-channel endpoint. It
 * cannot verify the text came from a real generate. That is a considered trade-off
 * (editing is the point), and the mitigations are exactly the ones applied here:
 * admin gating, body validation, acting-identity audit logging, and send dedupe.
 */

import { Request } from 'express';
import { z } from 'zod';

import { baseApi } from '@client/server/middlewares/baseApi';
import { prReportService } from '@bike4mind/services';
import { ForbiddenError } from '@bike4mind/utils';

import { createSendDeps, loadPrReportConfig } from '@server/services/prReport/context';

const sendBodySchema = z.object({
  text: z.string(),
  /**
   * Preferred over the (text, repo) hash fallback: it identifies THIS submit attempt,
   * so it distinguishes a client retry from a deliberate identical re-send. The client
   * must mint a FRESH key when a human deliberately re-sends after a
   * `deliveryUnknown`, or the held reservation will absorb it for the whole TTL.
   */
  idempotencyKey: z.string().min(1).max(200).optional(),
});

type SendBody = z.infer<typeof sendBodySchema>;

const handler = baseApi().post<Request<{}, {}, SendBody>>(async (req, res) => {
  if (!req.user?.isAdmin) {
    throw new ForbiddenError('Admin access required');
  }

  const parsedBody = sendBodySchema.safeParse(req.body);
  if (!parsedBody.success) {
    return res.status(400).json({ kind: 'invalidRequest', reason: 'text is required' });
  }

  const config = await loadPrReportConfig();

  const outcome = await prReportService.sendReport(
    {
      text: parsedBody.data.text,
      repo: config.repo,
      destination: config.destination,
      idempotencyKey: parsedBody.data.idempotencyKey,
    },
    createSendDeps(req.logger, config)
  );

  // Acting-identity audit, on every terminal outcome. Records WHO asked for a post to
  // a shared channel and what came back - never the text, never the credential.
  //
  // Deliberately a structured logger line rather than logAuditEvent(): that path keys
  // on a registered analytics event union, and adding a family for this would mean
  // touching the analytics payload registry. Worth revisiting if this endpoint gains a
  // compliance requirement.
  req.logger.info('[PrReport] send attempted', {
    audit: true,
    actingUserId: req.user?.id ?? null,
    actingUserEmail: req.user?.email ?? null,
    repo: config.repo,
    channel: config.destination?.channel ?? null,
    textLength: parsedBody.data.text.length,
    hadIdempotencyKey: !!parsedBody.data.idempotencyKey,
    result: outcome.ok ? outcome.response.outcome : `failed:${outcome.failure.kind}`,
  });

  if (outcome.ok) {
    // All three are successful REQUESTS. 'deliveryUnknown' in particular is not an
    // error: it reports an uncertain delivery, and the client must surface it as
    // "check the channel before retrying" rather than enabling a retry.
    return res.status(200).json(outcome.response);
  }

  switch (outcome.failure.kind) {
    case 'invalidRequest':
      return res.status(400).json(outcome.failure);

    case 'targetRejected':
      // A settings problem, not a problem with the admin's text. Its reason names the
      // failed check and contains no part of the destination.
      return res.status(400).json(outcome.failure);

    case 'dedupeUnavailable':
      // Send fails CLOSED on the store: nothing was posted. 503 because it is a
      // transient infrastructure state the admin should retry once it clears.
      return res.status(503).json({
        ...outcome.failure,
        reason:
          'The send de-duplication store could not confirm the request, so nothing was posted. Retry shortly; a retry inside the next few minutes may report an uncertain delivery until the window clears.',
      });

    case 'notDelivered':
      // Slack did not accept the post and the reservation was released, so a retry is
      // safe and necessary. The provider's reason was logged server-side; this arm
      // carries no `reason` field at all, because a field here is the one line that
      // would leak a bearer-equivalent credential to the browser.
      return res.status(502).json({ kind: 'notDelivered' });
  }
});

export default handler;
