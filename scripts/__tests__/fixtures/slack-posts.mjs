/**
 * Synthetic Slack bot posts in the current Block Kit shape built by "Parse credits" +
 * "Notify Slack" in .github/workflows/e2e-run.yml and "Aggregate results" in
 * .github/workflows/e2e-ai-latency.yml. Placeholders only (public repo). Shared by
 * scripts/__tests__/qa-backfill-slack.*.test.mjs and
 * apps/client/server/qa/ingestRun.backfill.e2e.test.ts.
 */

export const CHANNEL = 'C0TEST';

const mrkdwn = text => ({ type: 'mrkdwn', text });
const actions = url => ({
  type: 'actions',
  elements: [{ type: 'button', text: { type: 'plain_text', text: 'View Report' }, url }],
});

const DEFAULT_SUMMARY = [
  ':red_circle: Suite A: 3/4',
  ':large_green_circle: Suite B: 78/78',
  ':no_entry_sign: Suite C: 0/0 (2 did not run)',
];
const DEFAULT_CREDITS = [
  '\u2022 model-x \u2014 credits: 12.5 :white_check_mark:',
  '\u2022 Model Y Mini \u2014 credits: 75 :x: _(exceeds threshold of 30)_',
  '\u2022 model-z \u2014 credits: Credit Used data unavailable (chip missing or prior failure). :x:',
];

export function e2ePost({
  ts = '1790000000.000100',
  suite = 'Core',
  trigger = 'Run via Deployer',
  status = ':x: Failed',
  branch = 'main',
  env = 'Staging',
  results = { passed: 81, failed: 1, skipped: 0, notStarted: 0, total: 82 },
  summary = DEFAULT_SUMMARY,
  credits = DEFAULT_CREDITS,
  runUrl = 'https://github.com/example/repo/actions/runs/555#artifacts',
} = {}) {
  const title = `Playwright E2E ${suite ?? 'Tests'} (${trigger})`;
  const r = results;
  return {
    type: 'message',
    subtype: 'bot_message',
    bot_id: 'B0TEST',
    ts,
    text: `${title} \u2014 ${status}`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: title } },
      { type: 'section', fields: [mrkdwn(`*Status*\n${status}`), mrkdwn(`*Branch*\n\`${branch}\``)] },
      {
        type: 'section',
        fields: [
          mrkdwn(`*Environment*\n<https://app.example.com|${env}>`),
          mrkdwn(
            `*Results*\n:white_check_mark: ${r.passed} passed  :x: ${r.failed} failed  :fast_forward: ${r.skipped} skipped  :no_entry_sign: ${r.notStarted} not started  Total: ${r.total}`
          ),
        ],
      },
      { type: 'section', text: mrkdwn(`*${suite ? `${suite} Run Summary` : 'Test Run Summary'}*\n${summary.join('\n')}`) },
      ...(credits ? [{ type: 'section', text: mrkdwn(`*\u{1F4B3} AI Credits*\n${credits.join('\n')}`) }] : []),
      ...(runUrl ? [actions(runUrl)] : []),
    ],
  };
}

/** printf "%-32s %-20s %-8s %s", as the Aggregate results step builds each table row. */
export const latencyRow = (spec, model, quality, latency) =>
  `${spec.padEnd(32)} ${model.padEnd(20)} ${quality.padEnd(8)} ${latency}`;

const DEFAULT_ROWS = [
  latencyRow('latency-spec-a', 'model-x', 'Pass', '3.20s / <=5s'),
  latencyRow('latency-spec-a', 'Model Y Mini', 'Fail', '7.10s / <=5s FAIL (2 prompt(s) never finished)'),
  latencyRow('latency-spec-b', 'model-x', '---', 'No Data'),
  latencyRow('latency-spec-b', 'Model Y Mini', 'Pass', '4.00s / <=N/A FAIL'),
];

export function latencyPost({
  ts = '1790000500.000200',
  trigger = 'Run via Schedule',
  status = ':x: Failed',
  branch = 'main',
  env = 'Staging',
  rows = DEFAULT_ROWS,
  runUrl = 'https://github.com/example/repo/actions/runs/777#artifacts',
} = {}) {
  const table = [
    latencyRow('Suite', 'Model', 'Quality', 'Average Latency'),
    latencyRow('--------------------------------', '--------------------', '--------', '---------------'),
    ...rows,
  ];
  return {
    type: 'message',
    subtype: 'bot_message',
    bot_id: 'B0TEST',
    ts,
    text: `AI Latency \u2014 ${status}`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: `AI Latency (${trigger})` } },
      { type: 'section', fields: [mrkdwn(`*Status*\n${status}`), mrkdwn(`*Branch*\n\`${branch}\``)] },
      {
        type: 'section',
        fields: [
          mrkdwn(`*Environment*\n<https://app.example.com|${env}>`),
          mrkdwn('*Latency*\n:white_check_mark: 1 Within  :x: 2 Exceeded  :fast_forward: 1 No Data'),
        ],
      },
      {
        type: 'section',
        text: mrkdwn(
          `*Normal Prompts*\n\`\`\`${table.join('\n')}\n\`\`\`\n` +
            '--- = No quality data: Playwright crashed, timed out, or failed before results were collected\n' +
            'No Data = Latency results unavailable: an error was encountered prior to latency data collection'
        ),
      },
      ...(runUrl ? [actions(runUrl)] : []),
    ],
  };
}
