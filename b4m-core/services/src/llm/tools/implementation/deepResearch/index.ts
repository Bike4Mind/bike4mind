import { ChatModels } from '@bike4mind/common';
import { ToolContext, ToolDefinition } from '../../base/types';
import { recordToolOperationalUsage } from '../../base/recordToolOperationalUsage';
import { OpenAIBackend, toProviderEndUserId, type CompletionInfo } from '@bike4mind/llm-adapters';
import { FirecrawlApp } from '../webfetch/firecrawlApp';

interface DeepResearchParams {
  topic: string;
}

// Searcher abstraction interfaces
export interface SearchResult {
  url?: string;
  title?: string;
  description?: string;
  content?: string;
  type: string;
}

export interface ContentExtractionResult {
  text: string;
  source: string;
}

export interface Searcher {
  name: string;
  search: (query: string) => Promise<SearchResult[]>;
  extractContent?: (urls: string[]) => Promise<ContentExtractionResult[]>;
}

interface ResearchActivity {
  type: 'search' | 'extract' | 'analyze' | 'reasoning' | 'synthesis' | 'thought';
  status: 'pending' | 'complete' | 'error';
  message: string;
  timestamp: string;
  depth: number;
}

interface ResearchSource {
  url: string;
  title: string;
  description: string;
  status: 'found' | 'analyzing' | 'complete' | 'error';
  type: string;
  timestamp: string;
}

export interface ResearchState {
  findings: Array<{ text: string; source: string }>;
  activities: ResearchActivity[];
  sources: ResearchSource[];
  depth: number;
  completed: boolean;
  nextSearchQueries: string[];
  urlToSearch: string;
  summaries: string[];
  completedSteps: number;
  totalExpectedSteps: number;
  topic: string;
  startTime?: number;
  endTime?: number;
  failedAttempts: number;
  maxFailedAttempts: number;
}

