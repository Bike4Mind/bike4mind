import { appFilesBucket, fabFileBucket, generatedImagesBucket } from './buckets';
import { DEFAULT_LAMBDA_ENVIRONMENT, PRODUCTION_STAGES } from './constants';
import { allSecrets, secrets } from './secrets';
import { cluster, lambdaVpc } from './vpc';
import { websocketApi } from './websocket';

// Image source: subscriber-fanout lives in its own repo and is consumed as a
// published linux/amd64 image. The container registry is account-tied, so the
// image reference comes from the SUBSCRIBER_FANOUT_IMAGE env var with no brand
// fallback - set it per deployment in .github/workflows/_deploy-env.yml (repo/org
// variable). A fork publishes its own image and points this at its own registry.
//
// CI must set it (throws otherwise). `sst remove`, `sst secrets list`,
// `sst diagnostic`, and infra typechecks load this module too; gating the throw
// on process.env.CI lets those paths work without the env var. For local
// `sst dev` (no CI=true) a neutral public placeholder keeps the SST graph valid
// — the fanout isn't exercised during app-level work.
//
// Initial attempt gated on $app.command, but `command` is on $cli (marked
// @internal in SST types), not $app . polaris#4505 typecheck caught it.
const LOCAL_PLACEHOLDER_IMAGE = 'public.ecr.aws/docker/library/busybox:latest';
const isCI = process.env.CI === 'true';
const fanoutImage = process.env.SUBSCRIBER_FANOUT_IMAGE || (isCI ? '' : LOCAL_PLACEHOLDER_IMAGE);
if (isCI && !fanoutImage) {
  throw new Error(
    'SUBSCRIBER_FANOUT_IMAGE must be set in CI — provide your subscriber-fanout image reference ' +
      '(see .github/workflows/_deploy-env.yml). For local sst dev (no CI=true), a neutral public ' +
      'placeholder is used automatically.'
  );
}

export const subscriberFanout = new sst.aws.Service('subscriberFanoutV2', {
  cluster,
  link: [secrets.MONGODB_URI, websocketApi],
  image: fanoutImage,
  cpu: '0.25 vCPU',
  memory: PRODUCTION_STAGES.includes($app.stage) ? '2 GB' : '0.5 GB',
  permissions: [
    {
      actions: ['*'],
      resources: ['*'],
    },
  ],
  logging: {
    retention: '3 days',
  },
  environment: {
    ...DEFAULT_LAMBDA_ENVIRONMENT,
  },
});

export const subscribeQueryRoute = websocketApi.route('subscribe_query', {
  handler: 'apps/client/server/websocket/dataSubscribeRequest.func',
  runtime: 'nodejs24.x',
  // 1024 MB matches agent_execute (agentExecutor.ts): the identical Node 24 + Mongoose + AWS SDK
  // cold-start stack OOM'd at 256 MB (fixed in PR #8449). This handler imports 15+ Mongoose models
  // on init, so it carried the same latent footgun. See issue #8655.
  memory: '1024 MB',
  vpc: lambdaVpc,
  // 60s (down from 600s): the handler does bounded work — fetch ≤200 docs (HARD_LIMIT) and fan
  // them out over the socket. API Gateway caps the WebSocket integration *response* at ~29s, but
  // the Lambda itself runs to its own timeout, so 60s bounds the actual work while still failing
  // an order of magnitude faster than 600s. A 600s timeout only let a struggling invocation hang
  // silently; the OOM alarms (alarms.ts) are the safety net for future regressions.
  timeout: '60 seconds',
  // Cap concurrent subscriptions so a reconnection storm can't saturate the account Lambda pool.
  // 200 slots handles ~40 new subscriptions/sec at 5s avg latency — enough for normal traffic.
  concurrency: PRODUCTION_STAGES.includes($app.stage) ? { reserved: 200 } : undefined,
  link: [...allSecrets, fabFileBucket, generatedImagesBucket, appFilesBucket, websocketApi],
  permissions: [
    {
      actions: ['execute-api:ManageConnections'],
      resources: ['*'],
    },
  ],
});

export const unsubscribeQueryRoute = websocketApi.route('unsubscribe_query', {
  handler: 'apps/client/server/websocket/dataUnsubscribeRequest.func',
  runtime: 'nodejs24.x',
  // 1024 MB matches subscribe_query — same Node 24 + Mongoose + AWS SDK cold-start stack (see #8655).
  memory: '1024 MB',
  vpc: lambdaVpc,
  // 30s (down from 600s): unsubscribe is lighter than subscribe — a single QuerySubscription
  // updateOne to pull the subscriber, no initial-data fan-out. Fail fast.
  timeout: '30 seconds',
  // Same cap as subscribe_query — reconnect storms generate paired un/subscribe floods.
  concurrency: PRODUCTION_STAGES.includes($app.stage) ? { reserved: 200 } : undefined,
  link: [...allSecrets, fabFileBucket, generatedImagesBucket, appFilesBucket, websocketApi],
  permissions: [
    {
      actions: ['execute-api:ManageConnections'],
      resources: ['*'],
    },
  ],
});
