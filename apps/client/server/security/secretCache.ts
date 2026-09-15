import { Config } from '@server/utils/config';

interface SecretCache {
  [key: string]: {
    value: string | undefined;
    timestamp: number;
  };
}

const CACHE_EXPIRY = 5 * 60 * 1000;

export class SecretCacheManager {
  private static instance: SecretCacheManager;
  private cache: SecretCache = {};
  private loading: { [key: string]: Promise<string | undefined> } = {};

  private constructor() {}

  public static getInstance(): SecretCacheManager {
    if (!SecretCacheManager.instance) {
      SecretCacheManager.instance = new SecretCacheManager();
    }
    return SecretCacheManager.instance;
  }

  private isCacheValid(key: string): boolean {
    const cached = this.cache[key];
    if (!cached) return false;
    return Date.now() - cached.timestamp < CACHE_EXPIRY;
  }

  public async getSecret(key: keyof typeof Config): Promise<string | undefined> {
    if (this.loading[key] !== undefined) {
      return this.loading[key];
    }

    if (this.isCacheValid(key)) {
      return this.cache[key].value;
    }

    this.loading[key] = (async () => {
      try {
        const value = await Config[key];
        this.cache[key] = {
          value,
          timestamp: Date.now(),
        };
        return value;
      } finally {
        delete this.loading[key];
      }
    })();

    return this.loading[key];
  }

  public clearCache(): void {
    this.cache = {};
  }
}

export const secretCache = SecretCacheManager.getInstance();
