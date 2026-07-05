import { IResearchLinkCategoryDocument, IResearchLinkDocument } from '@bike4mind/common';
import { z } from 'zod';

const BaseQuery = z.object({
  pageSize: z.coerce.number().int().positive().prefault(50),
  pageNumber: z.coerce.number().int().positive().prefault(1),
  sort: z.string().optional(),
});

export const BusinessLinkCategoriesQuery = BaseQuery.extend({
  filters: z
    .object({
      name: z.string().optional(),
    })
    .optional(),
});

export type IResearchLinkCategoriesQuery = z.infer<typeof BusinessLinkCategoriesQuery>;

export const BusinessLinksQuery = BaseQuery.extend({
  filters: z
    .object({
      search: z.string().optional(),
      categoryId: z.string().optional(),
    })
    .optional(),
});

export type IResearchLinksQuery = z.infer<typeof BusinessLinksQuery>;

interface PopularTarget {
  company: string;
  ticker: string;
  url: string;
  category: 'tech' | 'finance' | 'healthcare' | 'energy';
}

export interface DataSource {
  category: string;
  title: string;
  description: string;
  targets: PopularTarget[];
}

export type DataSourceType = 'earnings' | 'press' | 'ai' | 'jobs' | 'ma' | 'sec' | 'products' | 'news';

export interface IResearchLinkWithCategory extends IResearchLinkDocument {
  category: IResearchLinkCategoryDocument;
}
