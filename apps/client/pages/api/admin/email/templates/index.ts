import { emailTemplateRepository } from '@bike4mind/database';
import { ApiKeyScope, EmailCategory } from '@bike4mind/common';
import { adminApi } from '@server/middlewares/adminApi';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import { recordAdminActionFromRequest } from '@server/utils/adminAudit';

const handler = adminApi({
  adminPermissions: { GET: 'support:read', POST: 'settings:manage' },
  requiredScopes: [ApiKeyScope.ADMIN],
})
  .get(async (req, res) => {
    const {
      page = '1',
      limit = '20',
      search,
      category,
    } = req.query as {
      page?: string;
      limit?: string;
      search?: string;
      category?: EmailCategory;
    };

    const result = await emailTemplateRepository.listTemplates({
      page: parseInt(page, 10),
      limit: parseInt(limit, 10),
      search,
      category,
    });

    return res.json(result);
  })
  .post(async (req, res) => {
    const {
      name,
      slug,
      description,
      subject,
      htmlContent,
      textContent,
      category,
      variables = [],
      isActive = true,
    } = req.body as {
      name: string;
      slug: string;
      description?: string;
      subject: string;
      htmlContent: string;
      textContent?: string;
      category: EmailCategory;
      variables?: string[];
      isActive?: boolean;
    };

    if (!name || !slug || !subject || !htmlContent || !category) {
      throw new BadRequestError('Name, slug, subject, htmlContent, and category are required');
    }

    // Check if slug already exists
    const existing = await emailTemplateRepository.findBySlug(slug);
    if (existing) {
      throw new BadRequestError('A template with this slug already exists');
    }

    const template = await emailTemplateRepository.create({
      name,
      slug,
      description,
      subject,
      htmlContent,
      textContent,
      category,
      variables,
      isActive,
      createdBy: req.user.id,
    });

    await recordAdminActionFromRequest(req, {
      action: 'email.template.created',
      target: { kind: 'settings', id: template.id, displayName: template.name },
      summary: `created email template ${template.name}`,
      details: { slug: template.slug, category: template.category, isActive: template.isActive },
    });

    return res.status(201).json(template);
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
