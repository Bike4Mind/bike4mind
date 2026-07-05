import { useQuery } from '@tanstack/react-query';
import { useHelpIndex } from './useHelpIndex';

/**
 * Strips frontmatter from markdown content
 */
const stripFrontmatter = (content: string): string => {
  // Match frontmatter block at the start of the file
  const frontmatterRegex = /^---[\s\S]*?---\n*/;
  return content.replace(frontmatterRegex, '');
};

/**
 * Fetch markdown content for a help article
 */
const fetchHelpContent = async (filePath: string): Promise<string> => {
  // Fetch from bundled static content (same in dev and prod)
  const response = await fetch(`/help-content/${filePath}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch help content: ${response.statusText}`);
  }
  const content = await response.text();
  return stripFrontmatter(content);
};

/**
 * Hook to fetch help content for a given slug
 */
export const useHelpContent = (slug: string) => {
  const { data: index } = useHelpIndex();

  // Find the entry to get the file path
  const entry = index?.entries.find(e => e.slug === slug);
  const filePath = entry?.filePath;

  const query = useQuery({
    queryKey: ['help-content', slug],
    queryFn: () => {
      if (!filePath) {
        throw new Error(`No help entry found for slug: ${slug}`);
      }
      return fetchHelpContent(filePath);
    },
    enabled: !!filePath,
    staleTime: 5 * 60 * 1000, // 5 minutes
    gcTime: 30 * 60 * 1000, // 30 minutes
  });

  // Expose the resolved file path so callers can resolve relative links against
  // the article's file path rather than its slug (index pages drop "/index").
  return { ...query, filePath };
};

export default useHelpContent;
