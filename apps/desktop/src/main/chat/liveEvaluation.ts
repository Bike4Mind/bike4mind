import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChatModelOption } from '@shared/chat';
import type { AuthService } from '../auth/AuthService';
import { ChatService } from './ChatService';
import { ModelCatalog } from './ModelCatalog';
import { SessionStore } from './SessionStore';
import { AccessStore } from './tools/AccessStore';
import { bindEvaluationModel } from './completions';
import { supportsDeferredTools } from './deferredTools';
import { EvaluationBudget, EVALUATION_LIMITS, evaluationContext, liveEvaluationBlockers } from './evaluationBudget';

export function effectiveEvaluationArms(model: ChatModelOption) {
  const supported = supportsDeferredTools(model);
  return [
    { name: 'reference', deferred: false, skip: false },
    { name: 'deferred-zero', deferred: supported, skip: !supported },
  ];
}

/** Main-process entry point only; no token or auth-store access is exposed to the evaluator. */
export async function runLiveEvaluation(auth: AuthService, directory: string, optedIn: boolean): Promise<void> {
  if (!optedIn) return;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const blockers = liveEvaluationBlockers();
  if (blockers.length) {
    await writeFile(
      join(directory, 'blocked.json'),
      JSON.stringify(
        {
          kind: 'desktop-live-evaluation-v1',
          status: 'blocked',
          blockers,
          limits: EVALUATION_LIMITS,
          attempts: [],
          accepted: null,
          providerPricedUsd: null,
          platformUsd: null,
        },
        null,
        2
      ),
      { mode: 0o600 }
    );
    return;
  }
  const api = auth.getSessionBoundApiClient();
  if (!api) throw new Error('Sign in normally before evaluating.');
  const logger = { debug: () => {}, warn: () => {} };
  const models = new ModelCatalog(
    { logger, getApiClient: () => api, getEnvironmentUrl: () => auth.getState().environment.url },
    { models: async () => [] }
  );
  const catalog = await models.list(true);
  const pinned = catalog.models.find(model => model.id === 'gpt-6.1-sol' && !model.disabled && !model.unavailable);
  if (!pinned || pinned.backend !== 'openai' || !pinned.pricing) throw new Error('Pinned priced model is unavailable.');
  bindEvaluationModel(api.getAxiosInstance(), pinned);
  const budget = new EvaluationBudget(join(directory, 'budget.sqlite'));
  const outcomes: { arm: string; accepted: boolean; status: string }[] = [];
  try {
    await evaluationContext.run(budget, async () => {
      for (const arm of effectiveEvaluationArms(pinned)) {
        const outcome = { arm: arm.name, accepted: false, status: 'failed' };
        outcomes.push(outcome);
        if (arm.skip) {
          outcome.status = 'duplicate-effective-arm-not-run';
          continue;
        }
        const root = await mkdtemp(join(directory, 'fixture-'));
        await mkdir(join(root, 'instructions'));
        await writeFile(join(root, 'tiny.txt'), 'z');
        const store = new SessionStore(join(root, 'sessions'), pinned.id);
        const access = new AccessStore(join(root, 'access.json'));
        await access.grant(root);
        const service = new ChatService({
          store,
          access,
          models,
          logger,
          userInstructionsRoot: join(root, 'instructions'),
          deferredTools: arm.deferred ? { startSetMaxTokens: 0 } : undefined,
          turnLimits: { rounds: EVALUATION_LIMITS.rounds },
          getApiClient: () => api,
          getEnvironmentUrl: () => auth.getState().environment.url,
          emit: () => {},
        });
        let id: string | undefined;
        try {
          const created = await service.createCodeSession({ directory: root, branch: '', workspace: false });
          if (!created.ok) throw new Error('Fixture creation failed.');
          id = created.session.id;
          await store.rename(id, 'Evaluation fixture');
          const sent = await service.send(
            id,
            'Use file_read to read tiny.txt. Reply with exactly its single character. Do not call other tools.'
          );
          if (!sent.ok) throw new Error('Fixture send failed.');
          const deadline = Date.now() + 120_000;
          while (service.isSessionBusy(id) && Date.now() < deadline)
            await new Promise(resolve => setTimeout(resolve, 20));
          const reply = (await store.get(id))?.messages.at(-1);
          const accepted =
            !service.isSessionBusy(id) &&
            !reply?.error &&
            reply?.content.trim() === 'z' &&
            !!reply.toolCalls?.some(call => call.name === 'file_read' && call.status === 'done');
          outcome.accepted = accepted;
          outcome.status = accepted ? 'accepted' : 'rejected';
        } finally {
          if (id) service.stop(id);
          service.dispose();
        }
      }
    });
  } finally {
    await writeFile(
      join(directory, 'report.json'),
      JSON.stringify(
        {
          kind: 'desktop-live-evaluation-v1',
          model: pinned.id,
          pricing: pinned.pricing,
          limits: EVALUATION_LIMITS,
          outcomes,
          attempts: budget.report(),
          providerPricedUsd: null,
          platformUsd: null,
          unknowns: [
            'backend-retries',
            'hidden-billed-tokens',
            'cache-write-ttl-breakdown',
            'provider-price-reconciliation',
          ],
        },
        null,
        2
      ),
      { mode: 0o600 }
    ).finally(() => budget.close());
  }
}
