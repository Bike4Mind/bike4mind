import { appFilesBucket, fabFileBucket, generatedImagesBucket } from './buckets';
import { DEFAULT_LAMBDA_ENVIRONMENT, PRODUCTION_STAGES } from './constants';
import { eventBus } from './eventBus';
import { imageProcessor } from './imageProcessor';
import { mcpHandler } from './mcp';
import { cdnUrlForLambdaEnv, router, routePrefix } from './router';
import { allSecrets } from './secrets';
import { cluster, resolvedVpcId, vpc, vpcId } from './vpc';
import { websocketApi } from './websocket';

/**
 * Quest Processor Service
 *
 * Always-on Fargate service that processes chat-completion quests. Replaces the old
 * EventBridge → QuestProcessor Lambda. A long-running container has no cold start and
 * no 15-minute timeout ceiling on the steady-state path — the two problems that made
 * the Lambda path slow.
 *
 * Shutdown trade-off: on SIGTERM (deploy / scale-in / unhealthy-task replacement) the
 * task drains in-flight quests for up to `stopTimeout` (120s, the ECS Fargate ceiling)
 * before SIGKILL. A quest still running past that window is cut off — so the container
 * removes the cold-start + 15-min ceiling for normal processing, but does not make
 * shutdown-time cancellation free. The drain window in server.ts is kept in lock-step
 * with the stopTimeout set below.
 *
 * Ingress: the frontend (`/api/ai/llm`, `/api/chat`) POSTs the QuestStartBody to this
 * service's load balancer and gets a 202 back immediately; the service processes the quest
 * in-process and streams results over the existing WebSocket path. The ALB is internet-facing
 * (CloudFront needs a public origin for the completions path) but its SG ingress is locked to
 * CloudFront + the VPC NAT egress IP, so /process is not reachable from the open internet.
 *
 * Links/permissions mirror the old Lambda so `processQuest`'s static options resolve
 * identically (DB repos, storage, websocket management endpoint, MCP handler, etc.).
 */
const isProd = PRODUCTION_STAGES.includes($app.stage);

// Image source: the deploy workflow builds `apps/client/Dockerfile.chatcompletion` with a
// plain `docker build` and pushes it to the target account's ECR, then references it here
// by URI via CHAT_COMPLETION_IMAGE. This keeps `sst deploy` build-free (same pattern as
// subscriberFanout) and — critically — avoids SST's docker-build provider booting a
// `buildx_buildkit` builder container, which times out on the self-hosted deploy runner
// (`booting builder: … context deadline exceeded`). CI must set it (throws otherwise). For
// local `sst dev` the Service runs via `dev.command` (tsx) and the image is never pulled, so
// a neutral public placeholder keeps the SST graph valid without a build.
const LOCAL_PLACEHOLDER_IMAGE = 'public.ecr.aws/docker/library/busybox:latest';
const isCI = process.env.CI === 'true';
const chatCompletionImage = process.env.CHAT_COMPLETION_IMAGE || (isCI ? '' : LOCAL_PLACEHOLDER_IMAGE);
if (isCI && !chatCompletionImage) {
  throw new Error(
    'CHAT_COMPLETION_IMAGE must be set in CI — the deploy workflow builds & pushes the ' +
      'chat-completion image to ECR before `sst deploy` (see .github/workflows/_deploy-env.yml). ' +
      'For local `sst dev` (no CI=true) a neutral public placeholder is used automatically.'
  );
}

