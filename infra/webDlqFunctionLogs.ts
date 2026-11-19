// GetFunctionConfiguration also returns a function's env (linked secrets), so the admin DLQ logs links get it only
// on the targets of rules that dead-letter through createEventBusDeadLetter. Every allowRules caller is imported
// first so that list is complete; pinned in infra/__tests__/dlqScheduleRuleIam.test.ts.
import './adminMorningBrief';
import './apiProbeDetector';
import './businessMetricAlerts';
import './cron';
import './eventBus';
import './imageModerationReviewSweep';
import './llm';
import './organizationRetention';
import './sideAppHealthAlerts';
import './youngAccountSpendAlert';
import { deadLetterRuleTargetArns } from './eventBusDeadLetter';
import { web } from './web';

if (web.nodes.server) {
  const dlqFunctionLogsPolicy = new aws.iam.Policy('WebDlqFunctionLogsPolicy', {
    policy: aws.iam.getPolicyDocumentOutput({
      statements: [{ actions: ['lambda:GetFunctionConfiguration'], resources: [...deadLetterRuleTargetArns] }],
    }).json,
  });
  new aws.iam.RolePolicyAttachment('WebDlqFunctionLogsPolicyAttachment', {
    role: web.nodes.server.nodes.role.name,
    policyArn: dlqFunctionLogsPolicy.arn,
  });
}
