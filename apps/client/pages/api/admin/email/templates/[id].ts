import { emailTemplateRepository } from '@bike4mind/database';
import { EmailCategory } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, ForbiddenError, NotFoundError } from '@server/utils/errors';

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

    const { name, slug, description, subject, htmlContent, textContent, category, variables, isActive } = req.body as {
      name?: string;
      slug?: string;
      description?: string;
      subject?: string;
      htmlContent?: string;
      textContent?: string;
      category?: EmailCategory;
      variables?: string[];
      isActive?: boolean;
    };

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
