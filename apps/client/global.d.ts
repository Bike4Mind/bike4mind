import { Ability } from '@server/auth/ability';
import { ApiKeyScope, IUserApiKeyRateLimit, IUserDocument } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import type { EntitlementKey } from '@client/lib/entitlements/types';

declare global {
  namespace Express {
    interface User extends IUserDocument {}

    interface ApiKeyInfo {
      keyId: string;
      scopes: ApiKeyScope[];
      rateLimit: IUserApiKeyRateLimit;
      /** Overwatch product this key is bound to. Set only for OVERWATCH_INGEST_WRITE keys. */
      productId?: string;
    }

    interface ApiKeyUsageInfo {
      keyId: string;
      userId: string;
      ipAddress: string;
      endpoint: string;
      method: string;
      startTime: number;
    }

    interface Request {
      baseUrl: string;
      logger: Logger;
      /** Correlation ID for this request, echoed back as the X-Request-ID header. */
      requestId: string;
      user: IUserDocument;
      ability?: Ability;
      /**
       * Per-request memoized entitlement keys (Quest 3). Set ONLY by
       * `getRequestEntitlements` (`@server/entitlements`) — never parsed from
       * the request body/query — mirroring the `req.ability` cache.
       */
      entitlements?: EntitlementKey[];
      apiKeyInfo?: ApiKeyInfo;
      _apiKeyUsageInfo?: ApiKeyUsageInfo;
      locals?: {
        params?: Record<string, string | undefined>;
      };
      /**
       * Mongo connect duration (ms) for this request. Set ONLY by the connectDB
       * middleware in `baseApi` and read by the req-timing middleware. (#9148 benchmarking)
       */
      __connectMs?: number;
    }
  }
}

export {};
