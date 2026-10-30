import { z } from 'zod';
import { ApiKeyScope } from '@bike4mind/common';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { mapApiError, type B4mApiClient } from './b4mApiClient.js';
import { errorResult, toResult } from './tools.js';
import { logger } from '../utils/Logger.js';

/** Both scopes the tools need; named in a 403 so callers know what to grant. */
const REQUIRED_SCOPES = [ApiKeyScope.OPTIHASHI_READ, ApiKeyScope.OPTIHASHI_COMPUTE];
const SOLVER_SCOPES = REQUIRED_SCOPES.join(' and ');
const SOLVER_DISCOVERY_TIMEOUT_MS = 5 * 1000;

/**
 * The route's GET answer, trusted only as far as the tool schemas need. Everything beyond these
 * fields passes through to the agent untouched, so a roster or limit the server adds later needs
 * no CLI release.
 */
const catalogSchema = z.looseObject({
  family: z.looseObject({ familyIds: z.array(z.string()), solverIds: z.array(z.string()) }),
  scheduling: z.looseObject({ solverIds: z.array(z.string()) }),
  defaultSolverIds: z.array(z.string()),
  limits: z.looseObject({
    maxSolversPerRequest: z.number().int().positive(),
    defaultTimeoutMs: z.number().int().positive(),
    maxTimeoutMs: z.number().int().positive(),
  }),
});

type SolverCatalog = z.infer<typeof catalogSchema>;

const oneOf = (ids: string[]): [string, ...string[]] | undefined =>
  ids.length > 0 ? [ids[0], ...ids.slice(1)] : undefined;

function solveInputShape(catalog: SolverCatalog) {
  const solverIds = oneOf([...new Set([...catalog.family.solverIds, ...catalog.scheduling.solverIds])]);
  const familyIds = oneOf(catalog.family.familyIds);
  const { limits } = catalog;
  return {
    familyId: (familyIds ? z.enum(familyIds) : z.string())
      .optional()
      .describe('Problem family. Omit for a scheduling brief; the problem must then be a scheduling problem.'),
    problem: z
      .record(z.string(), z.unknown())
      .describe('The problem instance. The server validates it and names what is wrong on a 400.'),
    solverIds: z
      .array(solverIds ? z.enum(solverIds) : z.string())
      .min(1)
      .max(limits.maxSolversPerRequest)
      .optional()
      .describe(`Solvers to race. Defaults to ${catalog.defaultSolverIds.join(', ')}.`),
    timeoutMs: z
      .number()
      .int()
      .min(100)
      .max(limits.maxTimeoutMs)
      .optional()
      .describe(`Per-solver time budget in ms (default ${limits.defaultTimeoutMs}).`),
    includeTrace: z.boolean().optional().describe('Include a truncated convergence trace per solver.'),
  };
}

/**
 * Register the solver tools an entitled caller may use, built from what the server reports at
 * startup. Stdio only: the HTTP transport has no per-request auth, so it never calls this.
 *
 * Offering nothing is the normal outcome for a caller without the feature, the scopes or the
 * entitlement (the route answers 403/404), so any failure here leaves the server's other tools
 * untouched instead of failing the session. Only the free classical race is exposed; no tool here
 * commissions paid compute.
 */
export async function registerSolverTools(server: McpServer, client: B4mApiClient): Promise<void> {
  let catalog: SolverCatalog;
  let discoveryTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Axios timeouts do not cover credential loading or OAuth refresh in its interceptors.
    const [rawCatalog, scopes] = await Promise.race([
      Promise.all([client.getSolverCatalog(), client.getOwnKeyScopes()]),
      new Promise<never>((_resolve, reject) => {
        discoveryTimer = setTimeout(() => reject(new Error('solver discovery timed out')), SOLVER_DISCOVERY_TIMEOUT_MS);
      }),
    ]);
    if (scopes && !REQUIRED_SCOPES.every(scope => scopes.includes(scope))) {
      logger.debug(`mcp: solver tools not offered: key lacks ${SOLVER_SCOPES}`);
      return;
    }
    catalog = catalogSchema.parse(rawCatalog);
  } catch (err) {
    logger.debug(`mcp: solver tools not offered: ${mapApiError(err, client.baseURL, SOLVER_SCOPES)}`);
    return;
  } finally {
    clearTimeout(discoveryTimer);
  }

  const run = async (fn: () => Promise<unknown>) => {
    try {
      return toResult(await fn());
    } catch (err) {
      return errorResult(mapApiError(err, client.baseURL, SOLVER_SCOPES));
    }
  };

  server.registerTool(
    'optihashi_solvers',
    {
      title: 'List OptiHashi solvers',
      description:
        'List the problem families, solvers, default race and limits available to the caller. Call before optihashi_solve.',
    },
    () => run(async () => catalogSchema.parse(await client.getSolverCatalog()))
  );

  server.registerTool(
    'optihashi_solve',
    {
      title: 'Solve with OptiHashi',
      description:
        'Race classical solvers on an optimization problem and return the ranked results and the winner. Bounded and synchronous; no credits are spent.',
      inputSchema: solveInputShape(catalog),
    },
    args => run(() => client.runSolverRace(args))
  );
}
