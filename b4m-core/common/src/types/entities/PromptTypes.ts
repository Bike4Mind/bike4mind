import { IMongoDocument, IBaseRepository } from '.';

export interface IPrompt {
  type: string;
  name: string;
  promptText: string;
  tags?: Array<string> | null;
}

export interface IPromptDocument extends IPrompt, IMongoDocument {}

export interface IPromptRepository extends IBaseRepository<IPromptDocument> {
  findAllByName: (name: string) => Promise<IPromptDocument[]>;
  findAllByType: (type: string) => Promise<IPromptDocument[]>;
  findAllWithTags: (tags: string[]) => Promise<IPromptDocument[]>;
}
