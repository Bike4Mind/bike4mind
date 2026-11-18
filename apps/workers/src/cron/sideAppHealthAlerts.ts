import { connectDB, oauthClientRepository, sideAppAlertStateRepository } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { Config } from '@bike4mind/server-utils/utils/config';
import {
  desiredAlerts,
  evaluateClient,
  evaluatePlatform,
  untrackedAlerts,
} from '@bike4mind/server-utils/sideApps/health/rules';
import { buildClientInputs } from '@bike4mind/server-utils/sideApps/health/rows';
import { postMessageToSlack } from '@bike4mind/utils';
import { Resource } from 'sst';
import { appUrlFromEnv, resolveAlarmWebhookUrl, SECRET_PLACEHOLDER, stageLabel } from '../events/alarmSlackMessage';
import { collectClientHealthRows } from './sideAppHealth/collect';
import { reconcileAlerts } from './sideAppHealth/reconcile';

/**
 * Hourly health check for connected apps: alerts when an armed app's requests fail or its traffic
 * goes silent, or when every armed app does. Connect and query errors propagate so the run lands
 * in the dead-letter queue.
 */
export async function handler(event?: { time?: string }) {
  if (!['production', 'dev'].includes(Resource.App.stage)) return { status: 'skipped' };
  const now = event?.time ? new Date(event.time) : new Date();
  await connectDB(Config.MONGODB_URI.replace('%STAGE%', Resource.App.stage), undefined, {
    autoIndex: false,
    autoCreate: false,
  });

  const webhook = resolveAlarmWebhookUrl(Resource).trim();
  if (!webhook || webhook === SECRET_PLACEHOLDER) {
    Logger.info('side app health alerts skipped', { report: 'side-app-health-alerts', reason: 'missing-webhook' });
    return { status: 'skipped', reason: 'missing-webhook' };
  }

  const rows = await collectClientHealthRows(now);
  const inputs = buildClientInputs(rows.hourly, rows.lastHour);
  const open = await sideAppAlertStateRepository.listOpen();
  const openRuleOf = (clientId: string) => open.find(ref => ref.scope === clientId)?.rule;
  const verdicts = inputs.map(input => evaluateClient(input, now.getTime(), openRuleOf(input.clientId)));
  const desired = desiredAlerts(verdicts, open);
  const untracked = untrackedAlerts(verdicts, open);
  const { armed } = evaluatePlatform(verdicts);

  const result = await reconcileAlerts(
    desired,
    {
      now,
      armedClientIds: armed.map(verdict => verdict.clientId),
      lookupNames: async clientIds => {
        const names = new Map<string, string>();
        if (!clientIds.length) return names;
        for (const [clientId, client] of await oauthClientRepository.findByClientIds(clientIds)) {
          if (client.name) names.set(clientId, client.name);
        }
        return names;
      },
      appUrl: appUrlFromEnv(),
      stageLabel: stageLabel(Resource.App.stage),
      post: message => postMessageToSlack(webhook, message),
    },
    untracked
  );

  Logger.info('side app health alerts report', {
    report: 'side-app-health-alerts',
    clients: verdicts.length,
    armed: armed.length,
    desired: desired.length,
    ...result,
  });
  return { status: 'success', ...result };
}
