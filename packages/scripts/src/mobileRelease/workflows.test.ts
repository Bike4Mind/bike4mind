import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type Step = { name?: string; uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, string> };
type Job = { needs?: string; environment?: string; uses?: string; with?: Record<string, string>; steps?: Step[] };
type Workflow = { on: Record<string, unknown>; permissions: Record<string, string>; jobs: Record<string, Job> };

function load(name: string): { text: string; workflow: Workflow } {
  const text = readFileSync(new URL(`../../../../.github/workflows/${name}`, import.meta.url), 'utf8');
  return { text, workflow: parse(text) as Workflow };
}

function stepEnv(job: Job): Record<string, string> {
  return Object.assign({}, ...(job.steps ?? []).map(step => ({ ...step.env, ...step.with })));
}

function actionRefs(workflow: Workflow): string[] {
  return Object.values(workflow.jobs).flatMap(job => (job.steps ?? []).flatMap(step => (step.uses ? [step.uses] : [])));
}

function expectThirdPartyPinned(workflow: Workflow): void {
  const thirdParty = actionRefs(workflow).filter(ref => !/^(actions|pnpm|gradle)\//.test(ref));
  for (const ref of thirdParty) expect(ref).toMatch(/@[0-9a-f]{40}$/);
}

// Every `${{ ... }}` naming a signing or upload credential must read it from secrets.
const CREDENTIAL = /KEY|PASSWORD|ALIAS|TEAM|ISSUER|SERVICE_ACCOUNT|serviceAccount/;

const LANES = [
  {
    file: 'ios-testflight.yml',
    platform: 'ios',
    lane: 'testflight',
    secrets: ['IOS_TEAM_ID', 'ASC_KEY_ID', 'ASC_ISSUER_ID', 'ASC_KEY_CONTENT_BASE64'],
  },
  {
    file: 'android-play-internal.yml',
    platform: 'android',
    lane: 'play-internal',
    secrets: [
      'ANDROID_KEYSTORE_BASE64',
      'ANDROID_KEYSTORE_PASSWORD',
      'ANDROID_KEY_ALIAS',
      'ANDROID_KEY_PASSWORD',
      'PLAY_SERVICE_ACCOUNT_JSON',
    ],
  },
] as const;

describe.each(LANES)('$file', ({ file, platform, lane, secrets }) => {
  const { text, workflow } = load(file);

  it('runs on train tags and on demand, read-only', () => {
    expect(workflow.on.push).toEqual({ tags: ['mobile-v*'] });
    expect(workflow.on).toHaveProperty('workflow_dispatch.inputs.version.required', true);
    expect(workflow.on).toHaveProperty('workflow_dispatch.inputs.rc.required', false);
    expect(workflow.permissions).toEqual({ contents: 'read' });
  });

  it('plans the build through the parity gate before the lane', () => {
    expect(workflow.jobs.plan.uses).toBe('./.github/workflows/_mobile-release-plan.yml');
    expect(workflow.jobs.plan.with).toEqual({
      platform,
      version: '${{ inputs.version }}',
      rc: '${{ inputs.rc }}',
    });
    expect(workflow.jobs[lane].needs).toBe('plan');
  });

  it('runs the lane in the protected environment with every credential from secrets', () => {
    const job = workflow.jobs[lane];
    expect(job.environment).toBe('mobile-release');
    const env = stepEnv(job);
    for (const name of secrets) expect(text).toContain(`secrets.${name} }}`);
    for (const [key, value] of Object.entries(env)) {
      if (CREDENTIAL.test(key) && !key.startsWith('FCM_') && String(value).includes('${{')) {
        expect(value, key).toMatch(/^\$\{\{ secrets\./);
      }
    }
  });

  it('feeds the planned version and build number into the build', () => {
    expect(text).toContain('needs.plan.outputs.version');
    expect(text).toContain('needs.plan.outputs.build_number');
  });

  it('pins third-party actions to a commit', () => {
    expectThirdPartyPinned(workflow);
  });
});

describe('_mobile-release-plan.yml', () => {
  const { workflow } = load('_mobile-release-plan.yml');

  it('runs the parity gate for the given platform into its outputs, read-only', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
    const plan = workflow.jobs.plan.steps?.find(step => step.run?.includes('mobile-release plan'));
    expect(plan?.run).toContain('mobile-release plan --platform "$PLATFORM" "$@" >> "$GITHUB_OUTPUT"');
    expect(plan?.env).toMatchObject({ PLATFORM: '${{ inputs.platform }}', TAG: '${{ github.ref_name }}' });
    expect(workflow.on).toHaveProperty('workflow_call.outputs.version.value', '${{ jobs.plan.outputs.version }}');
    expect(workflow.on).toHaveProperty(
      'workflow_call.outputs.build_number.value',
      '${{ jobs.plan.outputs.build_number }}'
    );
  });

  it('pins third-party actions to a commit', () => {
    expectThirdPartyPinned(workflow);
  });
});

describe('android-play-internal.yml', () => {
  const FCM = [
    ['FCM_APPLICATION_ID', 'applicationId'],
    ['FCM_API_KEY', 'apiKey'],
    ['FCM_PROJECT_ID', 'projectId'],
    ['FCM_SENDER_ID', 'senderId'],
  ] as const;

  it.each(FCM)('passes %s to Gradle and fails the lane up front when it is unset', (name, property) => {
    const steps = load('android-play-internal.yml').workflow.jobs['play-internal'].steps ?? [];
    const check = steps.find(step => step.run?.includes('missing='));
    const build = steps.find(step => step.run?.includes(':app:bundleRelease'));
    expect(check?.env?.[name]).toBe(`\${{ vars.${name} }}`);
    expect(check?.run).toMatch(new RegExp(`for name in [^;]*\\b${name}\\b`));
    expect(build?.env?.[name]).toBe(`\${{ vars.${name} }}`);
    expect(build?.run).toContain(`-Pb4m.fcm.${property}="$${name}"`);
  });

  it('uploads the signed bundle to the internal track', () => {
    const upload = load('android-play-internal.yml').workflow.jobs['play-internal'].steps?.find(step =>
      step.uses?.startsWith('r0adkll/upload-google-play@')
    );
    expect(upload?.with).toMatchObject({
      track: 'internal',
      serviceAccountJsonPlainText: '${{ secrets.PLAY_SERVICE_ACCOUNT_JSON }}',
      releaseFiles: 'apps/android/app/build/outputs/bundle/release/app-release.aab',
    });
  });
});

describe('ios-testflight.yml', () => {
  it('uploads through the fastlane beta lane', () => {
    const runs = (load('ios-testflight.yml').workflow.jobs.testflight.steps ?? []).map(step => step.run ?? '');
    expect(runs).toContain('bundle exec fastlane beta');
  });
});
