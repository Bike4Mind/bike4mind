import { baseApi } from '@server/middlewares/baseApi';
import { userRepository } from '@bike4mind/database';
import { z } from 'zod';
import { encryptToken, decryptToken } from '@server/security/tokenEncryption';

/**
 * Blog Integration Settings API
 *
 * GET /api/blog-integration - Get current blog settings
 * POST /api/blog-integration - Save blog settings
 * DELETE /api/blog-integration - Disconnect blog integration
 */

const blogIntegrationSchema = z.object({
  apiKey: z.string().min(1, 'API key is required'),
  baseUrl: z.url('Base URL must be a valid URL'),
  defaultAuthor: z.string().optional(),
  defaultTags: z.array(z.string()).optional(),
});

const handler = baseApi()
  .get(async (req, res) => {
    try {
      const user = await userRepository.findById(req.user.id);

      if (!user?.blogIntegration) {
        return res.status(200).json({
          connected: false,
          settings: null,
        });
      }

      // Return settings without exposing the full API key
      const { apiKey: rawApiKey, ...settings } = user.blogIntegration;
      const apiKey = decryptToken(rawApiKey) ?? '';

      return res.status(200).json({
        connected: true,
        settings: {
          ...settings,
          apiKeyPreview: `${apiKey.substring(0, 8)}...`, // Show first 8 chars only
        },
      });
    } catch (error) {
      console.error('[Blog Integration GET] Error:', error);
      return res.status(500).json({
        error: 'Failed to fetch blog settings',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  })
  .post(async (req, res) => {
    try {
      const validation = blogIntegrationSchema.safeParse(req.body);

      if (!validation.success) {
        return res.status(400).json({
          error: 'Invalid blog settings',
          details: z.treeifyError(validation.error),
        });
      }

      const { apiKey, baseUrl, defaultAuthor, defaultTags } = validation.data;

      // Test the API key by making a test request (optional but recommended)
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000); // 5s timeout for API test

        let testResponse: Response | undefined;
        try {
          testResponse = await fetch(`${baseUrl}/api/posts`, {
            method: 'GET',
            headers: {
              'X-API-Key': apiKey,
            },
            signal: controller.signal,
          });
          clearTimeout(timeoutId);
        } catch (fetchError) {
          clearTimeout(timeoutId);
          if (fetchError instanceof Error && fetchError.name === 'AbortError') {
            console.warn('[Blog Integration POST] API test timed out after 5s');
            // Continue anyway - timeout shouldn't block setup
          } else {
            throw fetchError;
          }
        }

        if (testResponse && (testResponse.status === 401 || testResponse.status === 403)) {
          return res.status(400).json({
            error: 'Invalid API key',
            message: 'The provided API key was rejected by the blog server. Please check your API key.',
          });
        }
      } catch (testError) {
        console.warn('[Blog Integration POST] Could not test API key:', testError);
        // Continue anyway - the blog server might not have a GET endpoint
      }

      await userRepository.update({
        id: req.user.id,
        blogIntegration: {
          apiKey: encryptToken(apiKey)!,
          baseUrl,
          defaultAuthor: defaultAuthor || undefined,
          defaultTags: defaultTags || undefined,
          connectedAt: new Date(),
        },
      });

      console.log(`[Blog Integration POST] ✅ User ${req.user.id} connected blog: ${baseUrl}`);

      return res.status(200).json({
        success: true,
        message: 'Blog integration configured successfully',
      });
    } catch (error) {
      console.error('[Blog Integration POST] Error:', error);
      return res.status(500).json({
        error: 'Failed to save blog settings',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  })
  .delete(async (req, res) => {
    try {
      await userRepository.update({
        id: req.user.id,
        blogIntegration: null,
      });

      console.log(`[Blog Integration DELETE] ✅ User ${req.user.id} disconnected blog`);

      return res.status(200).json({
        success: true,
        message: 'Blog integration disconnected successfully',
      });
    } catch (error) {
      console.error('[Blog Integration DELETE] Error:', error);
      return res.status(500).json({
        error: 'Failed to disconnect blog',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

export default handler;
