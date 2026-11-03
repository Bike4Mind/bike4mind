import { describe, expect, it } from 'vitest';
import { comparisonWindow, type BusinessMetricAnomaly } from './businessMetricAnomalies';
import {
  describeContributors,
  describeWindow,
  explainWindow,
  formatBusinessMetricSlackMessage,
} from './businessMetricSlackMessage';
import { describeMetric } from './businessMetricLabels';

const intraday = comparisonWindow(new Date('2026-11-02T16:05:00Z'));
const daily = comparisonWindow(new Date('2026-11-03T00:05:00Z'));
const appUrl = 'https://app.example.com/';

const anomaly = (overrides: Partial<BusinessMetricAnomaly> = {}): BusinessMetricAnomaly => ({
  metricName: 'verifiedSignups',
  direction: 'decrease',
  current: 192,
  previous: 236,
  delta: -44,
  percent: -18.64,
  median: 285,
  contributors: [],
  ...overrides,
});

type Block = {
  type: string;
  text?: { text: string };
  elements?: Array<{ text?: { text: string }; url?: string; text_?: string }>;
};
const attachmentBlocks = (message: ReturnType<typeof formatBusinessMetricSlackMessage>) =>
  message.attachments[0].blocks as Block[];
const sectionTexts = (message: ReturnType<typeof formatBusinessMetricSlackMessage>) =>
  attachmentBlocks(message)
    .filter(block => block.type === 'section')
    .map(block => block.text?.text ?? '');
const allText = (message: ReturnType<typeof formatBusinessMetricSlackMessage>) =>
  JSON.stringify([message.text, message.blocks, message.attachments]);