export const chatCompletion = new sst.aws.Service('ChatCompletion', {
  cluster,
  // Prebuilt image referenced by URI (built & pushed by CI — see note above). Building
  // out-of-band keeps `sst deploy` build-free, matching subscriberFanout.
  image: chatCompletionImage,
  // Internet-facing load balancer. Must be public so CloudFront can reach it as an origin:
  // the completions endpoint (/api/ai/v1/completions) is served via the shared CloudFront
  // router (route below), and SST's router uses a standard custom origin - CloudFront's edge
  // connects to the ALB's public DNS over the internet, so an `internal` ALB is unreachable.
  // /process rides the same ALB (NOT routed through CloudFront). To keep /process off the open
  // internet despite the public ALB, its SG ingress is locked (transform.loadBalancerSecurityGroup
  // below) to exactly CloudFront's edge (completions) + the VPC NAT egress IP (the frontend
  // Lambda's /process dispatch, which hairpins out through NAT to the ALB's public DNS). The
  // CHAT_COMPLETION_INTERNAL_SECRET bearer checked in internal/route.ts is then defense-in-depth.
  loadBalancer: {
    public: true,
    rules: [{ listen: '80/http', forward: '8080/http' }],
    health: {
      '8080/http': {
        path: '/health',
        interval: '15 seconds',
        timeout: '5 seconds',
        healthyThreshold: 2,
        unhealthyThreshold: 5,
      },
    },
  },
  // Match the old Lambda's compute (2048 MB ≈ 1 vCPU on Fargate). 0.5 vCPU needs 1–4 GB;
  // 1 vCPU needs 2–8 GB — both combos below are valid Fargate sizes.
  cpu: isProd ? '1 vCPU' : '0.5 vCPU',
  memory: isProd ? '2 GB' : '1 GB',
  scaling: isProd ? { min: 2, max: 6, cpuUtilization: 70 } : { min: 1, max: 2 },
  link: [
    ...allSecrets,
    fabFileBucket,
    generatedImagesBucket,
    appFilesBucket,
    websocketApi,
    mcpHandler,
    eventBus,
    imageProcessor,
  ],
  permissions: [
    { actions: ['bedrock:*'], resources: ['*'] },
    // Content moderation for images produced by the image_generation/edit_image tools
    // (closes an agent-tool moderation bypass; the queue-handler imageGeneration/
    // imageEdit queues already have this).
    { actions: ['rekognition:DetectModerationLabels'], resources: ['*'] },
    // Stream quest updates back to clients over the WebSocket management API.
    { actions: ['execute-api:ManageConnections'], resources: ['*'] },
    // CompletionCompleted (memento) + AutoName events still go through EventBridge.
    { actions: ['events:PutEvents'], resources: ['*'] },
    {
      actions: [
        'transcribe:StartTranscriptionJob',
        'transcribe:GetTranscriptionJob',
        'transcribe:ListTranscriptionJobs',
        'transcribe:DeleteTranscriptionJob',
      ],
      resources: ['*'],
    },
    {
      actions: ['aws-marketplace:ViewSubscriptions', 'aws-marketplace:Subscribe', 'aws-marketplace:Unsubscribe'],
      resources: ['*'],
    },
  ],
  environment: {
    ...DEFAULT_LAMBDA_ENVIRONMENT,
    NEXT_PUBLIC_CDN_URL: cdnUrlForLambdaEnv(),
  },
  logging: {
    retention: '3 days',
  },
  // Give in-flight quests the full ECS-allowed grace period to drain on SIGTERM before
  // SIGKILL. SST's Service args don't expose the container `stopTimeout`, so inject it
  // into the task definition's containerDefinitions JSON. 120s is the Fargate maximum and
  // matches DRAIN_TIMEOUT_MS in server.ts. Without this, ECS defaults to 30s and a deploy
  // would hard-kill long quests — the same cut-off the service is meant to avoid.
  transform: {
    taskDefinition: args => {
      args.containerDefinitions = $output(args.containerDefinitions).apply(json => {
        const defs = JSON.parse(json) as Array<Record<string, unknown>>;
        for (const def of defs) def.stopTimeout = 120;
        return JSON.stringify(defs);
      });
    },
    // Lock the public ALB's ingress to its two legitimate sources so /process is NOT reachable
    // from the open internet (defense-in-depth on top of the CHAT_COMPLETION_INTERNAL_SECRET
    // bearer). SST's default SG opens 0.0.0.0/0; replace its ingress on the listener port with:
    //   1. CloudFront's origin-facing edge IPs -> /api/ai/v1/completions (the only route CloudFront
    //      forwards here; CF terminates TLS + fronts WAF at the edge).
    //   2. The VPC NAT egress IP -> the frontend Lambda's /process dispatch (it hairpins out through
    //      NAT to the ALB's public DNS - see the loadBalancer note above).
    // Health checks hit the tasks on 8080 via a separate SG rule, so they are unaffected.
    loadBalancerSecurityGroup: sgArgs => {
      const cloudfrontPrefixListId = aws.ec2.getManagedPrefixListOutput({
        name: 'com.amazonaws.global.cloudfront.origin-facing',
      }).id;

      // NAT public IP(s): a managed NAT Gateway in the shared env VPC (VPC_ID set), or the EC2
      // NAT instance's Elastic IP in a self-provisioned VPC (VPC_ID unset). See infra/vpc.ts.
      const natCidrs = vpcId
        ? aws.ec2
            .getNatGatewaysOutput({ filters: [{ name: 'vpc-id', values: [resolvedVpcId] }] })
            .ids.apply(ids => $util.all(ids.map(id => aws.ec2.getNatGatewayOutput({ id }).publicIp)))
            .apply(ips => ips.map(ip => `${ip}/32`))
        : vpc!.nodes.elasticIps
            .apply(eips => $util.all(eips.map(e => e.publicIp)))
            .apply(ips => ips.map(ip => `${ip}/32`));

      sgArgs.ingress = $util.all([cloudfrontPrefixListId, natCidrs]).apply(([plId, cidrs]) => [
        {
          protocol: 'tcp',
          fromPort: 80,
          toPort: 80,
          prefixListIds: [plId],
          description: 'CloudFront edge -> public /api/ai/v1/completions',
        },
        {
          protocol: 'tcp',
          fromPort: 80,
          toPort: 80,
          cidrBlocks: cidrs,
          description: 'VPC NAT egress -> internal /process dispatch',
        },
      ]);
      // egress left at SST's default (0.0.0.0/0): the ALB must reach the tasks.
    },
  },
  // Local `sst dev`: run the server directly with tsx instead of building the image.
  // The server defaults to port 8788 locally (8080 is commonly taken — e.g. Docker
  // Desktop binds host :8080 — which caused `EADDRINUSE :::8080`). The cloud container
  // still listens on 8080 (Dockerfile ENV PORT=8080, ALB forwards 80→8080). dev.url must
  // match the local port so the frontend's dispatchQuest reaches the local server.
  dev: {
    command: 'pnpm exec tsx server/chatCompletion/server.ts',
    directory: 'apps/client',
    url: 'http://localhost:8788',
  },
});

