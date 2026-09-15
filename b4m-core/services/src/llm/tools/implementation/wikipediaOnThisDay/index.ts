import { ToolDefinition } from '../../base/types';

interface WikipediaOnThisDayParams {
  date?: string; // MM-DD format or YYYY-MM-DD format
  type?: 'all' | 'selected' | 'births' | 'deaths' | 'events' | 'holidays';
  limit?: number;
  year_filter?: number;
  decade_filter?: number;
}

interface WikipediaEvent {
  year: number;
  text: string;
  pages?: Array<{
    title: string;
    extract?: string;
  }>;
}

interface WikipediaResponse {
  selected?: WikipediaEvent[];
  births?: WikipediaEvent[];
  deaths?: WikipediaEvent[];
  events?: WikipediaEvent[];
  holidays?: Array<{
    text: string;
    pages?: Array<{ title: string }>;
  }>;
}

/**
 * Parse date input to get month and day
 */
const parseMonthDay = (dateStr?: string): { month: string; day: string } => {
  if (!dateStr) {
    const now = new Date();
    return {
      month: String(now.getMonth() + 1).padStart(2, '0'),
      day: String(now.getDate()).padStart(2, '0'),
    };
  }

  // Handle MM-DD format
  const mmddMatch = dateStr.match(/^(\d{1,2})-(\d{1,2})$/);
  if (mmddMatch) {
    return {
      month: mmddMatch[1].padStart(2, '0'),
      day: mmddMatch[2].padStart(2, '0'),
    };
  }

  // Handle YYYY-MM-DD format
  const fullMatch = dateStr.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (fullMatch) {
    return {
      month: fullMatch[2].padStart(2, '0'),
      day: fullMatch[3].padStart(2, '0'),
    };
  }

  throw new Error(`Invalid date format: ${dateStr}. Use MM-DD or YYYY-MM-DD format.`);
};

/**
 * Format an event for display
 */
const formatEvent = (event: WikipediaEvent): string => {
  return `${event.year}: ${event.text}`;
};

/**
 * Filter events by year or decade
 */
const filterEvents = (events: WikipediaEvent[], yearFilter?: number, decadeFilter?: number): WikipediaEvent[] => {
  if (yearFilter !== undefined) {
    return events.filter(e => e.year === yearFilter);
  }
  if (decadeFilter !== undefined) {
    const decadeStart = decadeFilter;
    const decadeEnd = decadeFilter + 9;
    return events.filter(e => e.year >= decadeStart && e.year <= decadeEnd);
  }
  return events;
};

