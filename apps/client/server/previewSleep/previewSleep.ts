import {
  ApplicationAutoScalingClient,
  DescribeScalableTargetsCommand,
  RegisterScalableTargetCommand,
} from '@aws-sdk/client-application-auto-scaling';
import { DescribeServicesCommand, ECSClient, type Service } from '@aws-sdk/client-ecs';
import { DescribeTargetHealthCommand, ElasticLoadBalancingV2Client } from '@aws-sdk/client-elastic-load-balancing-v2';
import { Resource } from 'sst';

const SCALABLE_DIMENSION = 'ecs:service:DesiredCount';

interface PreviewSleepTarget {
  label: string;
  /** `service/<cluster>/<service>`, as Application Auto Scaling names an ECS target. */
  resourceId: string;
  min: number;
  max: number;
}

export interface PreviewSleepServiceStatus {
  label: string;
  running: number;
  desired: number;
}

export interface PreviewSleepStatus {
  asleep: boolean;
  waking: boolean;
  services: PreviewSleepServiceStatus[];
}

// Set only on preview stages by infra/previewSleep.ts; production is refused even if it leaks there.
export const isPreviewSleepEnabled = (): boolean =>
  process.env.PREVIEW_SLEEP_ENABLED === 'true' && Resource.App.stage !== 'production';

const readTargets = (): PreviewSleepTarget[] => {
  const raw = process.env.PREVIEW_SLEEP_TARGETS;
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (t): t is PreviewSleepTarget =>
      typeof t?.label === 'string' &&
      typeof t?.resourceId === 'string' &&
      /^service\/[^/]+\/[^/]+$/.test(t.resourceId) &&
      Number.isInteger(t?.min) &&
      Number.isInteger(t?.max)
  );
};

const splitResourceId = (resourceId: string) => {
  const [, cluster, service] = resourceId.split('/');
  return { cluster, service };
};

let autoScaling: ApplicationAutoScalingClient | undefined;
let ecs: ECSClient | undefined;
let elb: ElasticLoadBalancingV2Client | undefined;
const autoScalingClient = () => (autoScaling ??= new ApplicationAutoScalingClient({}));
const ecsClient = () => (ecs ??= new ECSClient({}));
const elbClient = () => (elb ??= new ElasticLoadBalancingV2Client({}));

// A woken task is RUNNING ~30s before its ALB target is healthy, and a desired-count change starts
// no new deployment (rolloutState stays COMPLETED), so readiness is target health per target group.
const isServiceReady = async (svc: Service | undefined): Promise<boolean> => {
  const desired = svc?.desiredCount ?? 0;
  if (desired === 0) return true;
  const primary = svc?.deployments?.find(d => d.status === 'PRIMARY');
  if (primary?.rolloutState === 'IN_PROGRESS') return false;
  const groups = (svc?.loadBalancers ?? []).flatMap(lb => (lb.targetGroupArn ? [lb.targetGroupArn] : []));
  for (const TargetGroupArn of new Set(groups)) {
    const { TargetHealthDescriptions = [] } = await elbClient().send(
      new DescribeTargetHealthCommand({ TargetGroupArn })
    );
    const healthy = TargetHealthDescriptions.filter(t => t.TargetHealth?.State === 'healthy').length;
    if (healthy < desired) return false;
  }
  return true;
};

export async function getPreviewSleepStatus(): Promise<PreviewSleepStatus> {
  const targets = readTargets();
  if (targets.length === 0) return { asleep: false, waking: false, services: [] };

  const { ScalableTargets = [] } = await autoScalingClient().send(
    new DescribeScalableTargetsCommand({
      ServiceNamespace: 'ecs',
      ScalableDimension: SCALABLE_DIMENSION,
      ResourceIds: targets.map(t => t.resourceId),
    })
  );
  const bounds = new Map(ScalableTargets.map(t => [t.ResourceId, t]));

  const services = await Promise.all(
    targets.map(
      async ({
        label,
        resourceId,
      }): Promise<PreviewSleepServiceStatus & { min: number; max: number; ready: boolean }> => {
        const { cluster, service } = splitResourceId(resourceId);
        const { services: found = [] } = await ecsClient().send(
          new DescribeServicesCommand({ cluster, services: [service] })
        );
        const bound = bounds.get(resourceId);
        return {
          label,
          running: found[0]?.runningCount ?? 0,
          desired: found[0]?.desiredCount ?? 0,
          min: bound?.MinCapacity ?? 0,
          max: bound?.MaxCapacity ?? 0,
          ready: await isServiceReady(found[0]),
        };
      }
    )
  );

  // A target missing from DescribeScalableTargets reads as max 0, so a half-registered stage
  // still offers a wake rather than hiding the banner.
  const asleep = services.some(s => s.max === 0);
  const waking = !asleep && services.some(s => s.min > 0 && (s.running < Math.max(s.desired, s.min) || !s.ready));
  return { asleep, waking, services: services.map(({ label, running, desired }) => ({ label, running, desired })) };
}

/** Restores every target to its deployed awake bounds; takes no caller input. */
export async function wakePreview(): Promise<void> {
  for (const { resourceId, min, max } of readTargets()) {
    await autoScalingClient().send(
      new RegisterScalableTargetCommand({
        ServiceNamespace: 'ecs',
        ScalableDimension: SCALABLE_DIMENSION,
        ResourceId: resourceId,
        MinCapacity: min,
        MaxCapacity: max,
      })
    );
  }
}
