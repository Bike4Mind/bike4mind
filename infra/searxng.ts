import { PRODUCTION_STAGES } from './constants';
import { cluster, resolvedVpcId } from './vpc';

/**
 * SearXNG web-search backend
 *
 * Internal-only Fargate service the web_search tool uses alongside SerpAPI. Provider order is
 * decided by the `WebSearchProvider` admin setting (b4m-core/.../websearch/providers.ts): with
 * both configured, the lead answers and the other is hedged in as a backup. Note that `auto`
 * leads with SearXNG once SEARXNG_BASE_URL is set, so an admin who wants SerpAPI to stay in
 * front sets `WebSearchProvider=serpapi`.
 *
 * Reachability: no load balancer. The task registers an A record in a per-stage private Cloud
 * Map namespace, and its own SG admits :8080 from inside the VPC only. The cluster's Cloud Map
 * config is not used because the shared env VPC (VPC_ID) has none, and adding one to the cluster
 * would re-register every existing service.
 *
 * Image: the deploy pipeline builds infra/searxng/Dockerfile (SearXNG pinned by digest + the
 * shared selfhost/searxng/settings.yml) and exports the URI as SEARXNG_IMAGE, per
 * infra/deploy-contract.json. Unlike chatCompletion/subscriberFanout this does not throw when
 * the image is missing: search still works on SerpAPI alone, so a missing image skips the
 * service instead of failing the whole deploy.
 *
 * Deployed only on the two real hosted stages (production, dev/staging) -- PRODUCTION_STAGES,
 * not merely "not a preview and not sst dev". That excludes shared-dev (a router-only stage,
 * infra/router.ts) and any ad-hoc personal `sst deploy --stage <name>`, which a broader check
 * would otherwise also stand this service up on.
 */
const searxngImage = process.env.SEARXNG_IMAGE;
const isHostedStage = !$dev && PRODUCTION_STAGES.includes($app.stage);
const enabled = isHostedStage && !!searxngImage;

if (isHostedStage && !searxngImage && process.env.CI === 'true') {
  console.warn('SEARXNG_IMAGE is not set; skipping the SearXNG service (web_search runs on SerpAPI only).');
}

const SEARXNG_PORT = 8080;

function createSearxng() {
  const namespace = new aws.servicediscovery.PrivateDnsNamespace('SearxngNamespace', {
    name: `${$app.stage}.${$app.name}.internal`,
    vpc: resolvedVpcId,
    description: 'Private discovery for internal web-search backends',
  });

  const discovery = new aws.servicediscovery.Service('SearxngDiscovery', {
    name: 'searxng',
    namespaceId: namespace.id,
    forceDestroy: true,
    dnsConfig: {
      namespaceId: namespace.id,
      routingPolicy: 'MULTIVALUE',
      dnsRecords: [{ ttl: 10, type: 'A' }],
    },
  });

  // Dedicated per-stage SG rather than a rule on the shared `default` SG: several stages share
  // that SG, and identical self-referencing rules from each stage would collide.
  //
  // cidrBlock is the VPC's primary CIDR only -- if this VPC ever gains a secondary CIDR
  // association, instances on it would not match this ingress rule.
  const vpcCidr = aws.ec2.getVpcOutput({ id: resolvedVpcId }).cidrBlock;
  const taskSecurityGroup = new aws.ec2.SecurityGroup('SearxngTask', {
    vpcId: resolvedVpcId,
    description: 'SearXNG task: :8080 from inside the VPC only',
    ingress: [
      {
        protocol: 'tcp',
        fromPort: SEARXNG_PORT,
        toPort: SEARXNG_PORT,
        cidrBlocks: [vpcCidr],
        description: 'In-VPC callers (ChatCompletion) to SearXNG',
      },
    ],
    // Outbound to the upstream search engines via NAT.
    egress: [{ protocol: '-1', fromPort: 0, toPort: 0, cidrBlocks: ['0.0.0.0/0'] }],
  });

  new sst.aws.Service('Searxng', {
    cluster,
    image: searxngImage!,
    cpu: '0.25 vCPU',
    memory: '0.5 GB',
    environment: {
      // SearXNG maps this onto server.secret_key at load (see compose.selfhost.yaml).
      SEARXNG_SECRET: new random.RandomPassword('SearxngSecret', { length: 48, special: false }).result,
    },
    health: {
      command: ['CMD-SHELL', `wget -q --spider http://localhost:${SEARXNG_PORT}/healthz || exit 1`],
      startPeriod: '30 seconds',
      interval: '30 seconds',
      timeout: '5 seconds',
      retries: 3,
    },
    logging: {
      retention: '3 days',
    },
    transform: {
      service: args => {
        args.serviceRegistries = { registryArn: discovery.arn };
        args.networkConfiguration = $util
          .all([args.networkConfiguration, taskSecurityGroup.id])
          .apply(([network, sgId]) => ({ ...network!, securityGroups: [sgId] }));
      },
    },
  });

  return $interpolate`http://searxng.${namespace.name}:${SEARXNG_PORT}`;
}

/** Base URL for SEARXNG_BASE_URL, or undefined when the service is not deployed on this stage. */
export const searxngUrl = enabled ? createSearxng() : undefined;

// Visible in deploy output so an admin can confirm the wired URL, or copy it into the
// SearxngUrl admin setting to point at a different instance than the one this stage deployed.
searxngUrl?.apply(url => console.log(`SearXNG internal URL: ${url}`));
