#!/usr/bin/env node
/**
 * Entry point for `pnpm eval:run` - drives the eval suite against the
 * production B4M server backend (real LLM calls, real cost).
 *
 * Usage:
 *   pnpm eval:run [options]
 *
 * Options:
 *   --model <id>             Model to evaluate (default: claude-sonnet-4-6)
 *   --label <str>            Config label for output filename and reports
 *                            (default: <model>:default)
 *   --task <id>              Run only this task (repeatable). Default: all.
 *   --out <dir>              Output directory (default: packages/cli/.eval-runs)
 *   --max-cost-tokens <n>    Hard ceiling on cumulative tokens; aborts run
 *                            if exceeded. Default: no ceiling.
 *   --dry-run                Print the run plan and estimated max cost,
 *                            then exit without making any LLM calls.
 *   --help                   Show this help and exit.
 *
 * Authentication: requires a valid B4M token (`b4m` then `/login`). Auth
 * loads from the same `~/.bike4mind/config.json` the interactive CLI uses.
 */
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ConfigStore } from '../storage/ConfigStore.js';
import { buildEvalContext } from './buildEvalContext.js';
import { runEvalSuite } from './runner.js';
import { STARTER_TASKS } from './tasks/index.js';
import type { EvalTask, EvalReport } from './types.js';
import { isPromptVariant, PROMPT_VARIANTS, type PromptVariant } from './prompts.js';

/**
 * Output dir is anchored to the package root, not the user's cwd.
 * Prevents doubled paths when invoked from `packages/cli/` (which is what
 * `pnpm --filter cli` does).
 */
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_OUT_DIR = path.join(PACKAGE_ROOT, '.eval-runs');

/**
 * Sentinel used when the user does not pass `--model` - at runtime we
 * resolve this to whatever `defaultModel` is set in their B4M config.
 * Using the user's config (rather than a hardcoded id like
 * `claude-sonnet-4-6`) guarantees the model id is one their server
 * actually has registered.
 */
const MODEL_FROM_CONFIG = '__from_config__';

interface ParsedArgs {
  model: string;
  label: string;
  promptVariant: PromptVariant;
  taskIds?: Set<string>;
  outDir: string;
  maxCostTokens?: number;
  dryRun: boolean;
  help: boolean;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const out: ParsedArgs = {
    model: MODEL_FROM_CONFIG,
    label: '',
    promptVariant: 'current',
    outDir: DEFAULT_OUT_DIR,
    dryRun: false,
    help: false,
  };

  const taskIds = new Set<string>();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`Missing value for ${arg}`);
      return v;
    };

    switch (arg) {
      case '--model':
        out.model = next();
        break;
      case '--label':
        out.label = next();
        break;
      case '--task':
        taskIds.add(next());
        break;
      case '--out':
        out.outDir = path.resolve(next());
        break;
      case '--max-cost-tokens': {
        const v = Number(next());
        if (!Number.isFinite(v) || v <= 0) throw new Error('--max-cost-tokens must be a positive number');
        out.maxCostTokens = v;
        break;
      }
      case '--prompt-variant': {
        const v = next();
        if (!isPromptVariant(v)) {
          throw new Error(`--prompt-variant must be one of: ${PROMPT_VARIANTS.join(', ')} (got "${v}")`);
        }
        out.promptVariant = v;
        break;
      }
      case '--dry-run':
        out.dryRun = true;
        break;
      case '--help':
      case '-h':
        out.help = true;
        break;
      default:
        throw new Error(`Unknown flag: ${arg}`);
    }
  }

  if (taskIds.size > 0) out.taskIds = taskIds;
  // Label defaults are deferred to main() because they may depend on the
  // resolved model (which depends on ConfigStore for MODEL_FROM_CONFIG).

  return out;
}

/** Resolves MODEL_FROM_CONFIG to the user's actual default model. */
async function resolveModel(parsed: ParsedArgs, configStore: ConfigStore): Promise<string> {
  if (parsed.model !== MODEL_FROM_CONFIG) return parsed.model;
  const config = await configStore.load();
  if (!config.defaultModel) {
    throw new Error('No --model flag and no defaultModel in B4M config. Run `b4m` and set one via /model first.');
  }
  return config.defaultModel;
}

const DEFAULT_PER_TASK_TOKEN_CEILING = 100_000;

/** Maximum possible token spend for a run (sum of per-task ceilings). */
function estimateMaxTokens(tasks: readonly EvalTask[]): number {
  return tasks.reduce((sum, t) => sum + (t.maxTotalTokens ?? DEFAULT_PER_TASK_TOKEN_CEILING), 0);
}

function filterTasks(tasks: readonly EvalTask[], ids: Set<string> | undefined): EvalTask[] {
  if (!ids) return [...tasks];
  const matched = tasks.filter(t => ids.has(t.id));
  const unknown = [...ids].filter(id => !tasks.some(t => t.id === id));
  if (unknown.length > 0) {
    throw new Error(`Unknown task ids: ${unknown.join(', ')}`);
  }
  return matched;
}

