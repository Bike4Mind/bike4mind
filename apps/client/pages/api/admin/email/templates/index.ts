import { emailTemplateRepository } from '@bike4mind/database';
import { EmailCategory } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, ForbiddenError } from '@server/utils/errors';

const handler = baseApi()
  .get(async (req, res) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

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
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

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

    return res.status(201).json(template);
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
