import { Request, Response } from 'express';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { ForbiddenError } from '@server/utils/errors';
import { buildWhatsNewPrompt, PromptParams, SanitizedContent } from '@server/queueHandlers/whatsNewGeneration.utils';
import { z } from 'zod';

// Rate limiting constants
const PREVIEW_RATE_LIMIT = 20; // requests per minute
const ONE_MINUTE_MS = 60 * 1000;

// Request schema
const PreviewRequestSchema = z.object({
  template: z.string().optional(),
});

/**
 * Sample data for template preview
 */
function getSampleData(): PromptParams {
  const sanitizedContent: SanitizedContent = {
    releaseBody: `This release includes several exciting new features and important improvements:

- Enhanced user authentication with multi-factor authentication support
- New analytics dashboard with real-time metrics
- Performance optimizations reducing load times by 40%
- Bug fixes for modal rendering and form validation
- Improved error handling and logging

For detailed changelog, see below.`,
    commits: [
      { message: 'feat(auth): add multi-factor authentication support' },
      { message: 'feat(analytics): implement real-time metrics dashboard' },
      { message: 'perf(core): optimize database query performance' },
      { message: 'fix(ui): resolve modal rendering issue on mobile' },
      { message: 'fix(forms): improve validation error messages' },
    ],
    pullRequests: [
      {
        title: 'Add Multi-Factor Authentication',
        body: 'Implements TOTP-based 2FA for enhanced security. Users can enable MFA in account settings.',
      },
      {
        title: 'Real-time Analytics Dashboard',
        body: 'New dashboard showing live user activity, system metrics, and performance indicators.',
      },
      {
        title: 'Performance Improvements',
        body: 'Optimized database queries and added caching layer, reducing average load time by 40%.',
      },
    ],
    changelogExcerpt: `## [1.5.0] - 2025-01-15

### Added
- Multi-factor authentication with TOTP support
- Real-time analytics dashboard
- User activity tracking and reporting

### Changed
- Improved database query performance
- Enhanced error handling across all endpoints

### Fixed
- Modal rendering issues on mobile devices
- Form validation error messages`,
  };

  const styleExamples = [
    {
      title: '🎉 Exciting New Features Are Here!',
      subtitle: 'Discover powerful tools to boost your productivity',
      description: `We're thrilled to announce several game-changing features in this release:

- **Smart Automation**: Save hours with intelligent workflow automation
- **Advanced Analytics**: Get deeper insights with our new reporting dashboard
- **Enhanced Security**: Your data is safer than ever with our latest security improvements

Try them out today and let us know what you think!`,
    },
    {
      title: '⚡ Performance & Reliability Boost',
      subtitle: 'Faster load times and rock-solid stability',
      description: `This update is all about making your experience smoother and more reliable:

**What's New:**
- 50% faster page load times
- Improved error handling and recovery
- Better mobile experience

We've been listening to your feedback and working hard to deliver these improvements. Enjoy!`,
    },
  ];

  return {
    styleExamples,
    releaseData: sanitizedContent,
    releaseTag: 'v1.5.0',
  };
}

const handler = baseApi()
  .use(rateLimit({ limit: PREVIEW_RATE_LIMIT, windowMs: ONE_MINUTE_MS }))
  .post(async (req: Request, res: Response) => {
    // Check if user is admin
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    try {
      // Validate request body
      const { template } = PreviewRequestSchema.parse(req.body);

      // Get sample data
      const sampleData = getSampleData();

      // Build prompt with sample data
      const preview = buildWhatsNewPrompt(sampleData, template);

      return res.json({
        success: true,
        preview,
        sampleData: {
          releaseTag: sampleData.releaseTag,
          commitsCount: sampleData.releaseData.commits.length,
          pullRequestsCount: sampleData.releaseData.pullRequests.length,
          styleExamplesCount: sampleData.styleExamples.length,
        },
      });
    } catch (error) {
      console.error("Error generating What's New template preview:", error);

      // Check if it's a validation error
      if (error instanceof Error && error.name === 'ZodError') {
        return res.status(400).json({
          error: 'Invalid request',
          details: error.message,
        });
      }

      // Check if it's a template error
      if (error instanceof Error && error.message.includes('Template')) {
        return res.status(400).json({
          error: 'Template error',
          details: error.message,
        });
      }

      return res.status(500).json({
        error: 'Failed to generate template preview',
      });
    }
  });

export default handler;

export const config = {
  api: {
    externalResolver: true,
  },
};