const HELP_TEXT = `Usage: pnpm eval:run [options]

Options:
  --model <id>             Model id to evaluate. Defaults to your B4M
                           config's defaultModel (set via /model in the
                           interactive CLI). Pass explicitly to override.
  --label <str>            Config label for output filename. Defaults to
                           "<model>:<prompt-variant>".
  --prompt-variant <name>  System-prompt variant: ${PROMPT_VARIANTS.join(', ')}.
                           "current" (default) uses the agent core's
                           built-in prompt; "minimal" uses a pi-style
                           short prompt for A/B comparison.
  --task <id>              Run only this task (repeatable). Default: all.
  --out <dir>              Output directory (default: packages/cli/.eval-runs).
  --max-cost-tokens <n>    Hard token ceiling; aborts run if exceeded.
  --dry-run                Print plan + estimate, exit without LLM calls.
  --help                   Show this help.

Examples:
  pnpm eval:run --dry-run
  pnpm eval:run                                        # current prompt baseline
  pnpm eval:run --prompt-variant minimal               # minimal prompt A
  pnpm eval:run --model <your-model-id>
  pnpm eval:run --task read-file --task create-file
`;

/** Format a `EvalReport` as a one-line-per-result console table. */
function formatReport(report: EvalReport): string {
  const lines: string[] = [];
  lines.push(`\n=== Eval results: ${report.configLabel} ===`);
  for (const r of report.results) {
    const icon = r.error ? '⚠️ ' : r.passed ? '✅' : '❌';
    const tail = r.error ? ` (error: ${r.error})` : '';
    lines.push(
      `${icon} ${r.taskId.padEnd(20)} ` +
        `tokens=${String(r.metrics.totalTokens).padStart(6)} ` +
        `iters=${String(r.metrics.iterations).padStart(2)} ` +
        `tools=${String(r.metrics.toolCalls).padStart(2)} ` +
        `${r.metrics.wallClockMs}ms — ${r.reason}${tail}`
    );
  }
  const { passed, failed, errored, totalTokens, totalWallClockMs } = report.summary;
  lines.push(
    `\nSummary: ${passed} passed, ${failed} failed, ${errored} errored | ` +
      `${totalTokens} tokens, ${totalWallClockMs}ms wall`
  );
  return lines.join('\n');
}

export async function main(argv: readonly string[]): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`Argument error: ${error instanceof Error ? error.message : String(error)}\n\n`);
    process.stderr.write(HELP_TEXT);
    return 2;
  }

  if (parsed.help) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }

  const tasks = filterTasks(STARTER_TASKS, parsed.taskIds);
  if (tasks.length === 0) {
    process.stderr.write('No tasks matched the filter.\n');
    return 2;
  }

  // Resolve model + label up front so plan/dry-run output reflects what
  // an actual run would use.
  const configStore = new ConfigStore();
  let resolvedModel: string;
  try {
    resolvedModel = await resolveModel(parsed, configStore);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const resolvedLabel = parsed.label || `${resolvedModel}:${parsed.promptVariant}`;

  const maxTokens = estimateMaxTokens(tasks);
  process.stderr.write(
    `Plan: ${tasks.length} task(s) | model=${resolvedModel} | prompt=${parsed.promptVariant} | label=${resolvedLabel}\n` +
      `Max possible tokens: ${maxTokens.toLocaleString()} (sum of per-task ceilings)\n`
  );

  if (parsed.maxCostTokens && maxTokens > parsed.maxCostTokens) {
    process.stderr.write(
      `Refusing to start: max possible tokens (${maxTokens}) exceeds --max-cost-tokens (${parsed.maxCostTokens}).\n`
    );
    return 2;
  }

  if (parsed.dryRun) {
    process.stderr.write('Dry run — exiting without LLM calls.\n');
    return 0;
  }

  const { context, toolFactory } = await buildEvalContext({
    model: resolvedModel,
    configLabel: resolvedLabel,
    configStore,
    promptVariant: parsed.promptVariant,
  });

  const startedAt = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = path.join(parsed.outDir, startedAt);
  await fs.mkdir(runDir, { recursive: true });

  const report = await runEvalSuite(tasks, context, toolFactory);

  const safeLabel = resolvedLabel.replace(/[^a-zA-Z0-9._-]/g, '_');
  const reportPath = path.join(runDir, `${safeLabel}.json`);
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf-8');

  process.stdout.write(formatReport(report));
  process.stderr.write(`\nReport written to: ${reportPath}\n`);

  return report.summary.failed + report.summary.errored === 0 ? 0 : 1;
}

// Run only when executed directly (not on import). Uses `process.argv[1]`
// equality to handle both `node cli.ts` and `tsx cli.ts` invocations.
const isDirect = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (isDirect) {
  main(process.argv.slice(2)).then(
    code => process.exit(code),
    err => {
      process.stderr.write(`Fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
      process.exit(1);
    }
  );
}