// Allow the service's internal ALB to reach the task on the container port (8080).
// The cluster pins the VPC's shared `default` security group for tasks (see infra/vpc.ts),
// which has no ingress for 8080 — so the ALB's health checks time out, the target is marked
// unhealthy, and ECS restart-loops the task (quests then never get dispatched). SST doesn't
// add this rule because the `default` SG is user-provided, not SST-managed. Source is the
// ALB's own (per-stage, SST-created) SG, so each stage adds a distinct rule and there's no
// conflict on the shared `default` SG. Guarded on !$dev: in `sst dev` the Service runs via
// dev.command with no load balancer, and accessing nodes.loadBalancer would throw.
if (!$dev) {
  // Expose the CLI/3rd-party completions endpoint under the bike4mind domain via the shared
  // CloudFront router (same distribution as the app). This replaced the former `cliLlmHandler`
  // Lambda, which owned this same `/api/ai/v1/completions` path and has been removed.
  // CloudFront terminates TLS at the edge and forwards to the public ALB over http (:80 ->
  // container :8080). Only this path is routed through CloudFront; /process is reachable only
  // via the ALB directly. routePrefix namespaces the path per-stage on the shared dev
  // distribution (empty on deployed dev/production). Guarded on !$dev because the load balancer
  // (and thus `.url`) only exists when the Service runs in the cloud - under `sst dev` it runs
  // via dev.command with no ALB, and the CLI reaches it on localhost:8788.
  router.route(`${routePrefix}/api/ai/v1/completions`, chatCompletion.url);

  const defaultSecurityGroupId = aws.ec2
    .getSecurityGroupsOutput({
      filters: [
        { name: 'vpc-id', values: [resolvedVpcId] },
        { name: 'group-name', values: ['default'] },
      ],
    })
    .ids.apply(ids => ids[0]);

  new aws.ec2.SecurityGroupRule('ChatCompletionAlbToTask', {
    type: 'ingress',
    protocol: 'tcp',
    fromPort: 8080,
    toPort: 8080,
    securityGroupId: defaultSecurityGroupId,
    sourceSecurityGroupId: chatCompletion.nodes.loadBalancer.securityGroups.apply(sgs => sgs[0]),
    description: 'ChatCompletion ALB to task :8080 (health checks + traffic)',
  });
}