export async function performDeepResearch(
  context: ToolContext,
  params: DeepResearchParams,
  config: {
    maxDepth?: number;
    duration?: number;
    searchers?: Searcher[];
    model?: string;
    apiKeys?: {
      openai?: string | null;
      anthropic?: string | null;
      gemini?: string | null;
      bfl?: string | null;
      xai?: string | null;
      voyageai?: string | null;
      ollama?: string | null;
    };
  } = {}
): Promise<{
  success: boolean;
  error?: string;
  data: {
    findings: { text: string; source: string }[];
    finalAnalysisPrompt: string;
    completedSteps: number;
    totalSteps: number;
  };
}> {
  const maxDepth = config.maxDepth || 7;
  const duration = config.duration || 4.5; // Duration in minutes
  const startTime = Date.now();
  const timeLimit = duration * 60 * 1000; // Convert minutes to milliseconds
  let topic = params.topic;
  const log = console.log;

  log(
    `🔬 Deep Research: Starting research on "${params.topic} with maxDepth ${maxDepth} and duration ${duration} minutes"`
  );

  const state: ResearchState = {
    findings: [],
    activities: [],
    sources: [],
    depth: 0,
    completed: false,
    nextSearchQueries: [params.topic],
    completedSteps: 0,
    totalExpectedSteps: maxDepth * 3, // Estimate: search + analysis per depth
    topic: topic,
    startTime,
    summaries: [],
    urlToSearch: '',
    failedAttempts: 0,
    maxFailedAttempts: 3,
  };

  const addActivity = (activity: Omit<ResearchActivity, 'timestamp'>) => {
    const activityWithTimestamp = {
      ...activity,
      timestamp: new Date().toISOString(),
    };
    if (activity.status === 'complete') {
      state.completedSteps++;
    }

    state.activities.push(activityWithTimestamp);
    context.statusUpdate({ deepResearchState: state });
  };

  const addSource = (source: Omit<ResearchSource, 'timestamp'>) => {
    const sourceWithTimestamp = {
      ...source,
      timestamp: new Date().toISOString(),
    };
    state.sources.push(sourceWithTimestamp);
  };

  // Always include Firecrawl searcher and add any configured searchers
  let searchers: Searcher[] = [];

  // Get Firecrawl API key and create Firecrawl searcher
  const apiKeySetting = await context.db.adminSettings.findBySettingName('FirecrawlApiKey');
  if (!apiKeySetting?.settingValue) {
    log('🔬 Deep Research: Firecrawl API key not found');
    return {
      success: false,
      error: 'Firecrawl API key not configured',
      data: {
        findings: [],
        finalAnalysisPrompt: '',
        completedSteps: 0,
        totalSteps: 0,
      },
    };
  }

  const app = new FirecrawlApp({ apiKey: apiKeySetting.settingValue });
  const firecrawlSearcher: Searcher = {
    name: 'Firecrawl',
    search: async (query: string) => {
      try {
        const searchResults = await app.search(query);
        return searchResults.data.map(result => ({
          url: result.url,
          title: result.title,
          type: 'web_url',
          description: result.description,
        }));
      } catch (error) {
        log(`🔬 Deep Research: Firecrawl search failed for query "${query}":`, error);
        // Return empty array so research can continue with other searchers
        return [];
      }
    },
    extractContent: async (urls: string[]) => {
      const extractPromises = urls.map(async url => {
        try {
          if (!url) {
            return [];
          }
          addActivity({
            type: 'extract',
            status: 'pending',
            message: `Extracting content from ${url}`,
            depth: state.depth,
          });

          const result = await app.scrapeUrl(url, {
            formats: ['markdown'],
            actions: [
              {
                type: 'wait',
                milliseconds: 1000,
              },
            ],
          });

          if (result && !result.error && 'markdown' in result && result.markdown) {
            addActivity({
              type: 'extract',
              status: 'complete',
              message: `Successfully extracted content from ${url}`,
              depth: state.depth,
            });

            const textContent = result.markdown.slice(0, 10_000); // Limit to 10000 characters
            return [{ text: textContent, source: url }];
          }
          return [];
        } catch (error) {
          addActivity({
            type: 'extract',
            status: 'error',
            message: `Failed to extract content from ${url}`,
            depth: state.depth,
          });
          log(`🔬 Deep Research: Failed to extract content from ${url}:`);
          return [];
        }
      });
      const results = await Promise.all(extractPromises);
      return results.flat();
    },
  };

  // Always start with Firecrawl, then add any configured searchers
  searchers = [firecrawlSearcher];

  if (config.searchers && config.searchers.length > 0) {
    searchers.push(...config.searchers);
    log(`🔬 Deep Research: Using ${searchers.length} searcher(s): ${searchers.map(s => s.name).join(', ')}`);
  } else {
    log('🔬 Deep Research: Using Firecrawl searcher only');
  }

  if (!searchers.length) {
    throw new Error('No searchers configured');
  }

  const generateText = async (prompt: string) => {
    let result = '';

    // Always use GPT-4.1 for deep research analysis if available
    // Create a dedicated OpenAI backend if we have an OpenAI API key
    let analysisLlm = context.llm;
    let analysisModel = config.model || ChatModels.GPT4_1;

    if (config.apiKeys?.openai) {
      try {
        // Keep per-user abuse attribution when swapping off the (already
        // attributed) context.llm, since the analysis prompts carry
        // user-directed research content. The constructor expects the hashed
        // opaque id.
        analysisLlm = new OpenAIBackend(config.apiKeys.openai, context.logger, toProviderEndUserId(context.userId));
        analysisModel = ChatModels.GPT4_1;
        log('🔬 Deep Research: Using GPT-4.1 for analysis');
      } catch (error) {
        log('🔬 Deep Research: Failed to create OpenAI backend, falling back to selected model');
      }
    } else {
      log(`🔬 Deep Research: No OpenAI key available, using selected model ${config.model || 'default'} for analysis`);
    }

    let completionInfo: CompletionInfo | undefined;
    const startTime = Date.now();
    await analysisLlm.complete(
      analysisModel,
      [{ role: 'user', content: prompt }],
      { temperature: 0.1, stream: false },
      async (chunks, info) => {
        result += chunks[0] || '';
        if (info) completionInfo = info;
      }
    );

    await recordToolOperationalUsage(context, { model: analysisModel, completionInfo, startTime });
    return result;
  };

  const analyzeAndPlan = async (findings: { text: string; source: string }[]) => {
    try {
      const timeElapsed = Date.now() - startTime;
      const timeRemaining = timeLimit - timeElapsed;
      const timeRemainingMinutes = Math.round((timeRemaining / 1000 / 60) * 10) / 10;
      const prompt = `You are a research agent analyzing findings about: ${topic}
                            You have ${timeRemainingMinutes} minutes remaining to complete the research but you don't need to use all of it.
                            Current findings: ${findings.map(f => `[From ${f.source}]: ${f.text}`).join('\n')}
                            What has been learned? What gaps remain? What specific aspects should be investigated next if any?
                            If you need to search for more information, include a nextSearchTopic.
                            If you need to search for more information in a specific URL, include a urlToSearch.
                            Important: If less than 1 minute remains, set shouldContinue to false to allow time for final synthesis.
                            If I have enough information, set shouldContinue to false.

                            CRITICAL: Your response must be ONLY valid JSON. Do not include any text before or after the JSON.

                            Respond in this exact JSON format (copy exactly):
                            {
                              "analysis": {
                                "summary": "summary of findings",
                                "gaps": ["gap1", "gap2"],
                                "nextSteps": ["step1", "step2"],
                                "shouldContinue": true/false,
                                "nextSearchTopic": "optional topic",
                                "urlToSearch": "optional url"
                              }
                            }

                            Replace the placeholder values with actual content. Set shouldContinue to false if research is complete.`;

      const result = await generateText(prompt);
      log(`🔬 Deep Research: Analysis result ${timeRemainingMinutes} minutes remaining`);
      const parsed = JSON.parse(result);
      return parsed.analysis;
    } catch (error) {
      log(`🔬 Deep Research: Error in analyzeAndPlan:`, error);
      return null;
    }
  };

  try {
    log('state.depth', state.depth);
    log('state.completed', state.completed);
    while (state.depth < maxDepth && !state.completed) {
      const timeElapsed = Date.now() - startTime;
      if (timeElapsed >= timeLimit) {
        break;
      }

      state.depth++;

      log(`🔍 Deep Research: Iteration ${state.depth}/${maxDepth}`);

      // Take the next search query
      const currentQuery = state.nextSearchQueries.shift();
      if (!currentQuery) break;

      // Search across all configured searchers
      const allSearchResults: SearchResult[] = [];

      for (const searcher of searchers) {
        addActivity({
          type: 'search',
          status: 'pending',
          message: `Searching with ${searcher.name} for: "${currentQuery}"`,
          depth: state.depth,
        });

        try {
          const searchResults = await searcher.search(currentQuery);
          log(`🔬 Deep Research: ${searcher.name} found ${searchResults.length} results`);

          searchResults.forEach(src => {
            addSource({
              url: src.url || '',
              title: src.title || '',
              description: src.description || '',
              type: src.type || '',
              status: 'found',
            });
          });

          allSearchResults.push(...searchResults);

          addActivity({
            type: 'search',
            status: 'complete',
            message: `${searcher.name} found ${searchResults.length} results for: "${currentQuery}"`,
            depth: state.depth,
          });
        } catch (error) {
          addActivity({
            type: 'search',
            status: 'error',
            message: `${searcher.name} search failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
            depth: state.depth,
          });
          log(`🔬 Deep Research: ${searcher.name} search failed:`, error);
        }
      }

      // Extract phase: extract content from search results
      const extractedContents: ContentExtractionResult[] = [];

      // First, handle results that already have content embedded
      const resultsWithContent = allSearchResults.filter(r => r.content);
      if (resultsWithContent.length > 0) {
        extractedContents.push(
          ...resultsWithContent.map(r => ({
            text: r.content!.slice(0, 10_000),
            source: r.url || r.title || 'unknown',
          }))
        );
      }

      // Then, extract content from URLs using searchers that support extraction
      const urlsToExtract = [
        state.urlToSearch,
        ...allSearchResults.filter(r => !r.content && r.url).map(r => r.url!),
      ].filter(Boolean);

      if (urlsToExtract.length > 0) {
        // Use the first searcher that supports content extraction
        const extractorSearcher = searchers.find(s => s.extractContent);
        if (extractorSearcher?.extractContent) {
          const topUrls = urlsToExtract.slice(0, 3);
          const extracted = await extractorSearcher.extractContent(topUrls);
          extractedContents.push(...extracted);
        }
      }

      state.findings.push(...extractedContents);

      // Analyze phase: analyze the findings and determine the next steps
      addActivity({
        type: 'analyze',
        status: 'pending',
        message: `Analyzing findings`,
        depth: state.depth,
      });

      const analysis = await analyzeAndPlan(state.findings);
      if (analysis?.nextSearchTopic) state.nextSearchQueries.push(analysis.nextSearchTopic);
      state.urlToSearch = analysis?.urlToSearch || '';
      state.summaries.push(analysis?.summary || '');

      if (!analysis) {
        addActivity({
          type: 'analyze',
          status: 'error',
          message: 'Failed to analyze findings',
          depth: state.depth,
        });

        state.failedAttempts++;
        if (state.failedAttempts >= state.maxFailedAttempts) {
          break;
        }
        continue;
      }

      addActivity({
        type: 'analyze',
        status: 'complete',
        message: analysis.summary,
        depth: state.depth,
      });

      if (!analysis.shouldContinue || analysis.gaps.length === 0) {
        break;
      }
      topic = analysis.gaps.shift() || topic;
    }

    // Synthesis phase: synthesize the findings into a comprehensive report
    addActivity({
      type: 'synthesis',
      status: 'pending',
      message: `Synthesizing research findings into comprehensive report`,
      depth: state.depth,
    });

    const finalAnalysisPrompt = `Create a comprehensive long analysis of ${topic} based on these findings:
              ${state.findings.map(f => `[From ${f.source}]: ${f.text}`).join('\n')}
              ${state.summaries.map(s => `[Summary]: ${s}`).join('\n')}
              Provide all the thoughts processes including findings details,key insights, conclusions, and any remaining uncertainties. 
              Include citations to sources with links for every section. This analysis should be very comprehensive and full of details. 
              It is expected to be very long, detailed and comprehensive.`;

    addActivity({
      type: 'synthesis',
      status: 'complete',
      message: 'Research completed',
      depth: state.depth,
    });

    // Mark research as 100% complete
    state.completed = true;
    state.completedSteps = state.totalExpectedSteps;
    context.statusUpdate({ deepResearchState: state });

    log(`🔬 Deep Research: Completed research on "${topic}"`);
    await context.onFinish?.('deep_research', state);
    return {
      success: true,
      data: {
        findings: state.findings,
        finalAnalysisPrompt: finalAnalysisPrompt,
        completedSteps: state.completedSteps,
        totalSteps: state.totalExpectedSteps,
      },
    };
  } catch (error) {
    log(`🔬 Deep Research: Error in iteration ${state.depth}:`, error);
    addActivity({
      type: 'thought',
      status: 'error',
      message: `Research failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      depth: state.depth,
    });

    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      data: {
        findings: [],
        finalAnalysisPrompt: '',
        completedSteps: state.completedSteps,
        totalSteps: state.totalExpectedSteps,
      },
    };
  }
}

export const deepResearchTool: ToolDefinition = {
  name: 'deep_research',
  implementation: (context, config) => ({
    toolFn: async value => {
      const params = value as DeepResearchParams;
      await context.onStart?.('deep_research', params);
      // Use config from context if params don't specify values
      const effectiveParams = {
        topic: params.topic,
      };
      const result = await performDeepResearch(context, effectiveParams, config ?? {});
      return JSON.stringify(result);
    },
    toolSchema: {
      name: 'deep_research',
      description:
        'Conduct comprehensive deep research on a topic using iterative web search and analysis. This tool performs multi-step research gathering information from various sources and perspectives.',
      parameters: {
        type: 'object',
        properties: {
          topic: {
            type: 'string',
            description: 'The research topic or question to investigate thoroughly',
          },
        },
        required: ['topic'],
        additionalProperties: false,
      },
    },
  }),
};
