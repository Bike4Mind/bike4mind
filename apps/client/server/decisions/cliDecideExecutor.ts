import { userRepository } from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';
import type { ServerToolExecutor } from '@bike4mind/services';
import { describeDecisionFailure } from '@server/decisions/decisionErrors';
import { runDecision, type DecisionRunBody } from '@server/decisions/runDecision';

/**
 * The `decide` server-tool executor, shared by the CLI Lambda and the local-dev Next route. It lives
 * in the app tier because the runner needs the credit hold, which b4m-core cannot import.
 *
 * `runDecision` keeps provider text and caller-supplied values out of logs; this executor holds the
 * same line for the audit log, which persists whatever it throws. It therefore rethrows the failure
 * class and never the message.
 */
export const buildDecideExecutor =
  (logger: Logger): ServerToolExecutor =>
  async request => {
    const user = await userRepository.findById(request.userId);
    if (!user) throw new Error('No such user');
    try {
      const result = await runDecision({
        caller: { userId: request.userId, user, logger, source: 'cli' },
        body: request.input as unknown as DecisionRunBody,
      });
      return JSON.stringify({ id: result.id, model: result.model, answers: result.answers });
    } catch (error) {
      throw new Error(describeDecisionFailure(error));
    }
  };
