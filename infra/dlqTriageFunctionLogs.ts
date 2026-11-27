import './cron';
import './dlqAlarms';
import { dlqTriageRoleNames } from './dlqTriagePermissions';
import { dlqConsumerFunctionArns } from './web';

// Attach after subscribers and triage workers exist; importing them from the permission helper creates cycles.
if (dlqTriageRoleNames.length) {
  const policy = new aws.iam.Policy('DlqTriageConsumerLogsPolicy', {
    policy: aws.iam.getPolicyDocumentOutput({
      statements: [{ actions: ['lambda:GetFunctionConfiguration'], resources: dlqConsumerFunctionArns }],
    }).json,
  });
  dlqTriageRoleNames.forEach((role, index) => {
    new aws.iam.RolePolicyAttachment(`DlqTriageConsumerLogsAttachment${index}`, {
      role,
      policyArn: policy.arn,
    });
  });
}
