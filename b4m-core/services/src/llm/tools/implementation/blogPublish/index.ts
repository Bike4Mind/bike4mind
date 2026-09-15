import { ToolDefinition } from '../../base/types';
import { IUserDocument } from '@bike4mind/common';

interface BlogPublishParams {
  title: string;
  content: string;
  summary?: string;
  tags?: string[];
  status?: 'draft' | 'published';
}

interface BlogPublishResponse {
  post: {
    postId: string;
    title: string;
    status: string;
    createdAt: number;
    updatedAt: number;
  };
}

async function publishToBlog(user: IUserDocument, params: BlogPublishParams): Promise<string> {
  // Check user's blog integration settings

  if (!user?.blogIntegration) {
    throw new Error(
      'Blog integration not configured. Please add your blog API key in Settings → Integrations → Blog Publishing.'
    );
  }

  const { apiKey, baseUrl, defaultAuthor, defaultTags } = user.blogIntegration;

  // Prepare request body
  const requestBody = {
    title: params.title,
    content: params.content,
    summary: params.summary,
    tags: params.tags || defaultTags || [],
    status: params.status || 'published',
    author: defaultAuthor || user.name || 'Unknown',
  };

  // Make HTTP POST request to blog API
  const response = await fetch(`${baseUrl}/api/posts`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey,
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to publish blog post: ${response.status} ${response.statusText}. ${errorText}`);
  }

  const data: BlogPublishResponse = await response.json();

  // Return success message with published URL
  const publishedUrl = `${baseUrl}/blog/post/${data.post.postId}`;
  const statusText = params.status === 'draft' ? 'saved as draft' : 'published';

  return `✅ Blog post "${params.title}" ${statusText} successfully!\n\n🔗 URL: ${publishedUrl}\n\n📝 Post ID: ${data.post.postId}`;
}

export const blogPublishTool: ToolDefinition = {
  name: 'blog_publish',
  implementation: context => ({
    toolFn: async value => {
      const params = value as BlogPublishParams;
      return publishToBlog(context.user, params);
    },
    toolSchema: {
      name: 'blog_publish',
      description:
        "⚠️ ADVANCED USE ONLY: DO NOT use this for normal blogging requests! This tool bypasses the preview step. ONLY use when: (1) User provides exact pre-formatted title, content, summary, and tags, OR (2) User explicitly says 'publish without preview'. For normal requests like 'publish to my blog' or 'blog this conversation', use blog_draft tool instead. That tool creates a preview for user review first.",
      parameters: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'The title of the blog post',
          },
          content: {
            type: 'string',
            description: 'The main content of the blog post in markdown format',
          },
          summary: {
            type: 'string',
            description: 'Optional summary or excerpt of the blog post',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional array of tags/categories for the post',
          },
          status: {
            type: 'string',
            description: 'Publication status: "draft" to save as draft, "published" to publish immediately',
            enum: ['draft', 'published'],
          },
        },
        required: ['title', 'content'],
      },
    },
  }),
};
