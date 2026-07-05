/**
 * SRE Workflow Callback Endpoint
 *
 * Receives POST callbacks from the sre-autofix GitHub Actions workflow.
 * Updates SreErrorTracking with success/failure status.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import crypto from 'crypto';
import {
  connectDB,
  sreErrorTrackingRepository,
  sreErrorPatternRepository,
  adminSettingsRepository,
} from '@bike4mind/database';
import {
  SreAgentConfigSchema,
  resolveCallbackToken,
  resolveFullConfig,
  SRE_DEFAULT_REPO_SLUG,
} from '@bike4mind/common';
import { Config } from '@server/utils/config';
import { Logger } from '@bike4mind/observability';
import { decryptSecret } from '@server/security/secretEncryption';
import {
  postSreFixSuccessMessage,
  postSreFixFailureMessage,
  postSreAlreadyFixedMessage,
  postSreCiRetryMessage,
} from '@server/integrations/slack/sreSlackApproval';
import { sendToQueue } from '@server/utils/sqs';
import { getSourceQueueUrl } from '@server/utils/dlqRegistry';
import type { SreRevisionRequest, SreJobType } from '@bike4mind/common';
import { SreSourceType } from '@bike4mind/common';
import { GitHubService } from '@server/services/githubService';

/** HTML marker so the CI-retry-exhausted escalation comment is posted at most once per PR/issue.
 *  (Mirrors SRE_SELFHEAL_ESCALATION_MARKER in sreRevision.ts; kept per-file since each owns its marker.) */
const SRE_CI_RETRY_EXHAUSTED_MARKER = '<!-- sre-ci-retry-exhausted -->';

function serializeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  return { message: String(err) };
}