describe('business metric Slack message', () => {
  it('groups every anomaly under one titled header with the compare kind and count', () => {
    const message = formatBusinessMetricSlackMessage(intraday, [
      anomaly(),
      anomaly({ metricName: 'activeUsers', current: 45, previous: 56, delta: -11, percent: -19.6, median: 56 }),
      anomaly({ metricName: 'credits', current: 2667, previous: 6811, delta: -4144, percent: -60.8, median: 6811 }),
    ]);
    expect(message.blocks).toEqual([
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: ':bar_chart: Business metrics, 16:00 UTC intraday compare: 3 anomalies',
          emoji: true,
        },
      },
    ]);
    expect(message.text).toBe(
      'Business metrics, 16:00 UTC intraday compare: 3 anomalies: Verified signups down 18.6%, Active users down 19.6%, Credits charged down 60.8%'
    );
    expect(sectionTexts(message)).toHaveLength(3);
    expect(describeWindow(daily)).toBe('2 Nov closed-day compare');
    expect(formatBusinessMetricSlackMessage(daily, [anomaly()]).text).toContain('closed-day compare: 1 anomaly:');
  });

  it('explains what current and previous mean for each compare kind', () => {
    expect(explainWindow(intraday)).toBe(
      '00:00 to 16:00 UTC today (16h) against the same hours yesterday. The median is the same 16h over the previous 7 days. The day closes at midnight UTC with its own compare.'
    );
    expect(explainWindow(daily)).toBe(
      'Closed UTC day 2 Nov against the day before. The median is the previous 7 closed days.'
    );
    const [context] = attachmentBlocks(formatBusinessMetricSlackMessage(intraday, [anomaly()]));
    expect(context).toMatchObject({ type: 'context', elements: [{ text: explainWindow(intraday) }] });
  });

  it('renders each metric with a human label, direction glyph, units, percent, median and meaning', () => {
    const [signups, credits, spend, receipts] = sectionTexts(
      formatBusinessMetricSlackMessage(intraday, [
        anomaly(),
        anomaly({
          metricName: 'credits',
          direction: 'increase',
          current: 9811,
          previous: 6811,
          delta: 3000,
          percent: 44.06,
          median: 6811,
        }),
        anomaly({
          metricName: 'spendUsd:openai',
          direction: 'increase',
          current: 42.5,
          previous: 20,
          delta: 22.5,
          percent: 112.5,
          median: null,
        }),
        anomaly({
          metricName: 'revenueMinor:usd',
          direction: 'increase',
          current: 123456,
          previous: 0,
          delta: 123456,
          percent: null,
          median: 100,
        }),
      ])
    );
    expect(signups).toBe(
      ':small_red_triangle_down: *Verified signups* down 18.6%\n' +
        'Now *192*, previous 236, 7-day median 285\n' +
        '_Fewer accounts verified their email than yesterday. Usually traffic or verification-email delivery; check bounces and the email provider if it keeps falling._'
    );
    expect(credits).toContain(
      ':small_red_triangle: *Credits charged* up 44.1%\nNow *9,811 credits*, previous 6,811 credits, 7-day median 6,811 credits'
    );
    expect(credits).toContain('young accounts');
    expect(spend).toContain(
      '*Estimated OpenAI spend* up 112.5%\nNow *USD 42.50*, previous USD 20.00, median warming up'
    );
    expect(receipts).toContain(
      '*Stripe receipts (USD)* up from zero\nNow *USD 1,234.56*, previous USD 0.00, 7-day median USD 1.00'
    );
    expect(receipts).toContain('Radar');
  });

  it('links contributors to admin pages, names models, caps at three and never prints a raw id', () => {
    const userId = '6818b9a95d466aaf72b2e89e';
    const message = formatBusinessMetricSlackMessage(
      intraday,
      [
        anomaly({
          metricName: 'credits',
          current: 2667,
          previous: 6811,
          delta: -4144,
          percent: -60.8,
          median: 6811,
          contributors: [
            { label: `user:${userId}`, value: -2965 },
            { label: 'model:claude-opus-5-5', value: -2958 },
            { label: 'model:global.anthropic.claude-haiku-5-5', value: -1269 },
            { label: 'org:6ae60bba8b1a3c07be7a484a', value: -524 },
            { label: 'user:6ae44d7c08b61d93f6ad61f4', value: -517 },
          ],
        }),
      ],
      { appUrl }
    );
    const [section] = sectionTexts(message);
    expect(section).toContain(
      `Top users: <https://app.example.com/admin/users/${userId}|user \u2026e89e> -2,965 credits, ` +
        '<https://app.example.com/admin/users/6ae44d7c08b61d93f6ad61f4|user \u202661f4> -517 credits\n' +
        'Top models: Claude Opus 5.5 -2,958 credits, Claude Haiku 5.5 -1,269 credits\n' +
        'Top orgs: <https://app.example.com/admin?tab=organizations&orgId=6ae60bba8b1a3c07be7a484a|org \u2026484a> -524 credits'
    );
    expect(section).not.toContain('org:');
    expect(section.replace(/<[^|>]+\|/g, '')).not.toContain(userId);
    expect(section.replace(/<[^|>]+\|/g, '')).not.toContain('6ae44d7c08b61d93f6ad61f4');
  });

  it('links organizations to the organizations tab and keeps labels unlinked without an app url', () => {
    const credits = anomaly({
      metricName: 'credits',
      direction: 'increase',
      current: 9811,
      previous: 6811,
      delta: 3000,
      percent: 44,
      median: null,
      contributors: [
        { label: 'org:6ae60bba8b1a3c07be7a484a', value: 2000.4 },
        { label: 'model:<script>', value: 1000 },
      ],
    });
    expect(describeContributors(credits, describeMetric('credits'), appUrl)).toBe(
      'Top orgs: <https://app.example.com/admin?tab=organizations&orgId=6ae60bba8b1a3c07be7a484a|org \u2026484a> +2,000 credits\n' +
        'Top models: &lt;script&gt; +1,000 credits'
    );
    expect(describeContributors(credits, describeMetric('credits'), undefined)).toBe(
      'Top orgs: org \u2026484a +2,000 credits\nTop models: &lt;script&gt; +1,000 credits'
    );
  });

  it('turns a list of one-each account moves into links on a rise and drops it on a fall', () => {
    const rows = Array.from({ length: 5 }, (_, index) => ({ label: `user:${String(index).repeat(24)}`, value: 1 }));
    const rise = anomaly({
      direction: 'increase',
      current: 300,
      previous: 236,
      delta: 64,
      percent: 27,
      contributors: rows,
    });
    expect(describeContributors(rise, describeMetric('verifiedSignups'), appUrl)).toBe(
      'Accounts: <https://app.example.com/admin/users/000000000000000000000000|user \u20260000>, ' +
        '<https://app.example.com/admin/users/111111111111111111111111|user \u20261111>, ' +
        '<https://app.example.com/admin/users/222222222222222222222222|user \u20262222> and 2 more'
    );
    const fall = anomaly({ contributors: rows.map(row => ({ ...row, value: -1 })) });
    expect(describeContributors(fall, describeMetric('verifiedSignups'), appUrl)).toBeUndefined();
    expect(describeContributors(anomaly(), describeMetric('verifiedSignups'), appUrl)).toBeUndefined();
  });

  it('lists only the newly active accounts on an active-user rise', () => {
    const rise = anomaly({
      metricName: 'activeUsers',
      direction: 'increase',
      contributors: [
        { label: 'user:aaaaaaaaaaaaaaaaaaaa1111', value: 1 },
        { label: 'user:bbbbbbbbbbbbbbbbbbbb2222', value: -1 },
      ],
    });
    expect(describeContributors(rise, describeMetric('activeUsers'), undefined)).toBe('Accounts: user \u20261111');
  });

  it('shows one-unit request movers with their deltas instead of as accounts', () => {
    const rows = [
      { label: 'user:aaaaaaaaaaaaaaaaaaaa1111', value: 1 },
      { label: 'user:bbbbbbbbbbbbbbbbbbbb2222', value: -1 },
    ];
    const rise = anomaly({ metricName: 'requests:user', direction: 'increase', contributors: rows });
    expect(describeContributors(rise, describeMetric('requests:user'), undefined)).toBe(
      'Top users: user \u20261111 +1, user \u20262222 -1'
    );
    const fall = anomaly({ metricName: 'requests:user', contributors: rows });
    expect(describeContributors(fall, describeMetric('requests:user'), undefined)).toBe(
      'Top users: user \u20261111 +1, user \u20262222 -1'
    );
  });

  it('caps the attachment at 40 metric sections and counts the rest', () => {
    const many = Array.from({ length: 43 }, (_, index) => anomaly({ metricName: `revenueMinor:c${index}` }));
    const message = formatBusinessMetricSlackMessage(intraday, many);
    const sections = sectionTexts(message);
    expect(sections).toHaveLength(41);
    expect(sections.at(-1)).toBe('3 more anomalies not shown.');
    expect(message.blocks[0]).toMatchObject({ text: { text: expect.stringContaining('43 anomalies') } });
    expect(attachmentBlocks(message).length).toBeLessThanOrEqual(50);
  });

  it('labels the daily footer stamp as the close time', () => {
    const footer = attachmentBlocks(formatBusinessMetricSlackMessage(daily, [anomaly()])).at(-1);
    expect(footer).toMatchObject({
      elements: [{ type: 'mrkdwn', text: 'category business  |  closed 00:00 UTC, 3 Nov' }],
    });
  });

  it('adds admin buttons only with an app url and colours the bar by the worst signal', () => {
    const quiet = formatBusinessMetricSlackMessage(intraday, [anomaly()]);
    expect(attachmentBlocks(quiet).some(block => block.type === 'actions')).toBe(false);
    expect(quiet.attachments[0].color).toBe('#ECB22E');

    const farm = formatBusinessMetricSlackMessage(
      intraday,
      [anomaly(), anomaly({ metricName: 'verifiedSignups', direction: 'increase', delta: 64, percent: 27 })],
      { appUrl, stage: 'production' }
    );
    expect(farm.attachments[0].color).toBe('#E01E5A');
    const actions = attachmentBlocks(farm).find(block => block.type === 'actions');
    expect(actions?.elements?.map(element => [element.text?.text, element.url])).toEqual([
      ['Open analytics', 'https://app.example.com/admin?tab=analytics'],
      ['Signup activity', 'https://app.example.com/admin?tab=users&signedUp=hour'],
    ]);
    const footer = attachmentBlocks(farm).at(-1);
    expect(footer).toMatchObject({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: 'category business  |  production  |  16:00 UTC, 2 Nov' }],
    });

    const growth = formatBusinessMetricSlackMessage(intraday, [
      anomaly({
        metricName: 'payingSubscribers',
        direction: 'increase',
        current: 12,
        previous: 9,
        delta: 3,
        percent: 33,
      }),
    ]);
    expect(growth.attachments[0].color).toBe('#36C5F0');
    expect(sectionTexts(growth)[0]).toContain(':arrow_up_small: *Paying subscribers* up 33.0%');
  });

  it('escapes Slack control sequences in labels and meanings', () => {
    const message = formatBusinessMetricSlackMessage(intraday, [
      anomaly({ metricName: 'requests:<!channel>', contributors: [{ label: '<!here>', value: -5 }] }),
    ]);
    expect(allText(message)).not.toContain('<!channel>');
    expect(allText(message)).not.toContain('<!here>');
    expect(sectionTexts(message)[0]).toContain('*API requests (&lt;!channel&gt;)* down 18.6%');
  });
});
