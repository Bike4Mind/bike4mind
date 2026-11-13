export type DocumentationCategory =
  | 'admin-settings'
  | 'architecture'
  | 'development'
  | 'migration'
  | 'api'
  | 'agents'
  | 'features'
  | 'client-side'
  | 'aws'
  | 'artifacts'
  | 'security'
  | 'databases'
  | 'testing'
  | 'onboarding'
  | 'files'
  | 'tags'
  | 'general';

export interface DocumentationItem {
  id: string;
  title: string;
  description: string;
  category: DocumentationCategory;
  tags: string[];
  docusaurusUrl: string;
  // Docusaurus specific metadata
  sidebar_position?: number;
  feature_status?: string;
  audience?: string[];
  spiciness?: string;
  visibility?: string;
  maturity?: string;
}

/** Sentence-case labels, in the order the category tabs show them. */
export const DOCUMENTATION_CATEGORY_LABELS: Record<DocumentationCategory, string> = {
  'admin-settings': 'Admin settings',
  architecture: 'Architecture',
  development: 'Development',
  migration: 'Migration',
  api: 'API reference',
  agents: 'Agents',
  features: 'Features',
  'client-side': 'Client-side',
  aws: 'AWS',
  artifacts: 'Artifacts',
  security: 'Security',
  databases: 'Databases',
  testing: 'Testing',
  onboarding: 'Onboarding',
  files: 'Files',
  tags: 'Tags search',
  general: 'General',
};

export const isDocumentationCategory = (value: string): value is DocumentationCategory =>
  Object.hasOwn(DOCUMENTATION_CATEGORY_LABELS, value);

/** The server infers categories from paths, so an unknown one falls back to its raw name. */
export const documentationCategoryLabel = (category: string): string =>
  isDocumentationCategory(category) ? DOCUMENTATION_CATEGORY_LABELS[category] : category;

type DocusaurusMetaResponse = {
  success?: boolean;
  docs?: Array<Omit<DocumentationItem, 'tags'> & { tags?: string[] }>;
};

/** Fetches Docusaurus documentation metadata from the API; throws when the request or payload fails. */
export async function fetchDocusaurusData(): Promise<DocumentationItem[]> {
  const response = await fetch('/api/documentation/docusaurus-meta');
  if (!response.ok) throw new Error(`Request failed with status ${response.status}`);
  const data: DocusaurusMetaResponse = await response.json();
  if (!data.success || !Array.isArray(data.docs)) throw new Error('The docs metadata response was not a success');

  return data.docs.map((doc): DocumentationItem => ({
    id: doc.id,
    title: doc.title,
    description: doc.description,
    category: doc.category,
    tags: doc.tags || [],
    docusaurusUrl: doc.docusaurusUrl,
    sidebar_position: doc.sidebar_position,
    feature_status: doc.feature_status,
    audience: doc.audience,
    spiciness: doc.spiciness,
    visibility: doc.visibility,
    maturity: doc.maturity,
  }));
}
