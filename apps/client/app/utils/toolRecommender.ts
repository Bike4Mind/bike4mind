import { B4MLLMTools } from '@bike4mind/common';

/** Simple display name lookup - avoids importing toolMapping which has MUI icon deps */
const TOOL_DISPLAY_NAMES: Partial<Record<B4MLLMTools, string>> = {
  web_search: 'Web Search',
  web_fetch: 'Web Fetch',
  weather_info: 'Weather',
  math_evaluate: 'Math',
  wolfram_alpha: 'Wolfram Alpha',
  current_datetime: 'Date/Time',
  image_generation: 'Image Gen',
  mermaid_chart: 'Diagram',
  recharts: 'Chart',
  dice_roll: 'Dice',
  moon_phase: 'Moon Phase',
  sunrise_sunset: 'Sunrise/Sunset',
  iss_tracker: 'ISS Tracker',
  planet_visibility: 'Planets',
  wikipedia_on_this_day: 'On This Day',
  search_knowledge_base: 'Knowledge Base',
  retrieve_knowledge_content: 'Knowledge Retrieve',
  optihashi_formulate: 'Problem Formulation',
  optihashi_edit_problem: 'Problem Edit',
  optihashi_schedule: 'Optimization Solver',
  navigate_view: 'Navigate View',
};

export interface ToolRecommendation {
  tool: B4MLLMTools;
  reason: string;
}

interface ToolPattern {
  tool: B4MLLMTools;
  patterns: RegExp[];
}

