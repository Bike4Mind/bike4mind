/**
 * Organization Webhook Test API
 *
 * Sends a test ping event to verify webhook endpoint connectivity.
 * Used by admins to validate their webhook configuration before going live.
 *
 * Security:
 * - Requires user to have update access on the organization
 * - Uses same signature mechanism as real deliveries
 *
 * @route POST /api/organizations/[id]/webhooks/github/test - Send test ping
 */

import crypto from 'crypto';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { orgWebhookConfigRepository } from '@bike4mind/database/infra';
import { decryptSecret } from '@server/security/secretEncryption';
import { validateTargetUrl } from '@server/utils/ssrfProtection';
import { verifyOrgAccess } from '@server/utils/orgAccess';
import { Config } from '@server/utils/config';
import { cacheRepository } from '@bike4mind/database';
import { BadRequestError, NotFoundError, TooManyRequestsError } from '@bike4mind/utils';
import { v4 as uuidv4 } from 'uuid';

interface TestRequest {
  targetUrl?: string;
}

interface TestResponse {
  success: boolean;
  statusCode: number;
  latencyMs: number;
  error?: string;
}

const HTTP_TIMEOUT_MS = 5000; // 5 second timeout for test requests

// Rate limit: 10 test requests per minute per organization
const RATE_LIMIT = 10;
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute

const handler = baseApi().post(
  asyncHandler<{}, TestResponse, TestRequest, { id?: string }>(async (req, res) => {
    const orgId = req.query.id!;
    const user = req.user!;
    const { targetUrl } = req.body || {};

    // Rate limit check (atomic)
    const rateLimitKey = `webhook-test-rate:${orgId}`;
    const rateLimitResult = await cacheRepository.incrementCounterConditional(
      rateLimitKey,
      RATE_LIMIT,
      RATE_LIMIT_WINDOW_MS
    );
    if (!rateLimitResult.success) {
      throw new TooManyRequestsError(
        `Rate limit exceeded. Maximum ${RATE_LIMIT} test requests per minute per organization.`
      );
    }

    const org = await verifyOrgAccess(user, orgId);

    const webhookConfig = await orgWebhookConfigRepository.findByOrganizationId(orgId);
    if (!webhookConfig) {
      throw new NotFoundError('Webhook configuration not found');
    }

    if (targetUrl) {
      const validation = await validateTargetUrl(targetUrl);
      if (!validation.valid) {
        throw new BadRequestError(validation.error || 'Invalid target URL');
      }
    }

    const encryptionKey = Config.SECRET_ENCRYPTION_KEY;
    if (!encryptionKey) {
      throw new Error('SECRET_ENCRYPTION_KEY not configured');
    }

    const secret = decryptSecret(webhookConfig.secret, encryptionKey);

    const testPayload = {
      action: 'ping',
      zen: 'Keep it simple',
      hook_id: webhookConfig.id,
      organization: {
        id: org.id,
        login: org.name,
      },
      sender: {
        id: user.id,
        type: 'User',
      },
    };

    // Build request with timestamp-based signature
    const timestamp = Math.floor(Date.now() / 1000);
    const payloadString = JSON.stringify(testPayload);
    const signedPayload = `${timestamp}.${payloadString}`;
    const signature = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');

    const eventId = uuidv4();
    const deliveryId = uuidv4();

    // If no target URL, return a mock success (test the signature generation)
    if (!targetUrl) {
      return res.status(200).json({
        success: true,
        statusCode: 200,
        latencyMs: 0,
        error: undefined,
      });
    }

    // Execute HTTP with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    const startTime = Date.now();

    try {
      const response = await fetch(targetUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Event-ID': eventId,
          'X-Webhook-Delivery-ID': deliveryId,
          'X-Webhook-Timestamp': String(timestamp),
          'X-Webhook-Signature-256': `sha256=${signature}`,
          'X-Event-Type': 'ping',
          'X-GitHub-Event': 'ping',
          'User-Agent': 'Lumina5-Webhook/1.0 (Test)',
        },
        body: payloadString,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      const latencyMs = Date.now() - startTime;

      if (response.ok) {
        return res.status(200).json({
          success: true,
          statusCode: response.status,
          latencyMs,
        });
      }

      return res.status(200).json({
        success: false,
        statusCode: response.status,
        latencyMs,
        error: `HTTP ${response.status}: ${response.statusText}`,
      });
    } catch (error) {
      clearTimeout(timeoutId);
      const latencyMs = Date.now() - startTime;

      if (error instanceof Error && error.name === 'AbortError') {
        return res.status(200).json({
          success: false,
          statusCode: 0,
          latencyMs,
          error: `Request timeout after ${HTTP_TIMEOUT_MS / 1000}s`,
        });
      }

      return res.status(200).json({
        success: false,
        statusCode: 0,
        latencyMs,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
