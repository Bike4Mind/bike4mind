import { z } from 'zod';
import { defineAdminTool } from '../defineAdminTool';
import { ADMIN_GUIDE, searchAdminGuide } from '../guide';

const MAX_MATCHES = 3;

const SearchGuideInput = z.object({
  query: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe('The admin feature or task in plain words, e.g. "AI advisories" or "grant credits to an organization".'),
});

export const searchGuideTool = defineAdminTool({
  name: 'admin_search_guide',
  description:
    'Search the admin feature guide: what an admin feature is, which admin views show it (navigate_view ids, the first is where to send the admin), which settings control it, and how to use it. Returns up to 3 entries, best first, or none when the guide does not cover the question.',
  input: SearchGuideInput,
  run: async ({ query }) => {
    const matches = searchAdminGuide(ADMIN_GUIDE, query, MAX_MATCHES);
    return {
      ok: true,
      data: {
        query,
        entries: matches.map(({ entry }) => ({
          id: entry.id,
          title: entry.title,
          summary: entry.summary,
          views: entry.views,
          settings: entry.settings,
          howTo: entry.howTo,
        })),
        ...(matches.length === 0 && {
          note: 'No guide entry matched this query.',
        }),
      },
    };
  },
});
