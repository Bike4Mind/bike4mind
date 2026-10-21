import { DEFAULT_LAMBDA_ENVIRONMENT } from './constants';
import { eventBus } from './eventBus';
import { slackQuestProcessor } from './functions';
import { allSecrets } from './secrets';
import { lambdaVpc } from './vpc';

// Web-originated completions ('completion.started') are no longer handled by a Lambda.
// They are processed by the always-on ChatCompletion (see infra/chatCompletion.ts),
// which the frontend reaches directly over HTTP. Slack-originated completions still route
// through EventBridge -> slackQuestProcessor below, matched by their own detail type.

eventBus.subscribe('slack-completion-start', slackQuestProcessor.arn, {
  pattern: {
    detailType: ['slack.completion.started'],
  },
});

eventBus.subscribe(
  'create-memento',
  {
    handler: 'apps/workers/src/events/createMemento.handler',
    runtime: 'nodejs24.x',
    link: [...allSecrets, eventBus],
    environment: {
      ...DEFAULT_LAMBDA_ENVIRONMENT,
    },
    permissions: [
      {
        actions: ['bedrock:*'],
        resources: ['*'],
      },
    ],
    vpc: lambdaVpc,
  },
  {
    pattern: {
      detailType: ['completion.completed'],
    },
  }
);
