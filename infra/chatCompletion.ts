import { appFilesBucket, fabFileBucket, generatedImagesBucket } from './buckets';
import { chatCompletionCapacity, chatCompletionScaling } from './chatCompletionCapacity';
import {
  DEFAULT_LAMBDA_ENVIRONMENT,
  isPreviewStage,
  PRODUCTION_STAGES,
  TEST_GENERATION_PROVIDER_ENVIRONMENT,
} from './constants';
import { ecsEnvSecret, ecsResourceSecrets, ecsSecretsVersion } from './ecsSecrets';
import { eventBus } from './eventBus';
import { imageProcessor } from './imageProcessor';
import { withDirectPathSourceIp } from './listenerRuleConditions';
import {
  PREVIEW_SHARED_STAGE_TAG,
  previewStageNumber,
  sharedRuleConditions,
  sharedRulePriorities,
} from './previewSharedChatOrigin';
import { mcpHandler } from './mcp';
import { remoteMcpHandler } from './remoteMcp';
import { providerFederation } from './providerFederation';
import { generationJobQueue } from './queues';
import {
  cdnUrlForLambdaEnv,
  domain,
  managedAppDomain,
  ORIGIN_VERIFY_HEADER,
  originVerifySecret,
  router,
  routePrefix,
} from './router';
import { searxngUrl } from './searxng';
import { allSecrets, contributedSecretEnvironment, secrets } from './secrets';
import { cluster, resolvedVpcId, vpc, vpcId } from './vpc';
import { websocketApi } from './websocket';
import { mailBodyEnvironment, mailBodyPutPermission } from './mailBodyOffload';

