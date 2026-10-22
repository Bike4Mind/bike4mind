import { detectURLs } from '@bike4mind/fab-pipeline';

export const GATHERING_DATA_SOURCES_STATUS = 'Gathering data sources...';
export const PREPARING_CONTEXT_STATUS = 'Preparing context...';

export type DataSourceStatusInput = {
  message: string;
  sessionFabFileIds?: readonly string[];
  messageFileIds?: readonly string[];
  knowledgeIds?: readonly string[];
  forceKnowledgeRetrieval?: boolean;
};

/**
 * True when this turn has anything for the data-source phase to gather: attached fab files (session
 * or message), session knowledge ids, forced knowledge retrieval, or a URL in the prompt.
 *
 * Admin/user system files are deliberately not counted - they are always-on prompt context, so
 * counting them would keep the data-source status on every turn of an instance that configures them.
 */
export function turnGathersDataSources(input: DataSourceStatusInput): boolean {
  const hasIds = (ids: readonly string[] | undefined) => (ids?.length ?? 0) > 0;
  return (
    hasIds(input.sessionFabFileIds) ||
    hasIds(input.messageFileIds) ||
    hasIds(input.knowledgeIds) ||
    input.forceKnowledgeRetrieval === true ||
    // detectURLs, not hasURLs: URL_REGEX is global, so hasURLs' .test() leaves lastIndex advanced and
    // the later hasURLs guard in processUrlsFromPrompt would then skip fetching the URL.
    detectURLs(input.message).length > 0
  );
}

export function resolveDataSourceStatus(input: DataSourceStatusInput): string {
  return turnGathersDataSources(input) ? GATHERING_DATA_SOURCES_STATUS : PREPARING_CONTEXT_STATUS;
}