const TOOL_PATTERNS: ToolPattern[] = [
  {
    tool: 'web_search',
    patterns: [
      /\b(search\s+for|look\s+up|find\s+(out|me|information))\b/i,
      /\b(latest|recent|current)\s+(news|updates|info|information|events|developments)\b/i,
      /\bwho\s+(is|was|are|were)\b/i,
      /\bwhat\s+(happened|is\s+happening)\b/i,
      /\b(google|search\s+the\s+web|search\s+online)\b/i,
    ],
  },
  {
    tool: 'web_fetch',
    patterns: [/https?:\/\/\S+/i, /www\.\S+/i],
  },
  {
    tool: 'weather_info',
    patterns: [
      /\bweather\b/i,
      /\bforecast\b/i,
      /\btemperature\b/i,
      /\b(is\s+it|will\s+it)\s+(rain|snow|storm|hot|cold|warm|sunny|cloudy)\b/i,
      /\bhow\s+(hot|cold|warm)\b/i,
    ],
  },
  {
    tool: 'wolfram_alpha',
    patterns: [
      /\b(integral|derivative|differentiate|integrate)\b/i,
      /\b(physics|chemistry|biology)\b/i,
      /\b(convert|conversion)\s+.{0,20}(to|from|into)\b/i,
      /\b(population|capital|distance|mass|speed\s+of\s+light)\b/i,
      /\b(solve|factor|expand)\s+.{0,10}(equation|polynomial|expression)\b/i,
      /\b(limit|series|summation|sum\s+of)\b/i,
      /\bwolfram\b/i,
      /\b(chemical|element|atomic|molecular)\b/i,
      /\b(calories|nutrition|nutritional)\b/i,
    ],
  },
  {
    tool: 'math_evaluate',
    patterns: [
      /\b(calculate|compute|evaluate)\b/i,
      /\d+\s*[+\-*/^%]\s*\d+/,
      /\b(factorial)\b/i,
      /\bmath\b/i,
      /\b(square\s+root|sqrt|log|sin|cos|tan)\b/i,
    ],
  },
  {
    tool: 'current_datetime',
    patterns: [
      /\bwhat\s+(time|day|date)\b/i,
      /\btoday'?s?\s+date\b/i,
      /\bcurrent\s+(time|date|day)\b/i,
      /\bwhat\s+is\s+today\b/i,
    ],
  },
  {
    tool: 'image_generation',
    patterns: [
      // Allow the subject to sit between the verb and the image noun ("generate a cat image",
      // "create a beautiful sunset picture") - the lazy {0,4} also covers the zero-word case
      // ("generate an image"). The earlier pattern only matched when the noun immediately
      // followed an article, so natural "[verb] a <subject> image" phrasing was missed.
      /\b(generate|create|make|draw|paint|render)\s+(?:\w+\s+){0,4}?(image|picture|photo|illustration|artwork|painting|portrait|drawing)\b/i,
      /\b(image|picture|photo|illustration|artwork|portrait|drawing)\s+of\b/i,
    ],
  },
  {
    tool: 'mermaid_chart',
    patterns: [
      /\b(flowchart|flow\s+chart|sequence\s+diagram|class\s+diagram|state\s+diagram|er\s+diagram|erd|gantt\s+chart)\b/i,
      /\b(mermaid|diagram)\b/i,
    ],
  },
  {
    tool: 'recharts',
    patterns: [
      /\b(bar|line|pie|area|scatter|radar)\s+(chart|graph)\b/i,
      /\b(chart|graph|plot)\s+(this|the|my|that|some)\s+data\b/i,
      /\bvisuali[sz]e\s+(the\s+|this\s+|my\s+)?data\b/i,
      /\bplot\s+(a\s+|the\s+)?graph\b/i,
    ],
  },
  {
    tool: 'dice_roll',
    patterns: [/\broll\s+(a\s+)?d\d+\b/i, /\broll\s+(the\s+)?dice\b/i, /\b\d+d\d+\b/i],
  },
  {
    tool: 'moon_phase',
    patterns: [/\bmoon\s+phase\b/i, /\b(full|new|crescent|quarter)\s+moon\b/i, /\blunar\b/i],
  },
  {
    tool: 'sunrise_sunset',
    patterns: [/\bsunrise\b/i, /\bsunset\b/i, /\bdawn\b/i, /\bdusk\b/i, /\b(golden\s+hour|blue\s+hour)\b/i],
  },
  {
    tool: 'iss_tracker',
    patterns: [/\biss\b/i, /\b(international\s+)?space\s+station\b/i],
  },
  {
    tool: 'planet_visibility',
    patterns: [
      /\bplanets?\s+(\w+\s+)*(visible|tonight|see)\b/i,
      /\bstargazing\b/i,
      /\bvisible\s+planets?\b/i,
      /\b(can\s+i\s+see|where\s+is)\s+(mars|venus|jupiter|saturn|mercury)\b/i,
    ],
  },
  {
    tool: 'wikipedia_on_this_day',
    patterns: [/\bon\s+this\s+day\b/i, /\btoday\s+in\s+history\b/i, /\bhistorical\s+events?\s+(on|for)\s+today\b/i],
  },
  {
    tool: 'search_knowledge_base',
    patterns: [
      /\b(in\s+my|from\s+my|search\s+my)\s+(files?|documents?|knowledge\s+base|uploads?)\b/i,
      /\b(check|look\s+in|find\s+in)\s+(my\s+)?(files?|documents?|knowledge\s+base)\b/i,
    ],
  },
  {
    tool: 'optihashi_formulate',
    patterns: [
      /\b(formulate|model|structure)\s+.{0,30}(problem|scenario|situation)\b/i,
      /\b(factory|workshop|plant|warehouse|fleet|hospital|clinic|bakery|restaurant)\b/i,
      /\b(machines?|workers?|vehicles?|trucks?|shifts?|nurses?|orders?)\s+.{0,20}(schedul|optimi|assign|rout)\b/i,
      /\b(job\s*shop|flow\s*shop|open\s*shop)\b/i,
      /\b(supply\s+chain|logistics|manufacturing|production\s+line)\b/i,
    ],
  },
  {
    tool: 'optihashi_schedule',
    patterns: [
      /\b(optimi[sz]e|schedule|minimize|maximize)\b/i,
      /\b(makespan|throughput|utilization|bottleneck)\b/i,
      /\b(solver|heuristic|metaheuristic|simulated\s+annealing|tabu|genetic\s+algorithm)\b/i,
      /\b(constraint|objective\s+function|decision\s+variable)\b/i,
      /\b(NP[- ]hard|combinatorial|integer\s+programming)\b/i,
    ],
  },
];

/** Tools that should never be auto-recommended (destructive/expensive/admin) */
const NEVER_AUTO_RECOMMEND: B4MLLMTools[] = [
  'deep_research',
  'prompt_enhancement',
  'edit_file',
  'edit_image',
  'blog_publish',
  'blog_edit',
  'blog_draft',
  'navigate_view',
];

/**
 * Analyzes a prompt and recommends tools based on pattern matching.
 * Pure function - no side effects, no API calls.
 */
export function recommendTools(prompt: string): ToolRecommendation[] {
  const recommendations: ToolRecommendation[] = [];

  for (const { tool, patterns } of TOOL_PATTERNS) {
    if (NEVER_AUTO_RECOMMEND.includes(tool)) continue;

    for (const pattern of patterns) {
      if (pattern.test(prompt)) {
        recommendations.push({
          tool,
          reason: TOOL_DISPLAY_NAMES[tool] ?? tool,
        });
        break; // Only recommend each tool once
      }
    }
  }

  return recommendations;
}

/**
 * Merges auto-recommended tools with manually pinned tools.
 * Returns a deduplicated union.
 */
export function mergeTools(recommended: ToolRecommendation[], manualTools: B4MLLMTools[]): B4MLLMTools[] {
  const toolSet = new Set<B4MLLMTools>(manualTools);
  for (const rec of recommended) {
    toolSet.add(rec.tool);
  }
  return Array.from(toolSet);
}
