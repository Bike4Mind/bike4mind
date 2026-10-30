import { z } from 'zod';

const pageTextBlockSchema = z.object({
  id: z.string().regex(/^b\d+$/),
  kind: z.literal('text'),
  text: z.string(),
});

const pageHeadingBlockSchema = z.object({
  id: z.string().regex(/^b\d+$/),
  kind: z.literal('heading'),
  level: z.number().int().min(1).max(6),
  text: z.string(),
});

const pageImageBlockSchema = z.object({
  id: z.string().regex(/^b\d+$/),
  kind: z.literal('image'),
  alt: z.string(),
});

const pageLandmarkBlockSchema = z.object({
  id: z.string().regex(/^b\d+$/),
  kind: z.literal('landmark'),
  role: z.enum(['dialog', 'alertdialog', 'alert', 'status']),
});

export const pageContentBlockSchema = z.discriminatedUnion('kind', [
  pageTextBlockSchema,
  pageHeadingBlockSchema,
  pageImageBlockSchema,
  pageLandmarkBlockSchema,
]);

const pageClickActionSchema = z.object({
  ref: z.string().regex(/^[1-9]\d*$/),
  kind: z.literal('click'),
  element: z.string().min(1),
  label: z.string(),
  href: z.string().optional(),
});

const pageTypeActionSchema = z.object({
  ref: z.string().regex(/^[1-9]\d*$/),
  kind: z.literal('type'),
  element: z.enum(['input', 'textarea', 'editable']),
  label: z.string(),
  inputType: z.string().optional(),
});

const pageSelectActionSchema = z.object({
  ref: z.string().regex(/^[1-9]\d*$/),
  kind: z.literal('select'),
  element: z.literal('select'),
  label: z.string(),
});

const pageToggleActionSchema = z.object({
  ref: z.string().regex(/^[1-9]\d*$/),
  kind: z.literal('toggle'),
  element: z.enum(['checkbox', 'radio', 'switch']),
  label: z.string(),
});

export const pageActionSchema = z.discriminatedUnion('kind', [
  pageClickActionSchema,
  pageTypeActionSchema,
  pageSelectActionSchema,
  pageToggleActionSchema,
]);

export const pageClaimSchema = z.object({
  id: z.string().regex(/^c\d+$/),
  text: z.string(),
  source: z.object({
    blockId: z.string().regex(/^b\d+$/),
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
  }),
});

export const browserPageModelSchema = z
  .object({
    url: z.string(),
    title: z.string(),
    capturedAt: z.string().datetime({ offset: true }),
    blocks: z.array(pageContentBlockSchema),
    actions: z.array(pageActionSchema),
    claims: z.array(pageClaimSchema),
    truncated: z.boolean(),
  })
  .superRefine((model, context) => {
    const blocks = new Map(model.blocks.map(block => [block.id, block]));
    for (const [kind, items] of [['blocks', model.blocks], ['claims', model.claims]] as const) {
      const ids = new Set<string>();
      for (const [index, item] of items.entries()) {
        if (ids.has(item.id)) {
          context.addIssue({ code: 'custom', message: `Duplicate ${kind} id ${item.id}`, path: [kind, index, 'id'] });
        }
        ids.add(item.id);
      }
    }
    const refs = new Set<string>();
    for (const action of model.actions) {
      if (refs.has(action.ref)) {
        context.addIssue({ code: 'custom', message: `Duplicate action ref ${action.ref}`, path: ['actions'] });
      }
      refs.add(action.ref);
    }
    for (const [index, claim] of model.claims.entries()) {
      const block = blocks.get(claim.source.blockId);
      if (!block || !('text' in block)) {
        context.addIssue({ code: 'custom', message: 'Claim source block is missing text', path: ['claims', index] });
        continue;
      }
      if (
        claim.source.start > claim.source.end ||
        claim.source.end > block.text.length ||
        block.text.slice(claim.source.start, claim.source.end) !== claim.text
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Claim text does not match its source span',
          path: ['claims', index],
        });
      }
    }
  });

export const browserSnapshotSchema = z.object({
  url: z.string(),
  title: z.string(),
  text: z.string(),
  truncated: z.boolean(),
  model: browserPageModelSchema,
});

export type PageContentBlock = z.infer<typeof pageContentBlockSchema>;
export type PageAction = z.infer<typeof pageActionSchema>;
export type PageClaim = z.infer<typeof pageClaimSchema>;
export type BrowserPageModel = z.infer<typeof browserPageModelSchema>;
export type BrowserSnapshot = z.infer<typeof browserSnapshotSchema>;