/**
 * Quest Processor Service
 *
 * Always-on Fargate service that processes chat-completion quests. Replaces the old
 * EventBridge → QuestProcessor Lambda. A long-running container has no cold start and
 * no 15-minute timeout ceiling on the steady-state path — the two problems that made
 * the Lambda path slow.
 *
 * Shutdown trade-off: on SIGTERM (deploy / scale-in / unhealthy-task replacement) in-flight
 * quests drain for up to DRAIN_TIMEOUT_MS (server.ts), which is set under this task's
 * stopTimeout; a quest still running is cut off. To keep scale-in and deploys off busy tasks, the
 * service sets ECS task scale-in protection while it has in-flight work (taskProtection.ts). It is
 * refreshed through a busy stretch up to a cap, which bounds how long one task can hold off a
 * deploy; a task busy past the cap falls back on the drain. The container removes the
 * cold-start + 15-min ceiling for normal processing, but not shutdown-time cancellation. The
 * drain only runs at all because the image makes node PID 1 with tsx as an in-process loader -
 * see Dockerfile.chatcompletion.
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
      'chat-completion image to ECR before `sst deploy` (see infra/deploy-contract.json). ' +
      'For local `sst dev` (no CI=true) a neutral public placeholder is used automatically.'
  );
}

// Delivered as ECS task secrets rather than SST_RESOURCE_* task environment entries; `sst dev`
// keeps the plain link because the dev command runs outside ECS.
const ecsSecretNames = [
  'MONGODB_URI',
  'JWT_SECRET',
  'SESSION_SECRET',
  'SECRET_ENCRYPTION_KEY',
  'SECRET_ENCRYPTION_KEY_PREVIOUS',
  'HMAC_SIGNING_SECRET',
  'HMAC_SIGNING_SECRET_PREVIOUS',
  'MEMORY_KEY_SECRET',
  'MEMORY_KEY_SECRET_PREVIOUS',
  'OAUTH_RSA_PRIVATE_KEY',
  'APNS_KEY',
  'FCM_SERVICE_ACCOUNT',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'CHAT_COMPLETION_INTERNAL_SECRET',
  'GOOGLE_CLIENT_SECRET',
  'GITHUB_CLIENT_SECRET',
  'APPLE_PRIVATE_KEY',
  'GITHUB_LAKE_APP_CLIENT_SECRET',
  'GITHUB_LAKE_APP_PRIVATE_KEY',
  'GITHUB_LAKE_APP_WEBHOOK_SECRET',
  'MAIL_PASSWORD',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_ADMIN_API_KEY',
  'TURNSTILE_SECRET_KEY',
  'GEMINI_API_KEY',
  'OPENAI_API_KEY',
  'OPENAI_ADMIN_API_KEY',
  'XAI_API_KEY',
  'MOONSHOT_API_KEY',
  'DEEPSEEK_API_KEY',
  'OKTA_CLIENT_SECRET',
  'NPM_TOKEN',
  'SLACK_SIGNING_SECRET',
  'SLACK_CLIENT_SECRET',
  'SECOPS_ZAP_DISPATCH_TOKEN',
  'SECOPS_ZAP_INGEST_TOKEN',
  'SECOPS_PROWLER_INGEST_TOKEN',
  'SECOPS_PROWLER_WORKFLOW_TOKEN',
  'SECOPS_ATTACK_SIMULATION_INGEST_TOKEN',
  'RATE_LIMIT_INGEST_TOKEN',
  'NCMEC_API_KEY',
  'E2E_CLEANUP_SECRET',
  'GA_SERVICE_ACCOUNT_KEY',
  'YOUTUBE_API_KEY',
  'LINKEDIN_CLIENT_SECRET',
  'OPTIHASHI_API_TOKEN',
  'OPTIHASHI_WEBHOOK_SECRET',
  'OPTIHASHI_WEBHOOK_SECRET_PREVIOUS',
  'OPTIHASHI_INSTANCE_SERVICE_TOKEN_PREVIOUS',
  'OVERWATCH_INGEST_KEY',
  'SLACK_WEBHOOK_URL',
  'SLACK_ERROR_REPORTING_WEBHOOK_URL',
  'SLACK_ALARMS_WEBHOOK_URL',
  'SLACK_COST_ALARMS_WEBHOOK_URL',
  'OVERWATCH_PRODUCT_INGEST_KEYS',
  'OVERWATCH_PSEUDONYM_SALT',
  'QA_ALARM_SLACK_WEBHOOKS',
] as const;
const ecsSecretResources: sst.Secret[] = [
  ...ecsSecretNames.map(n => secrets[n]),
  secrets.OPTIHASHI_INSTANCE_SERVICE_TOKEN,
];
const linkedSecrets = $dev ? allSecrets : allSecrets.filter(s => !ecsSecretResources.includes(s));
// PEM and service-account JSON sizes are operator-chosen and may exceed the 4 KB Standard tier limit.
const ecsAdvancedSecretNames = [
  'OAUTH_RSA_PRIVATE_KEY',
  'APPLE_PRIVATE_KEY',
  'GITHUB_LAKE_APP_PRIVATE_KEY',
  'GA_SERVICE_ACCOUNT_KEY',
];
// Same gate and kill switch as the frontend (infra/web.ts); not under `sst dev`.
const originVerifyEnabled = !$dev && process.env.DISABLE_ORIGIN_VERIFY !== 'true';
const ecsSecretGroups = $dev
  ? undefined
  : [
      ecsResourceSecrets('ChatCompletion', Object.fromEntries(ecsSecretNames.map(n => [n, secrets[n]])), {
        advanced: ecsAdvancedSecretNames,
      }),
      ecsEnvSecret(
        'ChatCompletion',
        'OPTIHASHI_INSTANCE_SERVICE_TOKEN',
        secrets.OPTIHASHI_INSTANCE_SERVICE_TOKEN.value
      ),
      ...(originVerifyEnabled
        ? [ecsEnvSecret('ChatCompletion', 'ORIGIN_VERIFY_SECRET', originVerifySecret.result)]
        : []),
    ];
const ecsSecretParameters = ecsSecretGroups && Object.assign({}, ...ecsSecretGroups.map(g => g.ssm));

// A certificate preview stages share instead of requesting one each (ACM caps yearly requests per
// region). It must cover `chat-origin-<SERVER_DOMAIN>`. See infra/preview-shared-origin-certificate.md.
const sharedOriginCertificateArn =
  isPreviewStage && !$dev ? process.env.PREVIEW_CHAT_ORIGIN_CERT_ARN || undefined : undefined;

// Host name the load balancer serves HTTPS on. It sits under the app host so its records land in
// the hosted zone the stage already writes to, or beside the stage domain when the shared
// certificate is in use. Stages where SST does not manage the app domain (no SERVER_DOMAIN, an
// operator-supplied certificate, `sst dev`) have none and forward on port 80.
function originDomainFor(appDomain: string) {
  return sharedOriginCertificateArn ? `chat-origin-${domain}` : `chat-origin.${appDomain}`;
}
const originDomain = !$dev && managedAppDomain ? originDomainFor(managedAppDomain) : undefined;

// A load balancer every preview shares instead of creating its own; the stage adds only a target group and
// host-based rules on its HTTPS listener. Needs the shared certificate's host name. See
// infra/preview-shared-chat-origin-alb.md.
const previewNumber = previewStageNumber($app.stage);
const sharedListenerArn =
  sharedOriginCertificateArn && originDomain && previewNumber !== undefined
    ? process.env.PREVIEW_CHAT_SHARED_LISTENER_ARN || undefined
    : undefined;
const originDns = sst.aws.dns({ override: true });

// Issued here instead of by the Service: the Service resolves its `url` only once every load
// balancer input has, so handing it the validated ARN keeps the router route and the frontend
// link on their current URL until the HTTPS listener can be created.
function issueOriginCertificate(domainName: string) {
  const certificate = new aws.acm.Certificate('ChatCompletionOriginCertificate', {
    domainName,
    validationMethod: 'DNS',
  });
  const validationRecords = certificate.domainValidationOptions.apply(options =>
    options.map(option =>
      originDns.createRecord(
        'ChatCompletionOriginCertificate',
        { type: option.resourceRecordType, name: option.resourceRecordName, value: option.resourceRecordValue },
        {}
      )
    )
  );
  return new aws.acm.CertificateValidation(
    'ChatCompletionOriginCertificateValidation',
    { certificateArn: certificate.arn },
    { dependsOn: validationRecords }
  ).certificateArn;
}
const originCertificateArn = originDomain
  ? (sharedOriginCertificateArn ?? issueOriginCertificate(originDomain))
  : undefined;

// NAT public IP(s) as /32 CIDRs: a managed NAT Gateway in the shared env VPC (VPC_ID set), or the
// EC2 NAT instance's Elastic IP in a self-provisioned VPC (VPC_ID unset). See infra/vpc.ts. Lazy
// because `sst dev` has no load balancer to use it.
let natEgressCidrsCache: $util.Output<string[]> | undefined;
function natEgressCidrs() {
  natEgressCidrsCache ??= vpcId
    ? aws.ec2
        .getNatGatewaysOutput({ filters: [{ name: 'vpc-id', values: [resolvedVpcId] }] })
        .ids.apply(ids => $util.all(ids.map(id => aws.ec2.getNatGatewayOutput({ id }).publicIp)))
        .apply(ips => ips.map(ip => `${ip}/32`))
    : vpc!.nodes.elasticIps.apply(eips => $util.all(eips.map(e => e.publicIp))).apply(ips => ips.map(ip => `${ip}/32`));
  return natEgressCidrsCache;
}

// Paths callers reach on the load balancer directly rather than through CloudFront: the quest
// dispatch (dispatchQuest.ts, from the frontend and worker Lambdas) and the status probe
// (pages/api/chat-completion-status.ts). Both leave through the VPC NAT.
const DIRECT_PATHS = ['/process', '/health'] as const;
const forwardListen = originDomain ? ('443/https' as const) : ('80/http' as const);

// With origin verification on, the forwarding listener has no unconditional rule, so SST gives it
// a fixed 403 default action. It forwards a request only when it carries this stage's CloudFront
// origin header (stamped in infra/router.ts), or when it is for a direct path and comes from the
// NAT egress IPs (added to those rules by the transform below). The container checks the same
// header again (apps/client/server/chatCompletion/originVerify.ts).
const forwardRules = originVerifyEnabled
  ? [
      {
        listen: forwardListen,
        forward: '8080/http' as const,
        // Unsecret so SST's rule normalization does not turn the whole load balancer config (and
        // the service URL derived from it) secret; the transform below re-secrets the condition.
        conditions: {
          header: { name: ORIGIN_VERIFY_HEADER, values: [$util.unsecret(originVerifySecret.result)] },
        },
      },
      ...DIRECT_PATHS.map(path => ({ listen: forwardListen, forward: '8080/http' as const, conditions: { path } })),
    ]
  : [{ listen: forwardListen, forward: '8080/http' as const }];

// SST names the listener rules it creates `ChatCompletionListener<protocol><port>Rule<hash>` and
// exposes no other handle on them. ALB rules accept at most five condition values, so a direct
// path rule fits up to four NAT IPs.
if (originVerifyEnabled) {
  $transform(aws.lb.ListenerRule, (args, _opts, name) => {
    if (!name.startsWith('ChatCompletionListener')) return;
    args.conditions = $util.secret(
      $util
        .all([args.conditions, natEgressCidrs()])
        .apply(([conditions, cidrs]) => withDirectPathSourceIp(conditions, cidrs))
    );
  });
}

function createSharedListenerTarget(listenerArn: string, host: string, prNumber: number) {
  const tags = { [PREVIEW_SHARED_STAGE_TAG]: $app.stage };
  const targetGroup = new aws.lb.TargetGroup('ChatCompletionSharedTarget', {
    // Target group names cap at 32 characters, too short for an autoname.
    namePrefix: 'chat-',
    port: 8080,
    protocol: 'HTTP',
    targetType: 'ip',
    vpcId: resolvedVpcId,
    healthCheck: {
      path: '/health',
      interval: 15,
      timeout: 5,
      healthyThreshold: 2,
      unhealthyThreshold: 5,
      matcher: '200',
    },
    tags,
  });
  const conditions = $util
    .all([originVerifyEnabled ? originVerifySecret.result : '', natEgressCidrs()])
    .apply(([secret, cidrs]) =>
      sharedRuleConditions({
        host,
        originVerify: originVerifyEnabled ? { header: ORIGIN_VERIFY_HEADER, value: secret } : undefined,
        directPaths: DIRECT_PATHS,
        natCidrs: cidrs,
      })
    );
  const priorities = sharedRulePriorities(prNumber);
  const forward = [{ type: 'forward', targetGroupArn: targetGroup.arn }];
  const rules = [
    new aws.lb.ListenerRule('ChatCompletionSharedRuleCloudfront', {
      listenerArn,
      priority: priorities.cloudfront,
      actions: forward,
      conditions: $util.secret(conditions.cloudfront),
      tags,
    }),
    ...(originVerifyEnabled
      ? [
          new aws.lb.ListenerRule('ChatCompletionSharedRuleDirect', {
            listenerArn,
            priority: priorities.direct,
            actions: forward,
            conditions: conditions.apply(c => c.direct ?? []),
            tags,
          }),
        ]
      : []),
  ];
  // ECS refuses a target group that no listener uses yet, so the service waits on the rules through this ARN.
  const attachedTargetGroupArn = $util.all([targetGroup.arn, ...rules.map(rule => rule.arn)]).apply(([arn]) => arn);
  return { attachedTargetGroupArn, rules };
}

const sharedListenerTarget =
  sharedListenerArn && originDomain && previewNumber !== undefined
    ? createSharedListenerTarget(sharedListenerArn, originDomain, previewNumber)
    : undefined;

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
  // The forwarding listener's rules (forwardRules above) then admit only CloudFront requests that
  // carry this stage's origin header, plus the direct paths from the NAT IPs.
  // With an origin domain the service URL is https://<originDomain>/, so both callers use the
  // HTTPS listener. Port 80 has a redirect action but is blocked by the security group below.
  // In shared mode the stage has no load balancer of its own (createSharedListenerTarget above).
  loadBalancer: sharedListenerTarget
    ? undefined
    : {
        public: true,
        ...(originDomain && originCertificateArn
          ? { domain: { name: originDomain, cert: originCertificateArn, dns: false } }
          : {}),
        rules: originDomain ? [...forwardRules, { listen: '80/http', redirect: '443/https' }] : forwardRules,
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
  scaling: chatCompletionScaling(isProd),
  capacity: chatCompletionCapacity(isPreviewStage),
  link: [
    ...linkedSecrets,
    fabFileBucket,
    generatedImagesBucket,
    appFilesBucket,
    websocketApi,
    mcpHandler,
    // Custom (user-supplied URL) connector calls from queued chat turns run here, outside the VPC.
    remoteMcpHandler,
    eventBus,
    imageProcessor,
    generationJobQueue,
  ],
  ssm: ecsSecretParameters,
  permissions: [
    mailBodyPutPermission(appFilesBucket),
    { actions: ['bedrock:*'], resources: ['*'] },
    // Content moderation for images produced by the image_generation/edit_image tools
    // (closes an agent-tool moderation bypass; the queue-handler imageGeneration/
    // imageEdit queues already have this).
    { actions: ['rekognition:DetectModerationLabels'], resources: ['*'] },
    // Stream quest updates back to clients over the WebSocket management API.
    { actions: ['execute-api:ManageConnections'], resources: ['*'] },
    // CompletionCompleted (memento) + AutoName events still go through EventBridge.
    { actions: ['events:PutEvents'], resources: ['*'] },
    // Lumina5/ModelSunset (deprecated model pins) and Lumina5/AnthropicAPI (rate limits)
    // are emitted from llm-adapters on this path. PutMetricData takes no resource scope.
    { actions: ['cloudwatch:PutMetricData'], resources: ['*'] },
    // Scale-in protection while quests are in flight, set through the ECS agent endpoint
    // (apps/client/server/chatCompletion/taskProtection.ts), which signs with the task role.
    { actions: ['ecs:UpdateTaskProtection'], resources: ['*'] },
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
    ...providerFederation.permissions,
  ],
  environment: {
    // First, so a core variable of the same name always wins.
    ...contributedSecretEnvironment(),
    ...DEFAULT_LAMBDA_ENVIRONMENT,
    ...mailBodyEnvironment(appFilesBucket),
    ...TEST_GENERATION_PROVIDER_ENVIRONMENT,
    NEXT_PUBLIC_CDN_URL: cdnUrlForLambdaEnv(),
    // External instance-service, consumed by a premium overlay tool that reads these as
    // plain env (linking alone only exposes SST_RESOURCE_*). URL + bearer resolve from
    // secrets; both default 'not-configured', so the consumer degrades to its fallback
    // until ops sets them. No dependency on the service resource (which is created later)
    // — the URL is a secret, sidestepping any creation-order coupling.
    OPTIHASHI_INSTANCE_SERVICE_URL: secrets.OPTIHASHI_INSTANCE_SERVICE_URL.value,
    ...($dev ? { OPTIHASHI_INSTANCE_SERVICE_TOKEN: secrets.OPTIHASHI_INSTANCE_SERVICE_TOKEN.value } : {}),
    ...(ecsSecretGroups ? { ECS_SECRETS_VERSION: ecsSecretsVersion(...ecsSecretGroups) } : {}),
    // Internal SearXNG (infra/searxng.ts), only where it is deployed. Set only on the VPC Lambdas
    // that run web search (also infra/agentExecutor.ts, infra/queues.ts); the URL resolves only
    // inside the VPC.
    ...(searxngUrl ? { SEARXNG_BASE_URL: searxngUrl } : {}),
    ...providerFederation.environment,
  },
  logging: {
    // Long enough to investigate a model-fallback or billing report after the fact; these
    // are usually raised days later, well past a short retention window.
    retention: '1 month',
  },
  // Raise stopTimeout to the Fargate max so the drain window fits under it before SIGKILL.
  // SST's Service args don't expose the container `stopTimeout`, so inject it into the task
  // definition. 120s is the Fargate maximum; DRAIN_TIMEOUT_MS in server.ts (110s) sits under
  // it, leaving ~10s of margin so the drain-expiry error can log before SIGKILL. Without this
  // transform ECS defaults to 30s and a deploy would hard-kill long quests.
  transform: {
    ...(sharedListenerTarget
      ? {
          service: (args: aws.ecs.ServiceArgs) => {
            args.loadBalancers = [
              {
                targetGroupArn: sharedListenerTarget.attachedTargetGroupArn,
                containerName: 'ChatCompletion',
                containerPort: 8080,
              },
            ];
          },
        }
      : {}),
    taskDefinition: args => {
      args.containerDefinitions = $output(args.containerDefinitions).apply(json => {
        const defs = JSON.parse(json) as Array<Record<string, unknown>>;
        for (const def of defs) def.stopTimeout = 120;
        return JSON.stringify(defs);
      });
    },
    // Lock the public ALB's ingress to its two legitimate sources so /process is NOT reachable
    // from the open internet (defense-in-depth on top of the CHAT_COMPLETION_INTERNAL_SECRET
    // bearer). SST's default SG opens 0.0.0.0/0; replace its ingress with the forwarding port from:
    //   1. CloudFront's origin-facing edge IPs -> /api/ai/v1/completions (the only route CloudFront
    //      forwards here; CF fronts WAF at the edge).
    //   2. The VPC NAT egress IP -> the frontend Lambda's /process dispatch (it hairpins out through
    //      NAT to the ALB's public DNS - see the loadBalancer note above).
    // Health checks hit the tasks on 8080 via a separate SG rule, so they are unaffected.
    loadBalancerSecurityGroup: sgArgs => {
      const cloudfrontPrefixListId = aws.ec2.getManagedPrefixListOutput({
        name: 'com.amazonaws.global.cloudfront.origin-facing',
      }).id;
      const natCidrs = natEgressCidrs();

      // Only the port that forwards is admitted. The CloudFront prefix list counts its full entry
      // limit against the group's rule quota for every rule that references it, so a second rule
      // per source would not fit.
      const forwardingPort = originDomain ? 443 : 80;
      sgArgs.ingress = $util.all([cloudfrontPrefixListId, natCidrs]).apply(([plId, cidrs]) => [
        {
          protocol: 'tcp',
          fromPort: forwardingPort,
          toPort: forwardingPort,
          prefixListIds: [plId],
          description: 'CloudFront edge to public /api/ai/v1/completions',
        },
        {
          protocol: 'tcp',
          fromPort: forwardingPort,
          toPort: forwardingPort,
          cidrBlocks: cidrs,
          description: 'VPC NAT egress to internal /process dispatch',
        },
      ]);
      // egress left at SST's default (0.0.0.0/0): the ALB must reach the tasks.
    },
    // The provider default policy still negotiates TLS 1.0 and 1.1.
    listener: listenerArgs => {
      if (listenerArgs.protocol === 'HTTPS') listenerArgs.sslPolicy = 'ELBSecurityPolicy-TLS13-1-2-2021-06';
    },
  },
  // Local `sst dev`: run the server directly with tsx instead of building the image. Same
  // in-process loader as the image CMD (no pnpm wrapper) so local SIGTERM behaves the same.
  // The server defaults to port 8788 locally (8080 is commonly taken - e.g. Docker
  // Desktop binds host :8080 - which caused `EADDRINUSE :::8080`). The cloud container
  // still listens on 8080 (Dockerfile ENV PORT=8080, the ALB forwards to it). dev.url must
  // match the local port so the frontend's dispatchQuest reaches the local server.
  dev: {
    command: 'node --import tsx server/chatCompletion/server.ts',
    directory: 'apps/client',
    url: 'http://localhost:8788',
  },
});

// The alias record is created here, not by the Service (`dns: false` above), so the routes can
// wait for it: the returned URL resolves only once the origin name points at the load balancer.
// Until then the name is answered by the app host's wildcard record. Shared mode keeps the same
// record name, so switching a preview over updates the record in place instead of replacing it.
function routableOriginUrl(
  domainName: string,
  target: { dnsName: $util.Input<string>; zoneId: $util.Input<string> },
  url: $util.Input<string>
) {
  const aliasRecords = originDns.createAlias(
    'ChatCompletionOrigin',
    { name: domainName, aliasName: target.dnsName, aliasZone: target.zoneId },
    {}
  );
  return $util.all([url, ...aliasRecords.map(record => record.id)]).apply(([resolved]) => resolved);
}

function sharedRoutableOriginUrl(listenerArn: string, domainName: string, rules: aws.lb.ListenerRule[]) {
  const listener = aws.lb.getListenerOutput({ arn: listenerArn });
  const loadBalancer = aws.lb.getLoadBalancerOutput({ arn: listener.loadBalancerArn });
  const ready = $util.all(rules.map(rule => rule.arn)).apply(() => `https://${domainName}/`);
  return routableOriginUrl(domainName, loadBalancer, ready);
}

/**
 * Origin URL of the shared preview load balancer, set on the frontend as CHAT_COMPLETION_ORIGIN_URL because a
 * Service without its own load balancer links no `url` (apps/client/server/utils/chatCompletionBaseUrl.ts).
 */
