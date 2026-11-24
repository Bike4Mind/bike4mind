import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { isAxiosError } from 'axios';
import type { ChatModelOption } from '@shared/chat';
import { inheritancePolicy } from '@shared/orchestration';
import type { AuthService } from '../auth/AuthService';
import { ChatService } from './ChatService';
import { ModelCatalog } from './ModelCatalog';
import { MessageQueue } from './MessageQueue';
import { SessionStore } from './SessionStore';
import { AccessStore } from './tools/AccessStore';
import { bindEvaluationModel } from './completions';
import { supportsDeferredTools } from './deferredTools';
import { EvaluationBudget, EVALUATION_LIMITS, evaluationContext } from './evaluationBudget';

export const evaluationConfigSchema = z
  .object({
    version: z.literal(1),
    arms: z
      .array(z.enum(['reference', 'deferred-zero', 'ttl-only', 'compaction-only']))
      .min(1)
      .default(['reference', 'deferred-zero', 'ttl-only', 'compaction-only']),
    warm: z.boolean().default(true),
    longLoop: z.boolean().default(true),
    toolChange: z.boolean().default(true),
    restart: z.boolean().default(false),
    pauseMs: z.number().int().min(0).max(3_660_000).default(0),
    loopDepth: z.number().int().min(4).max(16).default(8),
    workers: z.boolean().default(false),
    finalModelId: z.string().min(1).max(128).optional(),
  })
  .strict();
type EvaluationConfig = z.infer<typeof evaluationConfigSchema>;
const checkpointSchema = z.object({
  version: z.literal(1),
  config: evaluationConfigSchema,
  modelId: z.string(),
  pricing: z.string(),
  armIndex: z.number().int().nonnegative(),
  stageIndex: z.number().int().nonnegative(),
  sessionId: z.string().optional(),
  fixture: z.uuid().optional(),
  restartProcess: z.string().optional(),
  pauseUntil: z.number().optional(),
  inFlight: z.boolean(),
  outcomes: z.array(
    z.object({ arm: z.string(), stage: z.string(), status: z.string(), accepted: z.boolean().nullable() })
  ),
});
type Checkpoint = z.infer<typeof checkpointSchema>;
const processIdentity = randomUUID();

export function effectiveEvaluationArms(model: ChatModelOption) {
  const supported = supportsDeferredTools(model);
  return [
    { name: 'reference', deferred: false, ttl: '5m' as const, compact: false, skip: false },
    { name: 'deferred-zero', deferred: supported, ttl: '5m' as const, compact: false, skip: !supported },
    {
      name: 'ttl-only',
      deferred: false,
      ttl: model.supportsOneHourCache ? ('1h' as const) : ('5m' as const),
      compact: false,
      skip: !model.supportsOneHourCache,
    },
    { name: 'compaction-only', deferred: false, ttl: '5m' as const, compact: true, skip: false },
  ];
}

async function save(path: string, value: unknown): Promise<void> {
  await writeFile(`${path}.tmp`, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(`${path}.tmp`, path);
}

async function load(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function acquireLock(path: string): Promise<() => Promise<void>> {
  try {
    const handle = await open(path, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid }));
    } finally {
      await handle.close();
    }
    return () => unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const previous = z.object({ pid: z.number().int().positive() }).parse(await load(path));
    try {
      process.kill(previous.pid, 0);
    } catch (probeError) {
      if ((probeError as NodeJS.ErrnoException).code === 'ESRCH') {
        await unlink(path);
        return acquireLock(path);
      }
      throw probeError;
    }
    throw new Error('Another evaluation process is active.');
  }
}

export function evaluationStages(config: EvaluationConfig, compact: boolean): string[] {
  return [
    'fresh',
    ...(config.warm ? ['warm'] : []),
    ...(config.longLoop ? ['long-loop'] : []),
    ...(config.workers ? ['worker-parent-wake'] : []),
    ...(config.toolChange ? ['tool-change', 'tool-replay'] : []),
    ...(compact ? ['compact', 'post-compact'] : []),
    ...(config.pauseMs ? ['ttl-pause', 'post-pause'] : []),
    ...(config.restart ? ['process-restart', 'post-restart'] : []),
  ];
}

