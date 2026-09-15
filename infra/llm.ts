import { DEFAULT_LAMBDA_ENVIRONMENT } from './constants';
import { eventBus } from './eventBus';
import { slackEventBus } from './bus';
import { slackQuestProcessor } from './functions';
import { allSecrets } from './secrets';
import { lambdaVpc } from './vpc';

// Web-originated completions ('completion.started') are no longer handled by a Lambda.
// They are processed by the always-on ChatCompletion (see infra/chatCompletion.ts),
// which the frontend reaches directly over HTTP. Slack-originated completions still route
// through EventBridge → slackQuestProcessor below.

slackEventBus.subscribe('slack-completion-start', slackQuestProcessor.arn, {
  pattern: {
    detailType: ['slack.completion.started'],
  },
});

eventBus.subscribe(
  'create-memento',
  {
    handler: 'apps/client/server/events/createMemento.handler',
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
    logging: {
      retention: '3 days',
    },
    vpc: lambdaVpc,
  },
  {
    pattern: {
      detailType: ['completion.completed'],
    },
  }
);
