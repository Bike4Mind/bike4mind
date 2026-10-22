// Stable entry point for consumers outside this repo that subscribe SNS alarm topics to
// 'apps/workers/src/events/alarmToSlack.handler'. Deleting it breaks their deploys with
// 'Handler not found'; the implementation lives in dlqAlarmToSlack.ts.
export { handler } from './dlqAlarmToSlack';
