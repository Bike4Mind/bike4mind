import { Request, Response } from 'express';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { ForbiddenError } from '@server/utils/errors';
import { buildHighlightsPrompt } from '@server/queueHandlers/whatsNewHighlights.prompt';
import type { ModalForHighlights } from '@server/queueHandlers/whatsNewHighlights.types';
import { z } from 'zod';

const PREVIEW_RATE_LIMIT = 20;
const ONE_MINUTE_MS = 60 * 1000;

const PreviewRequestSchema = z.object({
  template: z.string().optional(),
});

/**
 * Sample modals for template preview
 */
function getSampleModals(): ModalForHighlights[] {
  return [
    {
      _id: 'sample-1',
      title: "What's New - March 5, 2026",
      subtitle: 'AI assistants get smarter with new MCP tools and Slack integration',
      description:
        "## **Smarter AI, Better Integrations**\n\nYour AI assistant just got a major upgrade with new capabilities:\n\n### What's New\n- **GitHub Branch Management** - Your AI assistant can now create and manage GitHub branches directly\n- **Slack Thread Support** - Slack integration now supports threaded conversations for better context\n- **Faster Search** - Knowledge base search results are now 40% faster\n\n---\n**TL;DR**: Smarter AI tools, better Slack integration, faster search",
      createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
    },
    {
      _id: 'sample-2',
      title: "What's New - March 3, 2026",
      subtitle: 'Voice interactions and improved authentication',
      description:
        "## **Talk to Your AI**\n\nNew voice features and security improvements:\n\n### What's New\n- **Voice Commands** - Interact with your AI assistant using voice\n- **SSO Improvements** - Faster single sign-on with better error handling\n\n---\n**TL;DR**: Voice support, better login experience",
      createdAt: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000),
    },
    {
      _id: 'sample-3',
      title: "What's New - March 1, 2026",
      subtitle: 'Performance boost and bug fixes',
      description:
        "## **Faster & More Reliable**\n\nPerformance improvements across the board:\n\n### What's New\n- **50% Faster Load Times** - Optimized database queries and caching\n- **Mobile Fixes** - Resolved modal rendering issues on mobile devices\n\n---\n**TL;DR**: Faster everything, better mobile experience",
      createdAt: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000),
    },
  ];
}

const handler = baseApi()
  .use(rateLimit({ limit: PREVIEW_RATE_LIMIT, windowMs: ONE_MINUTE_MS }))
  .post(async (req: Request, res: Response) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    try {
      const { template } = PreviewRequestSchema.parse(req.body);

      const sampleModals = getSampleModals();
      const dateRange = {
        start: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        }),
        end: new Date().toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        }),
      };

      const preview = buildHighlightsPrompt(sampleModals, dateRange, template || undefined);

      return res.json({
        success: true,
        preview,
        sampleData: {
          modalCount: sampleModals.length,
          dateRange,
        },
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'ZodError') {
        return res.status(400).json({
          error: 'Invalid request',
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