const CallbackSchema = z.object({
  fingerprint: z.string(),
  trackingId: z.string(),
  repoSlug: z
    .string()
    .regex(/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/)
    .optional(),
  status: z.enum(['success', 'failure', 'already_fixed']),
  prNumber: z.number().optional(),
  prUrl: z.string().url().optional(),
  workflowRunUrl: z
    .string()
    .url()
    .refine(url => /^https:\/\/github\.com\/[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+\/actions\/runs\/\d+$/.test(url), {
      message: 'workflowRunUrl must be a GitHub Actions run URL',
    })
    .optional(),
  failureReason: z.string().optional(),
  failureOutput: z.string().max(3000).optional(),
  recoverable: z.boolean().optional(),
});

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const logger = new Logger();

  try {
    // Connect first - need DB to load callback token from admin config
    await connectDB(Config.MONGODB_URI.replace('%STAGE%', Config.STAGE), logger);

    // Validate callback token from admin config (encrypted at rest in MongoDB).
    // Parse body first to extract repoSlug for per-repo token resolution.
    const authHeader = req.headers.authorization;
    const rawConfig = await adminSettingsRepository.getSettingsValue('sreAgentConfig');
    const sreConfig = SreAgentConfigSchema.parse(rawConfig ?? {});

    // Resolve per-repo callback token
    const bodyRepoSlug = req.body?.repoSlug as string | undefined;
    const encryptedToken = resolveCallbackToken(sreConfig, bodyRepoSlug ?? SRE_DEFAULT_REPO_SLUG);

    if (!encryptedToken) {
      logger.warn('[SRE-CALLBACK] No callback token configured', { repoSlug: bodyRepoSlug });
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const encryptionKey = Config.SECRET_ENCRYPTION_KEY;
    if (!encryptionKey) {
      logger.error('[SRE-CALLBACK] SECRET_ENCRYPTION_KEY not configured');
      return res.status(500).json({ error: 'Server configuration error' });
    }

    let expectedToken: string;
    try {
      expectedToken = decryptSecret(encryptedToken, encryptionKey);
    } catch (decryptError) {
      logger.error('[SRE-CALLBACK] Failed to decrypt callback token', { error: serializeError(decryptError) });
      return res.status(500).json({ error: 'Server configuration error' });
    }

    const receivedToken = authHeader?.replace(/^Bearer\s+/, '') ?? '';

    // Timing-safe comparison to prevent timing attacks
    const tokensMatch =
      expectedToken.length === receivedToken.length &&
      crypto.timingSafeEqual(Buffer.from(expectedToken), Buffer.from(receivedToken));
    if (!tokensMatch) {
      logger.warn('[SRE-CALLBACK] Unauthorized callback attempt');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const body = CallbackSchema.parse(req.body);

    // Resolve per-repo config for Slack notifications
    const callbackRepoSlug = body.repoSlug ?? SRE_DEFAULT_REPO_SLUG;
    const repoConfig = resolveFullConfig(sreConfig, callbackRepoSlug);
    if (!repoConfig) {
      logger.warn('[SRE-CALLBACK] Repo not configured, cannot process callback', { repoSlug: callbackRepoSlug });
      return res.status(404).json({ error: 'Repo not configured' });
    }

    logger.info('[SRE-CALLBACK] Processing workflow callback', {
      trackingId: body.trackingId,
      status: body.status,
    });

    if (body.status === 'success') {
      // prNumber and prUrl are required for success callbacks - the workflow always sends them.
      // Guard here to protect Slack output and give the workflow a clear error to debug against.
      // Note: prNumber=0 (CI-retry fresh-branch sentinel) never reaches the success path here -
      // fresh-branch CI retries dispatch through the original autofix workflow which always creates
      // a real PR (prNumber > 0) before calling back. The !body.prNumber check catching 0 is
      // dead-code protection against any future code path that might inadvertently send 0.
      if (!body.prNumber || !body.prUrl) {
        logger.error('[SRE-CALLBACK] Success callback missing prNumber or prUrl', { trackingId: body.trackingId });
        return res.status(400).json({ error: 'prNumber and prUrl are required for success callbacks' });
      }

      // Idempotent: atomicTransition only succeeds if status is still 'fixing'.
      // Duplicate callbacks (GitHub retry) get null and return 200 to stop retry chain.
      const transitioned = await sreErrorTrackingRepository.atomicTransition(body.trackingId, 'fixing', 'fixed', {
        fixPrNumber: body.prNumber,
        workflowRunUrl: body.workflowRunUrl,
      });
      if (!transitioned) {
        logger.info('[SRE-CALLBACK] Already processed (idempotent skip)', { trackingId: body.trackingId });
        return res.status(200).json({ ok: true, duplicate: true });
      }

      // Store successful fix in pattern library for future reuse.
      // Only cache patterns with confidence >= 70 to prevent low-quality entries.
      // Uses transitioned doc directly - no extra findById needed.
      try {
        if (transitioned.diagnosisResult && transitioned.diagnosisResult.confidence >= 70) {
          const errorType = transitioned.errorMessage?.split(':')[0]?.trim() || 'Unknown';
          await sreErrorPatternRepository.upsertFromFix(body.fingerprint, transitioned.repoSlug, {
            name: `${errorType} in ${transitioned.diagnosisResult.affectedFiles[0]?.filePath || 'unknown'}`,
            errorMessage: transitioned.errorMessage || '',
            diagnosis: transitioned.diagnosisResult,
            originTrackingId: body.trackingId,
            originPrNumber: body.prNumber,
          });
          logger.info('[SRE-CALLBACK] Stored fix in pattern library', {
            fingerprint: body.fingerprint,
            confidence: transitioned.diagnosisResult.confidence,
          });
        } else if (transitioned.diagnosisResult) {
          logger.info('[SRE-CALLBACK] Skipping pattern storage — confidence too low', {
            fingerprint: body.fingerprint,
            confidence: transitioned.diagnosisResult.confidence,
          });
        }
      } catch (patternError) {
        logger.error('[SRE-CALLBACK] Failed to store pattern (non-fatal)', { error: serializeError(patternError) });
      }

      try {
        await postSreFixSuccessMessage(
          body.trackingId,
          body.fingerprint,
          transitioned.errorMessage || '',
          body.prNumber,
          body.prUrl,
          body.workflowRunUrl || '',
          repoConfig.slack ?? {}
        );
      } catch (slackError) {
        logger.error('[SRE-CALLBACK] Failed to send Slack success notification (non-fatal)', {
          error: serializeError(slackError),
        });
      }
    } else if (body.status === 'already_fixed') {
      const transitioned = await sreErrorTrackingRepository.atomicTransition(
        body.trackingId,
        'fixing',
        'already_fixed',
        {
          workflowRunUrl: body.workflowRunUrl,
          // Intentionally NOT overwriting errorMessage - preserve the original production error
          // so Slack/GH notifications display what actually broke, not a static description.
        }
      );
      if (!transitioned) {
        logger.info('[SRE-CALLBACK] Already processed (idempotent skip)', { trackingId: body.trackingId });
        return res.status(200).json({ ok: true, duplicate: true });
      }

      // Slack notification (non-fatal)
      try {
        await postSreAlreadyFixedMessage(
          body.trackingId,
          transitioned.errorMessage || '',
          body.fingerprint,
          transitioned.githubIssueNumber,
          callbackRepoSlug,
          body.workflowRunUrl || '',
          repoConfig.slack ?? {}
        );
      } catch (slackError) {
        logger.error('[SRE-CALLBACK] Failed to send already-fixed Slack notification (non-fatal)', {
          error: serializeError(slackError),
        });
      }

      // GH issue comment (non-fatal, deduplicated by marker).
      // TOCTOU note: concurrent callbacks could both pass hasCommentWithMarker before either posts,
      // resulting in a duplicate comment. Blast radius is cosmetic only - atomicTransition above
      // prevents duplicate state transitions. Duplicates are cosmetic and do not affect state integrity.
      if (transitioned.githubIssueNumber) {
        try {
          const ghService = await GitHubService.forSystem(logger);
          if (ghService) {
            const alreadyPosted = await ghService.hasCommentWithMarker(
              callbackRepoSlug,
              transitioned.githubIssueNumber,
              '<!-- sre-already-fixed -->'
            );
            if (!alreadyPosted) {
              await ghService.addIssueComment(
                callbackRepoSlug,
                transitioned.githubIssueNumber,
                `<!-- sre-already-fixed -->\n**SRE Agent — Already Fixed**\n\nA previous SRE operation already applied this fix (patches were idempotent). Please verify the original fix resolved the issue and close this issue if so.\n\n${body.workflowRunUrl ? `[Workflow run](${body.workflowRunUrl})` : 'Workflow run: N/A'}`
              );
            }
          }
        } catch (ghError) {
          logger.error('[SRE-CALLBACK] Failed to post already-fixed GH comment (non-fatal)', {
            error: serializeError(ghError),
          });
        }
      }
    } else {
      // Recoverable CI failures (typecheck/apply-fix) - route to revision queue for re-diagnosis
      if (body.recoverable) {
        const claimed = await sreErrorTrackingRepository.claimCiRetry(body.trackingId, repoConfig.maxCiRetries);

        if (!claimed) {
          // Distinguish cap exhaustion from true duplicate:
          // - Cap exhausted: document is still 'fixing' but ciRetryCount >= maxCiRetries
          // - True duplicate: document already transitioned (status no longer 'fixing')
          const doc = await sreErrorTrackingRepository.findFullById(body.trackingId);
          if (doc?.status === 'fixing') {
            // Cap exhausted - transition to failed so the document doesn't stay stranded in 'fixing'
            logger.warn('[SRE-CALLBACK] CI retry cap reached — transitioning to failed', {
              trackingId: body.trackingId,
              maxCiRetries: repoConfig.maxCiRetries,
            });
            await sreErrorTrackingRepository.atomicTransition(body.trackingId, 'fixing', 'failed', {
              workflowRunUrl: body.workflowRunUrl,
              errorMessage: `CI retry cap reached (${repoConfig.maxCiRetries} retries)`,
            });
            try {
              await postSreFixFailureMessage(
                body.trackingId,
                body.fingerprint,
                doc.errorMessage || '',
                `CI retry cap reached (${repoConfig.maxCiRetries} retries)`,
                body.workflowRunUrl || '',
                repoConfig.slack ?? {}
              );
            } catch (slackError) {
              logger.error('[SRE-CALLBACK] Failed to send CI cap-exhausted Slack notification (non-fatal)', {
                error: serializeError(slackError),
              });
            }
            // Escalate cleanly on GitHub too: leave the failing output on the source issue (deduped by
            // marker) so a human supersedes instead of finding a bare red run. Non-fatal - Slack is primary.
            // Prefer the fix PR (where a reviewer is looking at the red CI) over the source issue.
            // A revision-triggered cap exhaustion has a fixPrNumber; a pre-PR initial-fix exhaustion
            // falls back to the source issue. TOCTOU on the marker is cosmetic (no state divergence).
            const escalationTarget = doc.fixPrNumber ?? doc.githubIssueNumber;
            if (escalationTarget) {
              try {
                const ghService = await GitHubService.forSystem(logger);
                if (ghService) {
                  const alreadyPosted = await ghService.hasCommentWithMarker(
                    callbackRepoSlug,
                    escalationTarget,
                    SRE_CI_RETRY_EXHAUSTED_MARKER
                  );
                  if (!alreadyPosted) {
                    const failingOutput = body.failureOutput
                      ? `\n\n<details><summary>Last failing output</summary>\n\n\`\`\`\n${body.failureOutput.slice(0, 2000)}\n\`\`\`\n</details>`
                      : '';
                    await ghService.addIssueComment(
                      callbackRepoSlug,
                      escalationTarget,
                      `${SRE_CI_RETRY_EXHAUSTED_MARKER}\n**SRE Agent — Self-Heal Exhausted**\n\nThe automated fix could not pass CI after ${repoConfig.maxCiRetries} retries and will not edit a test to force it green. A human is needed to supersede this fix.${failingOutput}\n\n${body.workflowRunUrl ? `[Workflow run](${body.workflowRunUrl})` : ''}`
                    );
                  }
                }
              } catch (ghError) {
                logger.error('[SRE-CALLBACK] Failed to post CI cap-exhausted GH comment (non-fatal)', {
                  error: serializeError(ghError),
                });
              }
            }
            return res.status(200).json({ ok: true, capExhausted: true });
          }
          // True duplicate - document already transitioned
          logger.info('[SRE-CALLBACK] CI retry skipped — already processed', {
            trackingId: body.trackingId,
          });
          return res.status(200).json({ ok: true, duplicate: true });
        }

        logger.info('[SRE-CALLBACK] Recoverable CI failure — routing to revision queue', {
          trackingId: body.trackingId,
          ciRetryCount: claimed.ciRetryCount,
          failureReason: body.failureReason,
        });

        if (!claimed.diagnosisResult) {
          logger.warn('[SRE-CALLBACK] No diagnosisResult on claimed doc — falling through to hard fail', {
            trackingId: body.trackingId,
          });
          // Transition back to failed since we cannot retry without a diagnosis
          await sreErrorTrackingRepository.atomicTransition(body.trackingId, 'revision_requested', 'failed', {
            workflowRunUrl: body.workflowRunUrl,
            errorMessage: body.failureReason || 'Workflow failed (no diagnosis to retry)',
          });
          return res.status(200).json({ ok: true });
        } else {
          const revisionRequest: SreRevisionRequest = {
            trackingId: body.trackingId,
            fingerprint: body.fingerprint,
            repoSlug: callbackRepoSlug,
            // CI retries always re-read from the default branch (no existing PR branch)
            branchName: repoConfig.defaultBranch || 'main',
            // 0 signals the revision handler to create a fresh branch (no existing PR)
            prNumber: claimed.fixPrNumber ?? 0,
            reviewBody: `CI check failed (retry #${claimed.ciRetryCount ?? 1}):\n${body.failureReason ?? 'Unknown failure'}`,
            originalDiagnosis: claimed.diagnosisResult,
            source: claimed.source as SreSourceType,
            issueNumber: claimed.githubIssueNumber,
            ciFailureOutput: body.failureOutput,
          };

          await sendToQueue(getSourceQueueUrl('sreJobQueue'), {
            ...revisionRequest,
            jobType: 'revision' satisfies SreJobType,
          } as unknown as Record<string, unknown>);

          try {
            await postSreCiRetryMessage(
              body.trackingId,
              body.fingerprint,
              claimed.ciRetryCount ?? 1,
              body.failureReason ?? 'Unknown failure',
              body.workflowRunUrl || '',
              repoConfig.slack ?? {}
            );
          } catch (slackError) {
            logger.error('[SRE-CALLBACK] Failed to send CI retry Slack notification (non-fatal)', {
              error: serializeError(slackError),
            });
          }

          return res.status(200).json({ ok: true, retrying: true });
        }
      }

      const transitioned = await sreErrorTrackingRepository.atomicTransition(body.trackingId, 'fixing', 'failed', {
        workflowRunUrl: body.workflowRunUrl,
        errorMessage: body.failureReason || 'Workflow failed',
      });
      if (!transitioned) {
        logger.info('[SRE-CALLBACK] Already processed (idempotent skip)', { trackingId: body.trackingId });
        return res.status(200).json({ ok: true, duplicate: true });
      }

      try {
        await postSreFixFailureMessage(
          body.trackingId,
          body.fingerprint,
          transitioned.errorMessage || '',
          body.failureReason || 'Unknown',
          body.workflowRunUrl || '',
          repoConfig.slack ?? {}
        );
      } catch (slackError) {
        logger.error('[SRE-CALLBACK] Failed to send Slack failure notification (non-fatal)', {
          error: serializeError(slackError),
        });
      }
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    logger.error('[SRE-CALLBACK] Error processing callback', { error: serializeError(error) });
    return res.status(500).json({ error: 'Internal server error' });
  }
}
