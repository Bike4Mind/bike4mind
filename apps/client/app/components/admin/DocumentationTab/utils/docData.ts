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

// Fetches Docusaurus documentation metadata from the API
export async function fetchDocusaurusData(): Promise<DocumentationItem[]> {
  try {
    const response = await fetch('/api/documentation/docusaurus-meta');
    const data = await response.json();

    if (data.success && data.docs) {
      return data.docs.map(
        (doc: any): DocumentationItem => ({
          id: doc.id,
          title: doc.title,
          description: doc.description,
          category: doc.category as DocumentationCategory,
          tags: doc.tags || [],
          docusaurusUrl: doc.docusaurusUrl,
          sidebar_position: doc.sidebar_position,
          feature_status: doc.feature_status,
          audience: doc.audience,
          spiciness: doc.spiciness,
          visibility: doc.visibility,
          maturity: doc.maturity,
        })
      );
    }

    throw new Error('Failed to fetch documentation from API');
  } catch (error) {
    console.error('Error fetching Docusaurus data:', error);
    // Return empty array instead of fallback data
    return [];
  }
}
