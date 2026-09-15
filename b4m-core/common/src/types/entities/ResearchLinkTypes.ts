import { type IMongoDocument } from '.';

export interface IResearchLinkCategory {
  name: string;
  description: string;
}

export interface IResearchLinkCategoryDocument extends IResearchLinkCategory, IMongoDocument {}
export interface IResearchLink {
  name: string;
  url: string;
  ticker: string;
  type: string;
  categoryId: IResearchLinkCategoryDocument['id'] | null;
}

export interface IResearchLinkDocument extends IResearchLink, IMongoDocument {}
