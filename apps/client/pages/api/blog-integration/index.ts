import { baseApi } from '@server/middlewares/baseApi';
import { userRepository } from '@bike4mind/database';
import { z } from 'zod';
import { encryptToken, decryptToken } from '@server/security/tokenEncryption';
import { assertUrlAllowed, safeFetch, SsrfError } from '@server/utils/ssrfProtection';

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

      // Fail closed against SSRF: baseUrl is user-supplied and fetched server-side with the
      // user's key (here, and by blog/publish + blog/presign-image-upload). Reject an
      // internal/loopback/non-https host - DNS-resolving, so a public name that resolves to a
      // private IP is caught at validation time too - before we test or store it. This does not
      // close DNS rebinding (validation and the later connect resolve separately; see the TOCTOU
      // note in ssrfProtection.ts); the outbound calls use safeFetch, which bounds what an upstream
      // response can return. Shared guard in server/utils/ssrfProtection.ts.
      try {
        await assertUrlAllowed(baseUrl);
      } catch (e) {
        if (e instanceof SsrfError) {
          return res.status(400).json({
            error: 'Invalid blog settings',
            message: `Base URL is not allowed: ${e.message}`,
          });
        }
        throw e;
      }

      // Test the API key by making a test request (optional but recommended)
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000); // 5s timeout for API test

        let testResponse: Response | undefined;
        try {
          testResponse = await safeFetch(`${baseUrl}/api/posts`, {
            method: 'GET',
            headers: {
              'X-API-Key': apiKey,
            },
            signal: controller.signal,
          });
          clearTimeout(timeoutId);
        } catch (fetchError) {
          clearTimeout(timeoutId);
          // A redirect to an internal host during the test must reject, not silently save.
          if (fetchError instanceof SsrfError) {
            return res.status(400).json({
              error: 'Invalid blog settings',
              message: `Base URL is not allowed: ${fetchError.message}`,
            });
          }
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
