import { emailTemplateRepository } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError, NotFoundError } from '@server/utils/errors';

/**
 * Clone an existing email template to create a new one
 */
const handler = baseApi().post(async (req, res) => {
  if (!req.user?.isAdmin) {
    throw new ForbiddenError('Unauthorized. Admin access required.');
  }

  const { id } = req.query as { id: string };

  const existing = await emailTemplateRepository.findById(id);
  if (!existing) {
    throw new NotFoundError('Template not found');
  }

  // Generate a unique slug
  const baseSlug = existing.slug.replace(/-copy(-\d+)?$/, '');
  let newSlug = `${baseSlug}-copy`;
  let counter = 1;

  // Check if slug exists and increment counter if needed
  while (await emailTemplateRepository.findBySlug(newSlug)) {
    newSlug = `${baseSlug}-copy-${counter}`;
    counter++;
  }

  // Create a new template based on the existing one
  const cloned = await emailTemplateRepository.create({
    name: `${existing.name} (Copy)`,
    slug: newSlug,
    description: existing.description,
    subject: existing.subject,
    htmlContent: existing.htmlContent,
    textContent: existing.textContent,
    category: existing.category,
    variables: existing.variables,
    isActive: false, // Start as inactive so admin can review before activating
    createdBy: req.user.id,
  });

  return res.status(201).json(cloned);
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
