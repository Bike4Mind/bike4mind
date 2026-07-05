/**
 * Dependency injection registry for @bike4mind/slack
 *
 * Call configureSlackPackage() once at application startup before
 * any Slack integration code runs.
 */

import type { ISlackServerDependencies, ISlackDatabaseDependencies } from './types';

let serverDeps: ISlackServerDependencies | null = null;
let databaseDeps: ISlackDatabaseDependencies | null = null;

/**
 * Initialize the @bike4mind/slack package with its required dependencies.
 * Must be called once at server startup before any Slack routes are hit.
 */
export function configureSlackPackage(server: ISlackServerDependencies, database: ISlackDatabaseDependencies): void {
  serverDeps = server;
  databaseDeps = database;
}

/**
 * Get server-specific dependencies (session manager, JWT, circuit breaker, etc.)
 * Throws if configureSlackPackage() has not been called.
 */
export function getSlackDeps(): ISlackServerDependencies {
  if (!serverDeps) {
    throw new Error('@bike4mind/slack: configureSlackPackage() must be called before using Slack integration');
  }
  return serverDeps;
}

/**
 * Get database dependencies (models, repositories).
 * Throws if configureSlackPackage() has not been called.
 */
export function getSlackDb(): ISlackDatabaseDependencies {
  if (!databaseDeps) {
    throw new Error('@bike4mind/slack: configureSlackPackage() must be called before using Slack integration');
  }
  return databaseDeps;
}

/**
 * Check if the package has been initialized.
 */
export function isSlackPackageConfigured(): boolean {
  return serverDeps !== null && databaseDeps !== null;
}
