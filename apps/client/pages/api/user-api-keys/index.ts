import { userApiKeyService } from '@bike4mind/services';
import { userApiKeyRepository } from '@bike4mind/database/auth';
import { baseApi } from '@server/middlewares/baseApi';
import { logEvent } from '@server/utils/analyticsLog';
import { UserApiKeyEvents } from '@bike4mind/common';
import { Request } from 'express';

interface CreateApiKeyRequest {
  name: string;
  scopes: string[];
  expiresAt?: string;
  rateLimit?: {
    requestsPerMinute: number;
    requestsPerDay: number;
  };
}

const handler = baseApi()
  .get(async (req, res) => {
    const userId = req.user?.id;

    const apiKeys = await userApiKeyService.listUserApiKeys(userId, {
      db: {
        userApiKeys: userApiKeyRepository,
      },
    });

    return res.json(apiKeys);
  })
  .post(async (req: Request<{}, unknown, CreateApiKeyRequest>, res) => {
    const userId = req.user?.id;
    const { name, scopes, expiresAt, rateLimit } = req.body;

    const newApiKey = await userApiKeyService.createUserApiKey(
      userId,
      {
        name,
        scopes: scopes as any, // Type conversion handled in service
        expiresAt: expiresAt ? new Date(expiresAt) : undefined,
        rateLimit,
        metadata: {
          clientIP: req.ip,
          userAgent: req.headers['user-agent'],
          createdFrom: 'dashboard' as const,
        },
      },
      {
        db: {
          userApiKeys: userApiKeyRepository,
        },
      }
    );

    await logEvent(
      {
        userId,
        type: UserApiKeyEvents.CREATED,
        metadata: {
          keyId: newApiKey.id,
          name: newApiKey.name,
          scopes: newApiKey.scopes,
          expiresAt: newApiKey.expiresAt?.toISOString(),
          createdFrom: 'dashboard',
        },
      },
      { ability: req.ability }
    );

    return res.status(201).json(newApiKey);
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
