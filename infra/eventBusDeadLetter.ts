/**
 * Dead-letter wiring for an EventBridge rule that invokes a Lambda. A failure can be lost on
 * either side of the async invoke, so both sides point at the same queue:
 * - `ruleTarget` (rule-target DLQ): events EventBridge could not hand to Lambda at all;
 * - `functionTarget` + `sendPermission` (function DLQ): a thrown error, timeout or init crash
 *   after Lambda accepted the invoke, once Lambda's own 2 retries are spent. This is the side
 *   a real handler failure lands on.
 * Call `allowRules` with the subscriptions that use `ruleTarget` so EventBridge may deliver.
 *
 * The queue is declared by the caller because the self-host parity inventory
 * (packages/scripts/src/selfhostParityInventory.ts) needs a literal `new sst.aws.Queue('name', {...})`.
 *
 * Alarm-only: there is no source queue to replay into (recovery is re-emitting the event), so
 * register the queue with createDlqAlarms in infra/dlqAlarms.ts, not DLQ_DESCRIPTORS.
 * An sst.aws.Cron target must clear SST's literal `{}` input (see youngAccountSpendAlert in
 * infra/cron.ts), or the queued body is `{}` and there is no event to re-emit.
 * Guarded by infra/__tests__/eventBusDlq.test.ts.
 */
// eventBus.subscribe returns an Output, so the rule ARN is read inside apply: lifting `.nodes`
// off the Output resolves every node, and `nodes.function` throws for a subscriber that
// targets an existing function by ARN (slack-completion-start in infra/llm.ts).
type RuleSubscription = $util.Output<{ nodes: { rule: { arn: $util.Output<string> } } }>;

export function createEventBusDeadLetter(name: string, queue: sst.aws.Queue) {
  return {
    queue,
    // Lambda delivers async-invoke failures with the function's own execution role.
    sendPermission: { actions: ['sqs:SendMessage'], resources: [queue.arn] },
    // sst.aws.Function has no first-party async-invoke DLQ prop, so the underlying
    // aws.lambda.Function's deadLetterConfig is set directly.
    functionTarget: { function: { deadLetterConfig: { targetArn: queue.arn } } },
    ruleTarget: { target: { deadLetterConfig: { arn: queue.arn } } },
    // EventBridge delivers to a rule-target DLQ as the events.amazonaws.com service principal.
    allowRules: (subscriptions: RuleSubscription[]) =>
      new aws.sqs.QueuePolicy(`${name}Policy`, {
        queueUrl: queue.url,
        policy: $util
          .all([
            queue.arn,
            $util.all(subscriptions.map(subscription => subscription.apply(subscriber => subscriber.nodes.rule.arn))),
          ])
          .apply(([queueArn, ruleArns]) =>
            JSON.stringify({
              Version: '2012-10-17',
              Statement: [
                {
                  Effect: 'Allow',
                  Principal: { Service: 'events.amazonaws.com' },
                  Action: 'sqs:SendMessage',
                  Resource: queueArn,
                  Condition: { ArnEquals: { 'aws:SourceArn': ruleArns } },
                },
              ],
            })
          ),
      }),
  };
}
