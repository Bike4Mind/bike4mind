import { emailTemplateRepository } from '@bike4mind/database';
import { EmailCategory } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, ForbiddenError, NotFoundError } from '@server/utils/errors';
import { z } from 'zod';

// The spread below reaches `BaseRepository.update`, which builds a `$set` -- so these cast
// before validators run. `isActive` is Boolean-typed (throws `CastError kind='Boolean'` on 2,
// {} or []), `variables` is `[String]` (throws on an object element), and the six String paths
// throw on an array or object. Types only: `category` stays a plain string here because an
// out-of-enum value is a mongoose validator failure, not a cast, and so is 500 either way.
const updateBodySchema = z.object({
  name: z.string().optional(),
  slug: z.string().optional(),
  description: z.string().optional(),
  subject: z.string().optional(),
  htmlContent: z.string().optional(),
  textContent: z.string().optional(),
  category: z.string().optional(),
  variables: z.array(z.string()).optional(),
  isActive: z.boolean().optional(),
});

const handler = baseApi()
  .get(async (req, res) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    const { id } = req.query as { id: string };

    const template = await emailTemplateRepository.findById(id);
    if (!template) {
      throw new NotFoundError('Template not found');
    }

    return res.json(template);
  })
  .put(async (req, res) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    const { id } = req.query as { id: string };

    const existing = await emailTemplateRepository.findById(id);
    if (!existing) {
      throw new NotFoundError('Template not found');
    }

    const parsedBody = updateBodySchema.safeParse(req.body);
    if (!parsedBody.success) {
      throw new BadRequestError('Invalid request body');
    }
    const { name, slug, description, subject, htmlContent, textContent, variables, isActive } = parsedBody.data;
    const category = parsedBody.data.category as EmailCategory | undefined;

    // If slug is being changed, check for conflicts
    if (slug && slug !== existing.slug) {
      const conflict = await emailTemplateRepository.findBySlug(slug);
      if (conflict) {
        throw new BadRequestError('A template with this slug already exists');
      }
    }

    const updated = await emailTemplateRepository.update({
      id,
      ...(name !== undefined && { name }),
      ...(slug !== undefined && { slug }),
      ...(description !== undefined && { description }),
      ...(subject !== undefined && { subject }),
      ...(htmlContent !== undefined && { htmlContent }),
      ...(textContent !== undefined && { textContent }),
      ...(category !== undefined && { category }),
      ...(variables !== undefined && { variables }),
      ...(isActive !== undefined && { isActive }),
    });

    return res.json(updated);
  })
  .delete(async (req, res) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    const { id } = req.query as { id: string };

    const existing = await emailTemplateRepository.findById(id);
    if (!existing) {
      throw new NotFoundError('Template not found');
    }

    await emailTemplateRepository.delete(id);

    return res.json({ success: true });
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
