/**
 * Docusaurus Documentation Metadata API
 *
 * This API dynamically scans the docs-site directory and returns metadata
 * for all documentation files with Docusaurus URLs pointing to production.
 */

import type { NextApiRequest, NextApiResponse } from 'next';

export interface DocusaurusDoc {
  id: string;
  title: string;
  description: string;
  category: string;
  tags: string[];
  docusaurusUrl: string;
  sidebar_position?: number;
  feature_status?: string;
  audience?: string[];
  spiciness?: string;
  visibility?: string;
  maturity?: string;
}

function inferCategory(filePath: string): string {
  const parts = filePath.split('/');

  // Check for tag pages first
  if (parts.includes('tags')) return 'tags';

  // Map directory structure to categories
  if (parts.includes('agents')) return 'agents';
  if (parts.includes('features')) return 'features';
  if (parts.includes('technical_docs')) {
    if (parts.includes('dev-sided')) return 'development';
    if (parts.includes('client-sided')) return 'client-side';
    if (parts.includes('aws')) return 'aws';
    if (parts.includes('Artifacts')) return 'artifacts';
    return 'architecture';
  }
  if (parts.includes('security')) return 'security';
  if (parts.includes('databases')) return 'databases';
  if (parts.includes('testing')) return 'testing';
  if (parts.includes('new-customers')) return 'onboarding';
  if (parts.includes('files')) return 'files';

  return 'general';
}

function generateId(filePath: string): string {
  // Generate a unique ID from the file path
  return filePath
    .replace(/\.md$/, '')
    .replace(/\//g, '-')
    .replace(/[^a-zA-Z0-9-]/g, '')
    .toLowerCase();
}

export default async function handler(_req: NextApiRequest, res: NextApiResponse) {
  try {
    // Docs are served from `docs.<SERVER_DOMAIN>` (see deploy-docs.yml). The host is
    // account-tied, so derive it from the deployment's SERVER_DOMAIN with no brand
    // fallback. When unconfigured, return empty metadata rather than
    // fetching Bike4Mind's docs.
    const serverDomain = process.env.SERVER_DOMAIN ?? '';
    const docsHost = serverDomain ? `docs.${serverDomain}` : '';
    if (!docsHost) {
      return res.status(200).json({ success: true, count: 0, docs: [] });
    }
    const docsOrigin = `https://${docsHost}/`;

    // Fetch documentation metadata from the production Docusaurus site.
    const productionSitemapUrl = `${docsOrigin}sitemap.xml`;

    // Add timeout protection for external fetch
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

    let response: Response;
    try {
      response = await fetch(productionSitemapUrl, { signal: controller.signal });
      clearTimeout(timeoutId);
    } catch (fetchError) {
      clearTimeout(timeoutId);
      if (fetchError instanceof Error && fetchError.name === 'AbortError') {
        throw new Error('Sitemap fetch timed out after 10s');
      }
      throw fetchError;
    }
    if (!response.ok) {
      throw new Error(`Failed to fetch sitemap: ${response.statusText}`);
    }

    const sitemapXml = await response.text();
    const docs: DocusaurusDoc[] = [];

    // Extract URLs from sitemap
    const urlMatches = sitemapXml.match(/<loc>(.*?)<\/loc>/g);
    if (urlMatches) {
      for (const urlMatch of urlMatches) {
        const url = urlMatch.replace(/<\/?loc>/g, '');

        // Skip non-documentation URLs
        if (!url.includes(`${docsHost}/`) || url === docsOrigin) {
          continue;
        }

        // Extract path from URL
        const urlPath = url.replace(docsOrigin, '');

        // Infer category from URL path
        const category = inferCategory(urlPath);

        // Generate title from URL path
        const pathParts = urlPath.replace(/\/$/, '').split('/'); // Remove trailing slash first
        const title =
          pathParts
            .pop()
            ?.replace(/-/g, ' ')
            .replace(/\b\w/g, l => l.toUpperCase()) || 'Untitled';

        // Generate ID from URL path
        const id = generateId(urlPath);

        docs.push({
          id,
          title,
          description: `Documentation for ${title}`,
          category,
          tags: [],
          docusaurusUrl: url,
        });
      }
    }

    // If no docs found from sitemap, use fallback static list
    if (docs.length === 0) {
      const fallbackDocs = [
        {
          id: 'getting-started',
          title: 'Getting Started',
          description: 'Start here to learn the basics',
          category: 'general',
          tags: ['beginner', 'setup'],
          docusaurusUrl: `${docsOrigin}getting-started`,
        },
        {
          id: 'admin-settings',
          title: 'Admin Settings',
          description: 'Configure system settings',
          category: 'admin-settings',
          tags: ['admin', 'configuration'],
          docusaurusUrl: `${docsOrigin}admin-settings`,
        },
        {
          id: 'api-reference',
          title: 'API Reference',
          description: 'Complete API documentation',
          category: 'api',
          tags: ['api', 'reference'],
          docusaurusUrl: `${docsOrigin}api-reference`,
        },
      ];
      docs.push(...fallbackDocs);
    }

    // Sort by category and then by title
    docs.sort((a, b) => {
      if (a.category !== b.category) {
        return a.category.localeCompare(b.category);
      }
      return a.title.localeCompare(b.title);
    });

    res.status(200).json({
      success: true,
      count: docs.length,
      docs,
    });
  } catch (error) {
    console.error('Error fetching Docusaurus docs from production:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch documentation from production site',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
