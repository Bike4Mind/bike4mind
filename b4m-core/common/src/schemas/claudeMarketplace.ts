import { z } from 'zod';

/**
 * Wire schemas for the Skill Market's Claude Code plugin feed
 * (api-contract/contracts/skillMarket.contract.ts). The 200 body is a Claude Code
 * `marketplace.json`, so its field names follow Claude Code, not this API's snake_case.
 */
export const ClaudeMarketplaceQuerySchema = z.object({
  orgId: z.string().min(1),
});

export const ClaudePluginZipParamSchema = z.object({
  id: z.string().min(1),
});

export const ClaudePluginZipQuerySchema = z.object({
  version: z.coerce.number().int().positive().optional(),
});

export const ClaudeMarketplacePluginSchema = z.object({
  name: z.string(),
  description: z.string(),
  /**
   * A listing's approved version number, or a bundle's content hash prefix; Claude Code offers an
   * update when it changes (it compares for equality, not order).
   */
  version: z.string(),
  source: z.object({
    source: z.literal('archive'),
    url: z.string(),
    sha256: z.string(),
  }),
});

export const ClaudeMarketplaceSchema = z.object({
  name: z.string(),
  owner: z.object({ name: z.string() }),
  /** Claude Code uninstalls installed plugins this feed stops listing, at the next session start. */
  forceRemoveDeletedPlugins: z.boolean(),
  plugins: z.array(ClaudeMarketplacePluginSchema),
});
export type ClaudeMarketplace = z.infer<typeof ClaudeMarketplaceSchema>;
export type ClaudeMarketplacePlugin = z.infer<typeof ClaudeMarketplacePluginSchema>;