/** Only an explicit launch argument opts in; server administrative authorization remains independent. */
export async function runLiveEvaluation(
  auth: AuthService,
  directory: string,
  optedIn: boolean,
  configPath?: string,
  options: { finalPhase?: boolean; recoverRunId?: string; workerQuietMs?: number } = {}
): Promise<void> {
  if (!optedIn) return;
  const suppliedConfig = configPath ? await load(configPath) : { version: 1 };
  if (!suppliedConfig) throw new Error('Evaluation config file does not exist.');
  const config = evaluationConfigSchema.parse(suppliedConfig);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const releaseLock = await acquireLock(join(directory, 'active.lock'));
  const budget = new EvaluationBudget(join(directory, 'budget-v2.sqlite'));
  const checkpointPath = join(directory, options.finalPhase ? 'checkpoint-final.json' : 'checkpoint.json');
  let state: Checkpoint | undefined;
  let status = 'failed-before-dispatch';
  let pinned: ChatModelOption | undefined;
  try {
    const api = auth.getSessionBoundApiClient();
    if (!api) throw new Error('Sign in normally before evaluating.');
    const logger = { debug: () => {}, warn: () => {} };
    const models = new ModelCatalog(
      { logger, getApiClient: () => api, getEnvironmentUrl: () => auth.getState().environment.url },
      { models: async () => [] }
    );
    const catalog = await models.list(true);
    const broad = catalog.models.find(model => model.id === 'gpt-6.1-sol' && model.backend === 'openai');
    if (!broad) throw new Error('Broad-sweep model is unavailable.');
    const final = config.finalModelId
      ? catalog.models.find(
          model =>
            model.id === config.finalModelId &&
            model.backend === 'anthropic' &&
            /opus/i.test(`${model.id} ${model.name}`)
        )
      : undefined;
    if (config.finalModelId && !final) throw new Error('Exact final Opus model is unavailable.');
    if (options.finalPhase) {
      const sweep = checkpointSchema.parse(await load(join(directory, 'checkpoint.json')));
      if (
        JSON.stringify(sweep.config) !== JSON.stringify(config) ||
        sweep.inFlight ||
        !sweep.outcomes.some(outcome => outcome.stage === 'fresh' && outcome.accepted === true) ||
        sweep.armIndex <
          effectiveEvaluationArms(broad).filter(arm =>
            config.arms.includes(arm.name as EvaluationConfig['arms'][number])
          ).length
      )
        throw new Error('Complete the broad sweep before the explicit final phase.');
    }
    const allowedModels = [broad, final].filter((model): model is ChatModelOption => !!model);
    pinned = options.finalPhase ? final : broad;
    if (!pinned || pinned.disabled || pinned.unavailable || !pinned.pricing || pinned.supportsTools === false)
      throw new Error('Pinned priced tool-capable model is unavailable.');
    for (const model of allowedModels) bindEvaluationModel(api.getAxiosInstance(), model);
    budget.pinModels(allowedModels);
    budget.permitDispatch([pinned.id]);
    const stored = await load(checkpointPath);
    state = stored
      ? checkpointSchema.parse(stored)
      : {
          version: 1,
          config,
          modelId: pinned.id,
          pricing: JSON.stringify(pinned.pricing),
          armIndex: 0,
          stageIndex: 0,
          inFlight: false,
          outcomes: [],
        };
    if (
      JSON.stringify(state.config) !== JSON.stringify(config) ||
      state.modelId !== pinned.id ||
      state.pricing !== JSON.stringify(pinned.pricing)
    )
      throw new Error('Evaluation checkpoint configuration changed.');
    await budget.connect(
      api.getAxiosInstance(),
      allowedModels.map(model => model.id),
      options.recoverRunId
    );
    if (state.inFlight) {
      state.outcomes.push({
        arm: 'interrupted',
        stage: 'recovery',
        accepted: false,
        status: 'interrupted-not-replayed',
      });
      state.inFlight = false;
      state.stageIndex++;
      await save(checkpointPath, state);
    }
    const checkpoint = state;
    const arms = effectiveEvaluationArms(pinned).filter(arm =>
      config.arms.includes(arm.name as EvaluationConfig['arms'][number])
    );
    status = 'running';
    await evaluationContext.run(budget, async () => {
      for (
        ;
        checkpoint.armIndex < arms.length;
        checkpoint.armIndex++,
          checkpoint.stageIndex = 0,
          checkpoint.sessionId = undefined,
          checkpoint.fixture = undefined
      ) {
        const arm = arms[checkpoint.armIndex];
        budget.permitDispatch([pinned!.id]);
        if (arm.skip) {
          checkpoint.outcomes.push({
            arm: arm.name,
            stage: 'selection',
            accepted: null,
            status: 'duplicate-effective-arm-not-run',
          });
          continue;
        }
        if (!checkpoint.fixture) {
          checkpoint.fixture = randomUUID();
          const root = join(directory, checkpoint.fixture, 'project');
          await mkdir(root, { recursive: true });
          await mkdir(join(directory, checkpoint.fixture, 'instructions'));
          await writeFile(
            join(directory, checkpoint.fixture, 'instructions', 'CLAUDE.md'),
            'Preserve evidence. Never access files outside the fixture project.'
          );
          await writeFile(join(root, 'CLAUDE.md'), 'Use read-only tools. Report only the requested answer.');
          await writeFile(join(root, 'ledger.json'), JSON.stringify([{ n: 3 }, { n: 7 }, { n: 11 }]));
          for (let i = 1; i <= config.loopDepth; i++)
            await writeFile(
              join(root, `step-${i}.json`),
              JSON.stringify({ value: i, next: i === config.loopDepth ? null : `step-${i + 1}.json` })
            );
          await save(checkpointPath, checkpoint);
        }
        const fixture = join(directory, checkpoint.fixture);
        const root = await realpath(join(fixture, 'project'));
        const store = new SessionStore(join(fixture, 'sessions'), pinned!.id);
        const access = new AccessStore(join(fixture, 'access.json'));
        await access.grant(root);
        const service = new ChatService({
          store,
          access,
          models,
          logger,
          queue: new MessageQueue(() => {}),
          userInstructionsRoot: join(fixture, 'instructions'),
          deferredTools: arm.deferred ? { startSetMaxTokens: 0 } : undefined,
          turnLimits: { rounds: EVALUATION_LIMITS.rounds },
          getApiClient: () => api,
          getEnvironmentUrl: () => auth.getState().environment.url,
          emit: () => {},
        });
        try {
          if (!checkpoint.sessionId) {
            const created = await service.createCodeSession({ directory: root, branch: '', workspace: false });
            if (!created.ok) throw new Error('Fixture creation failed.');
            checkpoint.sessionId = created.session.id;
            await store.setModel(checkpoint.sessionId, pinned!.id);
            await store.rename(checkpoint.sessionId, 'Evaluation fixture');
            await store.setPromptCacheTtl(checkpoint.sessionId, arm.ttl);
            await save(checkpointPath, checkpoint);
          }
          const id = checkpoint.sessionId;
          const stages = evaluationStages(config, arm.compact);
          for (; checkpoint.stageIndex < stages.length; checkpoint.stageIndex++) {
            const stage = stages[checkpoint.stageIndex];
            budget.stage = `${options.finalPhase ? 'final' : 'sweep'}/${arm.name}/${stage}`;
            budget.withdrawnTools = new Set(
              config.toolChange &&
                checkpoint.stageIndex >= stages.indexOf('tool-change') &&
                stages.includes('tool-change')
                ? ['glob_files', 'grep_search']
                : []
            );
            if (stage === 'process-restart') {
              if (!checkpoint.restartProcess) {
                checkpoint.restartProcess = processIdentity;
                await save(checkpointPath, checkpoint);
              }
              if (checkpoint.restartProcess === processIdentity) {
                status = 'restart-required';
                return;
              }
              checkpoint.outcomes.push({ arm: arm.name, stage, accepted: null, status: 'new-process-confirmed' });
              checkpoint.restartProcess = undefined;
              continue;
            }
            if (stage === 'ttl-pause') {
              checkpoint.pauseUntil ??= Date.now() + config.pauseMs;
              await save(checkpointPath, checkpoint);
              const remaining = checkpoint.pauseUntil - Date.now();
              if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
              checkpoint.pauseUntil = undefined;
              checkpoint.outcomes.push({ arm: arm.name, stage, accepted: null, status: 'elapsed-real-time' });
              continue;
            }
            checkpoint.inFlight = true;
            await save(checkpointPath, checkpoint);
            let accepted = false;
            if (stage === 'worker-parent-wake') {
              await store.setRolePolicy(inheritancePolicy());
              await service.setSessionOrchestrate(id, true);
              const parentBefore = (await store.get(id))?.messages.length ?? 0;
              budget.allowWorker = true;
              budget.workersStarted = 0;
              const childId = await service.startEvaluationWorker(
                id,
                'Read ledger.json using file_read. Sum its n fields. Reply only with the decimal sum.'
              );
              const deadline = Date.now() + 300_000;
              let quietSince = Date.now();
              while (Date.now() < deadline) {
                const busy = service.isSessionBusy(id) || service.isSessionBusy(childId);
                if (busy) quietSince = Date.now();
                if (!busy && Date.now() - quietSince > (options.workerQuietMs ?? 1000)) break;
                await new Promise(resolve => setTimeout(resolve, 20));
              }
              const child = await store.get(childId);
              const parent = await store.get(id);
              accepted =
                !service.isSessionBusy(childId) &&
                !service.isSessionBusy(id) &&
                child?.messages.at(-1)?.content.trim() === '21' &&
                !child.messages.at(-1)?.error &&
                child.messages.some(message =>
                  message.toolCalls?.some(call => call.name === 'file_read' && call.status === 'done')
                ) &&
                !!parent?.messages.slice(parentBefore).some(message => message.role === 'assistant' && !message.error);
              service.stop(childId);
              budget.allowWorker = false;
              await service.setSessionOrchestrate(id, false);
            } else if (stage === 'compact') {
              const result = await service.compactContext(id, 'Preserve the ledger sum and chain evidence.');
              accepted = result.ok;
            } else {
              const chain = stage === 'long-loop';
              const expected = chain ? String((config.loopDepth * (config.loopDepth + 1)) / 2) : '21';
              const prompt = chain
                ? 'Read step-1.json with file_read and follow each next file sequentially until null. Sum all value fields. Reply only with the decimal sum. Do not batch, skip, or infer unseen files.'
                : stage === 'fresh'
                  ? 'Use file_read to read ledger.json. Sum its n fields. Reply only with the decimal sum.'
                  : 'Using the previously read ledger.json, reply only with its decimal sum. You may re-read it with file_read.';
              const before = (await store.get(id))?.messages.length ?? 0;
              const sent = await service.send(id, prompt);
              if (!sent.ok) throw new Error('Fixture send failed.');
              const deadline = Date.now() + 300_000;
              while (service.isSessionBusy(id) && Date.now() < deadline)
                await new Promise(resolve => setTimeout(resolve, 20));
              const replies = (await store.get(id))?.messages.slice(before) ?? [];
              const reply = replies.at(-1);
              const reads = replies
                .flatMap(message => message.toolCalls ?? [])
                .filter(call => call.name === 'file_read' && call.status === 'done');
              const chainRead = Array.from({ length: config.loopDepth }, (_, i) => join(root, `step-${i + 1}.json`));
              const actualReads = reads.map(call => call.input.path);
              const followedChain = chainRead.every((path, index) => actualReads[index] === path);
              const readLedger = reads.some(call => call.input.path === join(root, 'ledger.json'));
              accepted =
                !service.isSessionBusy(id) &&
                !reply?.error &&
                reply?.content.trim() === expected &&
                (stage === 'fresh' ? readLedger : chain ? followedChain : true);
              if (service.isSessionBusy(id)) service.stop(id);
            }
            checkpoint.outcomes.push({ arm: arm.name, stage, accepted, status: accepted ? 'accepted' : 'rejected' });
            checkpoint.inFlight = false;
            // Save the next stage before admitting another paid turn.
            checkpoint.stageIndex++;
            await save(checkpointPath, checkpoint);
            checkpoint.stageIndex--;
          }
        } finally {
          budget.allowWorker = false;
          budget.pauseDispatch();
          try {
            if (checkpoint.sessionId) await service.setSessionOrchestrate(checkpoint.sessionId, false);
            for (const session of await store.list()) service.stop(session.id);
          } finally {
            service.dispose();
            await budget.serialize(async () => {});
          }
        }
      }
      status = 'complete';
    });
  } catch (error) {
    status =
      isAxiosError(error) && error.response?.status === 403
        ? 'server-administrative-authorization-required'
        : 'stopped-recovery-or-authorization-required';
  } finally {
    if (state) await save(checkpointPath, state);
    const totals = budget.totals();
    const accepted =
      state?.outcomes.filter(outcome => outcome.accepted === true && outcome.stage !== 'compact').length ?? 0;
    const byArm = config.arms.map(arm => {
      const outcomes = state?.outcomes.filter(outcome => outcome.arm === arm) ?? [];
      const accepted = outcomes.filter(outcome => outcome.accepted === true && outcome.stage !== 'compact').length;
      const totals = budget.armTotals(`${options.finalPhase ? 'final' : 'sweep'}/${arm}`);
      return {
        arm,
        ...totals,
        accepted,
        rejected: outcomes.filter(outcome => outcome.accepted === false).length,
        costPerAcceptedResultUsd:
          accepted && totals.providerPricedUsd !== null ? totals.providerPricedUsd / accepted : null,
      };
    });
    await save(join(directory, options.finalPhase ? 'report-final.json' : 'report.json'), {
      kind: 'desktop-live-evaluation-v2',
      status,
      model: pinned?.id ?? null,
      pricing: pinned?.pricing ?? null,
      config,
      limits: EVALUATION_LIMITS,
      outcomes: state?.outcomes ?? [],
      attempts: budget.report(),
      ...totals,
      accepted,
      byArm,
      costPerAcceptedResultUsd:
        accepted && byArm.every(arm => arm.attemptCount === 0 || arm.providerPricedUsd !== null)
          ? byArm.reduce((sum, arm) => sum + (arm.providerPricedUsd ?? 0), 0) / accepted
          : null,
      unknowns: [
        'Provider-priced cost is not an invoice.',
        'Cache write TTL categories are unknown unless supplied by receipt.',
        'Role-based source sizes do not establish cache hits, stable prefixes, or rewrite causes; content hashes are omitted.',
        'A final phase runs only with a separately supplied explicit launch gate; no automatic upgrade occurs.',
      ],
    }).finally(async () => {
      budget.close();
      await releaseLock();
    });
  }
}
