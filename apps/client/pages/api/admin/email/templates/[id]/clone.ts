import { emailTemplateRepository } from '@bike4mind/database';
import { adminApi } from '@server/middlewares/adminApi';
import { NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { ApiKeyScope } from '@bike4mind/common';
import { recordAdminActionFromRequest } from '@server/utils/adminAudit';

/**
 * Clone an existing email template to create a new one
 */
const handler = adminApi({
  adminPermissions: { POST: 'settings:manage' },
  requiredScopes: [ApiKeyScope.ADMIN],
}).post(async (req, res) => {
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

  await recordAdminActionFromRequest(req, {
    action: 'email.template.cloned',
    target: { kind: 'settings', id: cloned.id, displayName: cloned.name },
    summary: `cloned email template ${existing.name}`,
    details: { sourceTemplateId: id, slug: cloned.slug },
  });

  return res.status(201).json(cloned);
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