const getWikipediaOnThisDay = async (parameters: WikipediaOnThisDayParams = {}): Promise<string> => {
  const { date, type = 'selected', limit = 10, year_filter, decade_filter } = parameters;

  try {
    const { month, day } = parseMonthDay(date);

    const url = `https://en.wikipedia.org/api/rest_v1/feed/onthisday/${type}/${month}/${day}`;

    // UA derived from APP_NAME/WEBSITE_URL, generic when unset
    const brand = process.env.APP_NAME || '';
    const websiteUrl = process.env.WEBSITE_URL || '';
    const userAgent = brand ? `${brand}/1.0${websiteUrl ? ` (${websiteUrl})` : ''}` : 'App/1.0';

    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': userAgent,
      },
    });

    if (!response.ok) {
      if (response.status === 404) {
        throw new Error(`No data available for ${month}-${day}. The date may be invalid.`);
      }
      throw new Error(`Wikipedia API error: ${response.status} ${response.statusText}`);
    }

    const data: WikipediaResponse = await response.json();

    const dateLabel = `${parseInt(month)}/${parseInt(day)}`;
    const results: string[] = [];

    if (type === 'all') {
      if (data.selected?.length) {
        results.push('**Notable Events:**');
        const events = filterEvents(data.selected, year_filter, decade_filter).slice(0, Math.ceil(limit / 3));
        events.forEach(e => results.push(`- ${formatEvent(e)}`));
      }
      if (data.births?.length) {
        results.push('\n**Notable Births:**');
        const births = filterEvents(data.births, year_filter, decade_filter).slice(0, Math.ceil(limit / 3));
        births.forEach(e => results.push(`- ${formatEvent(e)}`));
      }
      if (data.deaths?.length) {
        results.push('\n**Notable Deaths:**');
        const deaths = filterEvents(data.deaths, year_filter, decade_filter).slice(0, Math.ceil(limit / 3));
        deaths.forEach(e => results.push(`- ${formatEvent(e)}`));
      }
    } else if (type === 'holidays') {
      if (data.holidays?.length) {
        results.push(`**Holidays and Observances on ${dateLabel}:**`);
        data.holidays.slice(0, limit).forEach(h => {
          results.push(`- ${h.text}`);
        });
      } else {
        results.push(`No holidays found for ${dateLabel}.`);
      }
    } else {
      // Handle specific types: selected, births, deaths, events
      const typeLabels: Record<string, string> = {
        selected: 'Selected Historical Events',
        births: 'Notable Births',
        deaths: 'Notable Deaths',
        events: 'Historical Events',
      };

      const eventData = (data as any)[type] as WikipediaEvent[] | undefined;
      if (eventData?.length) {
        const filtered = filterEvents(eventData, year_filter, decade_filter);
        const limited = filtered.slice(0, limit);

        if (limited.length === 0) {
          const filterDesc = year_filter ? `in ${year_filter}` : decade_filter ? `in the ${decade_filter}s` : '';
          results.push(`No ${typeLabels[type].toLowerCase()} found for ${dateLabel} ${filterDesc}.`);
        } else {
          results.push(`**${typeLabels[type]} on ${dateLabel}:**`);
          limited.forEach(e => results.push(`- ${formatEvent(e)}`));

          if (filtered.length > limit) {
            results.push(`\n_...and ${filtered.length - limit} more_`);
          }
        }
      } else {
        results.push(`No ${typeLabels[type]?.toLowerCase() || 'data'} found for ${dateLabel}.`);
      }
    }

    return results.join('\n');
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(`Failed to fetch Wikipedia data: ${String(error)}`);
  }
};

export const wikipediaOnThisDayTool: ToolDefinition = {
  name: 'wikipedia_on_this_day',
  implementation: context => ({
    toolFn: async value => {
      const params = value as WikipediaOnThisDayParams;
      context.logger.log('📅 WikipediaOnThisDay: Starting execution', params);

      try {
        const result = await getWikipediaOnThisDay(params);
        context.logger.log('✅ WikipediaOnThisDay: Execution completed');
        return result;
      } catch (error) {
        context.logger.error('❌ WikipediaOnThisDay: Execution failed', error);
        throw error;
      }
    },
    toolSchema: {
      name: 'wikipedia_on_this_day',
      description:
        'Get historical events, births, deaths, and holidays that occurred on a specific date from Wikipedia. Great for "On This Day" features, historical context, and anniversary lookups.',
      parameters: {
        type: 'object',
        properties: {
          date: {
            type: 'string',
            description:
              'The date to look up. Use MM-DD format (e.g., "12-25" for Christmas) or YYYY-MM-DD format. Defaults to today if not specified.',
          },
          type: {
            type: 'string',
            description:
              'Type of historical data to retrieve: "selected" (curated notable events), "births" (famous people born), "deaths" (famous people who died), "events" (all historical events), "holidays" (holidays and observances), or "all" (mix of everything).',
            enum: ['all', 'selected', 'births', 'deaths', 'events', 'holidays'],
          },
          limit: {
            type: 'number',
            description: 'Maximum number of results to return. Defaults to 10.',
          },
          year_filter: {
            type: 'number',
            description: 'Filter to only show events from a specific year. Example: 1969 to see only events from 1969.',
          },
          decade_filter: {
            type: 'number',
            description:
              'Filter to only show events from a specific decade. Example: 1960 to see events from 1960-1969.',
          },
        },
        additionalProperties: false,
        required: [],
      },
    },
  }),
};
