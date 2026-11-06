import { isMonitoredStage } from '@bike4mind/infra';

export const otcEmailConfigurationSet =
  isMonitoredStage($app.stage, ['dev', 'production'], process.env.ENABLE_MONITORING) &&
  process.env.ENABLE_OTC_SES_METRICS === 'true'
    ? new aws.ses.ConfigurationSet('OtcEmailConfigurationSet')
    : undefined;

if (otcEmailConfigurationSet) {
  new aws.ses.EventDestination('OtcEmailCloudWatch', {
    configurationSetName: otcEmailConfigurationSet.name,
    enabled: true,
    matchingTypes: ['send', 'bounce', 'complaint'],
    cloudwatchDestinations: [
      {
        defaultValue: 'otc',
        dimensionName: 'ses:configuration-set',
        valueSource: 'messageTag',
      },
    ],
  });
}
