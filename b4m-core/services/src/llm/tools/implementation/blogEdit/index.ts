import { ToolDefinition } from '../../base/types';
import { IUserDocument } from '@bike4mind/common';

interface BlogEditParams {
  postId: string;
  title?: string;
  content?: string;
  summary?: string;
  tags?: string[];
  status?: 'draft' | 'published';
  publishedAt?: number; // Unix timestamp in milliseconds
}

async function editBlogPost(user: IUserDocument, params: BlogEditParams): Promise<string> {
  // Check user's blog integration settings

  if (!user?.blogIntegration) {
    throw new Error(
      'Blog integration not configured. Please add your blog API key in Settings → Integrations → Blog Publishing.'
    );
  }

  const { apiKey, baseUrl } = user.blogIntegration;

  // Build update payload - only include fields that were provided
  const updatePayload: Record<string, any> = {};
  if (params.title !== undefined) updatePayload.title = params.title;
  if (params.content !== undefined) updatePayload.content = params.content;
  if (params.summary !== undefined) updatePayload.summary = params.summary;
  if (params.tags !== undefined) updatePayload.tags = params.tags;
  if (params.status !== undefined) updatePayload.status = params.status;
  if (params.publishedAt !== undefined) updatePayload.publishedAt = params.publishedAt;

  // Make HTTP PUT request to blog API
  const response = await fetch(`${baseUrl}/api/posts/${params.postId}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey,
    },
    body: JSON.stringify(updatePayload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to edit blog post: ${response.status} ${response.statusText}. ${errorText}`);
  }

  const data = await response.json();
  const post = data.post;

  // Build success message
  const changes: string[] = [];
  if (params.title !== undefined) changes.push(`title updated to "${params.title}"`);
  if (params.status !== undefined) changes.push(`status changed to ${params.status}`);
  if (params.summary !== undefined) changes.push(`summary updated`);
  if (params.tags !== undefined) changes.push(`tags updated to [${params.tags.join(', ')}]`);
  if (params.content !== undefined) changes.push(`content updated`);
  if (params.publishedAt !== undefined) {
    const date = new Date(params.publishedAt).toISOString().split('T')[0];
    changes.push(`publish date set to ${date}`);
  }

  const changesText = changes.length > 0 ? `\n\n📝 Changes:\n  - ${changes.join('\n  - ')}` : '';

  // Return success message with URL if published
  const publishedUrl = post.status === 'published' ? `\n\n🔗 URL: ${baseUrl}/blog/post/${params.postId}` : '';

  return `✅ Blog post edited successfully!${changesText}${publishedUrl}\n\n📝 Post ID: ${params.postId}`;
}

export const blogEditTool: ToolDefinition = {
  name: 'blog_edit',
  implementation: context => ({
    toolFn: async value => {
      const params = value as BlogEditParams;
      return editBlogPost(context.user, params);
    },
    toolSchema: {
      name: 'blog_edit',
      description:
        "EDITING STEP: Edits an existing blog post on the user's configured blog. Use this when the user asks to edit, update, or change a post, mark it as draft/published, or modify any post fields. Only provide the fields that need to be edited.",
      parameters: {
        type: 'object',
        properties: {
          postId: {
            type: 'string',
            description: 'The unique ID of the post to edit (e.g., 67204c06-9c61-4b3c-bf93-d6ea4c5ec84c)',
          },
          title: {
            type: 'string',
            description: 'Optional new title for the post',
          },
          content: {
            type: 'string',
            description: 'Optional new content in markdown format',
          },
          summary: {
            type: 'string',
            description: 'Optional new summary or excerpt',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional new array of tags/categories',
          },
          status: {
            type: 'string',
            description:
              'Optional status update: "draft" to unpublish/hide, "published" to make live. Use "draft" when user says "mark as draft", "unpublish", or "hide". Use "published" when user says "publish", "make live", or "mark as published".',
            enum: ['draft', 'published'],
          },
          publishedAt: {
            type: 'number',
            description:
              'Optional publish date as Unix timestamp in milliseconds. Use this when the user wants to change the post\'s publish date. Example: new Date("2025-01-15").getTime() = 1736899200000. This affects the post\'s display date and sorting order.',
          },
        },
        required: ['postId'],
      },
    },
  }),
};
