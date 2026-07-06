/// <reference path="../.sst/platform/config.d.ts" />

/**
 * Docs-Site Standalone SST Configuration
 *
 * Deploys the public Bike4Mind documentation as an independent Static Site
 * with its own CloudFront distribution. The site is fully public - no auth.
 *
 * Deploy with:
 *   cd docs-site && npx sst deploy --stage <stage>
 *
 * Stages:
 *   - production → docs.bike4mind.com
 *   - dev (staging) → docs.staging.bike4mind.com
 */

export default $config({
  app(input) {
    return {
      name: 'bike4mind-docs',
      removal: ['production', 'dev'].includes(input?.stage) ? 'retain' : 'remove',
      protect: ['production', 'dev'].includes(input?.stage),
      home: 'aws',
      providers: {
        aws: {
          region: 'us-east-2',
        },
      },
    };
  },
  async run() {
    const baseDomain =
      process.env.SERVER_DOMAIN || ($app.stage === 'production' ? 'bike4mind.com' : 'staging.bike4mind.com');
    const docsDomain = process.env.DOCS_DOMAIN || `docs.${baseDomain}`;
    const docsUrl = `https://${docsDomain}`;

    const docs = new sst.aws.StaticSite('Docs', {
      path: './',
      build: {
        output: 'build',
        command: `pnpm install --frozen-lockfile && DOCS_URL='${docsUrl}' pnpm build`,
      },
      dev: {
        command: 'pnpm start',
        url: 'http://localhost:3010',
      },
      domain: docsDomain,
      environment: {
        DOCS_URL: docsUrl,
        BUILD_TAG: process.env.BUILD_TAG || '',
      },
    });

    return {
      appName: $app.name,
      stage: $app.stage,
      docsUrl: docs.url,
      docsDomain: docsDomain,
    };
  },
});
