import { appFilesBucket, fabFileBucket, generatedImagesBucket } from './buckets';
import { DEFAULT_LAMBDA_ENVIRONMENT, isPreviewStage } from './constants';
import { allSecrets, secrets } from './secrets';
import { lambdaVpc } from './vpc';

// Database migration function (equivalent to SST v2 onUpdate)
// This runs database migrations on every deployment when in CI mode
const migrator = new sst.aws.Function('DatabaseMigrator', {
  handler: 'apps/client/server/utils/manageDatabase.updateDatabase',
  runtime: 'nodejs24.x',
  timeout: '15 minutes',
  memory: '512 MB',
  link: [...allSecrets, fabFileBucket, generatedImagesBucket, appFilesBucket],
  environment: {
    ...DEFAULT_LAMBDA_ENVIRONMENT,
  },
  vpc: lambdaVpc,
});

// Database seeder function for preview environments
const seeder = new sst.aws.Function('DatabaseSeeder', {
  handler: 'apps/client/server/utils/seedDatabase.handler',
  runtime: 'nodejs24.x',
  timeout: '15 minutes',
  memory: '512 MB',
  link: [...allSecrets, fabFileBucket, generatedImagesBucket, appFilesBucket],
  environment: {
    ...DEFAULT_LAMBDA_ENVIRONMENT,
  },
  vpc: lambdaVpc,
  permissions: [
    {
      // Seeder reads KMS-encrypted SSM params at runtime (us-east-2, bike4mind-dev account).
      // kms:Decrypt is covered by the default alias/aws/ssm key — no extra KMS grant needed.
      actions: ['ssm:GetParameter'],
      resources: [
        $interpolate`arn:aws:ssm:us-east-2:${aws.getCallerIdentityOutput().accountId}:parameter/b4m/ci/seeder-default-password`,
      ],
    },
  ],
});

// Database cleanup function for preview environments
// Invoked by the internal deployer's preview-remove teardown (bike4mind-deployer's `remove`
// job throttles the stage's Lambdas and invokes DatabaseCleaner) before `sst remove`
// Only deployed for preview stages - not needed for dev or production
const cleaner = isPreviewStage
  ? new sst.aws.Function('DatabaseCleaner', {
      handler: 'apps/client/server/utils/dropPreviewDatabase.handler',
      runtime: 'nodejs24.x',
      timeout: '2 minutes',
      memory: '512 MB',
      link: [secrets.MONGODB_URI],
      environment: {
        ...DEFAULT_LAMBDA_ENVIRONMENT,
      },
      vpc: lambdaVpc,
    })
  : undefined;

// Only run migrations in CI environments and when not in dev mode
// This replicates the original SST v2 onUpdate behavior:
// - Only when using CI (process.env.CI === 'true')
// - Only when not in local development (!$dev)
// Captured + exported so the frontend function can `dependsOn` it: fail-closed gates like the
// AUP/ToS consent gate must not serve traffic until the backfill that grandfathers
// existing users has completed, or those users are (transiently) trapped on the interstitial. The
// Invocation resource settles only when the migration Lambda returns, so depending on it orders the
// web deploy strictly after migrations. See web.ts.
const migratorInvocation =
  process.env.CI === 'true' && !$dev
    ? new aws.lambda.Invocation('DatabaseMigratorInvocation', {
        input: JSON.stringify({
          stage: $app.stage,
          timestamp: Date.now(),
          action: 'migration',
        }),
        functionName: migrator.name,
      })
    : undefined;

// Only run seeding on preview environments (PR deployments)
// This runs when IS_PREVIEW environment variable is set to 'true'
if (process.env.CI === 'true' && !$dev && process.env.IS_PREVIEW === 'true') {
  new aws.lambda.Invocation('DatabaseSeederInvocation', {
    input: JSON.stringify({
      stage: $app.stage,
      timestamp: Date.now(),
      action: 'seed',
      isPreview: true,
    }),
    functionName: seeder.name,
  });
}

export const databaseManagement = {
  migrator,
  seeder,
  cleaner,
};

// The migration Invocation (undefined outside CI). web.ts adds this to the frontend's `dependsOn`
// so the fail-closed consent gate never serves traffic ahead of the grandfather backfill.
export { migratorInvocation };
