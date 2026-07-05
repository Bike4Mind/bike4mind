import * as dotenv from 'dotenv';

dotenv.config();

/**
 * Initialize a config object with fallback values.
 *
 * @param fallbackConfig - The fallback config object.
 * @returns A proxied object that reads from environment variables first, then the fallback config.
 */
const initializeConfig = <T, K extends keyof T>(fallbackConfig: Record<K, string>) => {
  return new Proxy(fallbackConfig, {
    get: (target, prop) => {
      // Use env (or .env) first, if set
      if (process.env[prop as string]) {
        return process.env[prop as string];
      }
      // Check SST config, if available:
      let value: string | undefined;
      try {
        value = target[prop as keyof typeof fallbackConfig];
      } catch (error) {
        // Ignore
      }
      // No? Throw an error:
      if (value === undefined) {
        throw new Error(`Config.${String(prop)} is unset`);
      }
      return value;
    },
  });
};

export { initializeConfig };