export const chatCompletionSharedOriginUrl =
  sharedListenerArn && originDomain && sharedListenerTarget
    ? sharedRoutableOriginUrl(sharedListenerArn, originDomain, sharedListenerTarget.rules)
    : undefined;

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
  // CloudFront terminates viewer TLS at the edge and connects to the public ALB with the scheme
  // of `chatCompletion.url`: https where the stage has an origin domain, http otherwise (the ALB
  // forwards to container :8080 either way). Only this path is routed through CloudFront;
  // /process is reachable only via the ALB directly. routePrefix namespaces the path per-stage
  // on the shared dev distribution (empty on deployed dev/production). Guarded on !$dev because
  // the load balancer (and thus `.url`) only exists when the Service runs in the cloud - under
  // `sst dev` it runs via dev.command with no ALB, and the CLI reaches it on localhost:8788.
  const originUrl =
    chatCompletionSharedOriginUrl ??
    (originDomain
      ? routableOriginUrl(originDomain, chatCompletion.nodes.loadBalancer, chatCompletion.url)
      : chatCompletion.url);
  router.route(`${routePrefix}/api/ai/v1/completions`, originUrl);

  // Public embed chat endpoint (epic #41 Phase B). Same always-on origin as the
  // completions routes, so it inherits their all-viewer forwarding: the browser
  // Origin header and the OPTIONS preflight reach the container (the route sets
  // its own per-origin CORS), and the SSE stream is not cached. Only the chat
  // path is on this origin; /api/embed/session is a normal Next app route.
  router.route(`${routePrefix}/api/embed/chat`, originUrl);

  // Public session turns endpoint (sessionTurns.contract.ts): an SSE stream of a turn run in this
  // service. A top-level path because routing is by prefix and Next serves /api/v1/sessions/*.
  router.route(`${routePrefix}/api/v1/turns`, originUrl);

  // The shared preview load balancer's equivalent rule is owned with that load balancer.
  if (!sharedListenerTarget) {
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
}
