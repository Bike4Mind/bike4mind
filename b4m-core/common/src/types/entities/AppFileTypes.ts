import { IBaseRepository, type IMongoDocument } from '.';

export interface IAppFile {
  userId: string;
  name: string;
  size: number;
  path: string;
  mimeType: string;
  tags?: string[];
  status?: 'pending' | 'complete';
  description?: string;
}

export interface IAppFileDocument extends IAppFile, IMongoDocument {}

export interface IAppFileRepository extends IBaseRepository<IAppFileDocument> {}

export type IAppFileGetAllApiResponse = Array<
  Omit<IAppFileDocument, 'userId'> & {
    userId: {
      name: string;
      email: string;
    };
  }
>;

/**
 * AppFile tags that are reserved for specific purposes
 */
export enum AppFileReservedTags {
  /** AppFiles with this tag are considered Organization Logos */
  OrganizationLogo = 'organization-logo',
  ProfilePhoto = 'profile-photo',
  /** AppFiles with this tag are considered Admin/System Logos (Light Mode) */
  AdminLogo = 'admin-logo',
  /** AppFiles with this tag are considered Admin/System Logos (Dark Mode) */
  AdminDarkLogo = 'admin-dark-logo',
  /** AppFiles with this tag are custom DOCX export templates */
  DocxTemplate = 'docx-template',
}
