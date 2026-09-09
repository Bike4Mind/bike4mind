/**
 * Pure spec builder for the per-ECS-service "no running tasks" CloudWatch alarm.
 *
 * Why this alarm exists, and why it is shaped so oddly: ECS publishes the
 * AWS/ECS utilization metrics only while at least one task is running. A service
 * sitting at running=0 therefore emits nothing at all, so a conventional
 * utilization threshold alarm (including the target-tracking alarms Application
 * Auto Scaling creates for you) parks in INSUFFICIENT_DATA and never fires. That
 * is the blind spot: the louder the outage, the quieter the metric.
 *
 * So the alarm is driven purely by data ABSENCE. `treatMissingData: 'breaching'`
 * turns each empty period into a breach, and the threshold is chosen so that any
 * real datapoint fails the comparison: utilization is never negative, so
 * `Maximum < 0` is false whenever a task is alive and the alarm holds OK. Do not
 * "fix" the threshold to a plausible-looking number - a positive threshold would
 * make the alarm fire on a merely idle service and stop tracking liveness.
 *
 * Companion signal: the ECS TaskFailedToStart EventBridge rule reports WHY a task
 * could not start (image pull denied, missing secret) within seconds. This alarm
 * is the backstop that catches a service at zero tasks for any reason at all.
 */

export interface EcsServiceHealthAlarmDefaults {
  /** Evaluation period in seconds for the no-tasks alarm. */
  noTasksPeriod: number;
  /** Consecutive empty periods before the alarm fires. */
  noTasksEvalPeriods: number;
}

/**
 * 2 x 300s = 10 minutes of total metric silence before firing. Long enough that a
 * healthy rolling replacement (new task up in ~1-2 min, so no period is ever
 * fully empty) cannot trip it, short enough that a real outage is caught the same
 * hour rather than the same fortnight.
 */
export const ECS_SERVICE_HEALTH_ALARM_DEFAULTS: EcsServiceHealthAlarmDefaults = {
  noTasksPeriod: 300,
  noTasksEvalPeriods: 2,
};

export interface EcsServiceHealthAlarmDescriptor {
  /** Short kebab-case label used in the alarm name, e.g. 'subscriber-fanout'. */
  label: string;
  /** Human-readable name used in the alarm description. */
  displayName: string;
  /** Value of the Application tag for CloudWatch grouping. */
  application: string;
  /**
   * The ECS ServiceName dimension. SST sets the ECS service name to the component
   * name verbatim, so this is the string passed to `new sst.aws.Service(...)`.
   * Taken as a literal rather than read off `service.nodes.service.name` because
   * that getter throws under `sst dev`.
   */
  serviceName: string;
  /** Defaults to 'Critical'; drop to 'High' for a service whose loss degrades rather than breaks. */
  severity?: 'Critical' | 'High';
  /** Override the number of consecutive empty periods before firing. */
  noTasksEvalPeriods?: number;
}

export interface EcsServiceHealthAlarmNaming {
  /** App name, e.g. $app.name. */
  appName: string;
  /** Deploy stage, e.g. $app.stage. */
  stage: string;
}

/** Everything about the alarm derivable without touching cloud resources. */
export interface EcsServiceHealthAlarmSpec {
  kind: 'no-tasks';
  /** Pulumi/SST logical resource name, e.g. 'ecs-subscriber-fanout-no-tasks'. */
  resourceName: string;
  /** The ECS ServiceName dimension value, for the caller to pair with ClusterName. */
  serviceName: string;
  /** MetricAlarm args minus the resource-bound fields (dimensions, actions). */
  args: {
    name: string;
    alarmDescription: string;
    comparisonOperator: 'LessThanThreshold';
    evaluationPeriods: number;
    metricName: 'CPUUtilization';
    namespace: 'AWS/ECS';
    period: number;
    statistic: 'Maximum';
    /** Always 0: no real datapoint is negative, so only missing data can breach. */
    threshold: number;
    treatMissingData: 'breaching';
    tags: {
      Application: string;
      Severity: 'Critical' | 'High';
      MonitoringType: 'ECSService';
    };
  };
}

/**
 * Builds the "no running tasks" alarm spec for one ECS service.
 */
export function buildEcsServiceHealthAlarmSpec(
  service: EcsServiceHealthAlarmDescriptor,
  naming: EcsServiceHealthAlarmNaming,
  defaults: EcsServiceHealthAlarmDefaults = ECS_SERVICE_HEALTH_ALARM_DEFAULTS
): EcsServiceHealthAlarmSpec {
  if (!service.label) throw new Error('buildEcsServiceHealthAlarmSpec: descriptor label is required');
  if (!service.serviceName) throw new Error('buildEcsServiceHealthAlarmSpec: descriptor serviceName is required');

  return {
    kind: 'no-tasks',
    resourceName: `ecs-${service.label}-no-tasks`,
    serviceName: service.serviceName,
    args: {
      name: `${naming.appName}-${naming.stage}-ecs-${service.label}-no-tasks`,
      alarmDescription:
        `${service.displayName} has no running ECS tasks - the service is down. ` +
        'Check the service events for a task that cannot start (image pull denied, missing secret).',
      comparisonOperator: 'LessThanThreshold',
      evaluationPeriods: service.noTasksEvalPeriods ?? defaults.noTasksEvalPeriods,
      metricName: 'CPUUtilization',
      namespace: 'AWS/ECS',
      period: defaults.noTasksPeriod,
      statistic: 'Maximum',
      threshold: 0,
      treatMissingData: 'breaching',
      tags: {
        Application: service.application,
        Severity: service.severity ?? 'Critical',
        MonitoringType: 'ECSService',
      },
    },
  };
}
