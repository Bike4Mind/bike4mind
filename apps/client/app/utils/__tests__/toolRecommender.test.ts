import { describe, it, expect } from 'vitest';
import { recommendTools, mergeTools } from '../toolRecommender';
import { B4MLLMTools } from '@bike4mind/common';

describe('recommendTools', () => {
  describe('web_search', () => {
    it('triggers on "search for"', () => {
      const result = recommendTools('search for the latest AI news');
      expect(result.map(r => r.tool)).toContain('web_search');
    });

    it('triggers on "look up"', () => {
      const result = recommendTools('look up who invented the telephone');
      expect(result.map(r => r.tool)).toContain('web_search');
    });

    it('triggers on "who is"', () => {
      const result = recommendTools('who is the president of France?');
      expect(result.map(r => r.tool)).toContain('web_search');
    });

    it('triggers on "latest news"', () => {
      const result = recommendTools('what are the latest news about SpaceX?');
      expect(result.map(r => r.tool)).toContain('web_search');
    });

    it('triggers on "what happened"', () => {
      const result = recommendTools('what happened in the stock market today?');
      expect(result.map(r => r.tool)).toContain('web_search');
    });
  });

  describe('web_fetch', () => {
    it('triggers on https URL', () => {
      const result = recommendTools('summarize this page: https://example.com/article');
      expect(result.map(r => r.tool)).toContain('web_fetch');
    });

    it('triggers on http URL', () => {
      const result = recommendTools('read http://docs.example.com/guide');
      expect(result.map(r => r.tool)).toContain('web_fetch');
    });

    it('triggers on www URL', () => {
      const result = recommendTools('check out www.example.com');
      expect(result.map(r => r.tool)).toContain('web_fetch');
    });
  });

  describe('weather_info', () => {
    it('triggers on "weather"', () => {
      const result = recommendTools("what's the weather in NYC?");
      expect(result.map(r => r.tool)).toContain('weather_info');
    });

    it('triggers on "forecast"', () => {
      const result = recommendTools('give me the forecast for tomorrow');
      expect(result.map(r => r.tool)).toContain('weather_info');
    });

    it('triggers on "temperature"', () => {
      const result = recommendTools('what is the temperature outside?');
      expect(result.map(r => r.tool)).toContain('weather_info');
    });

    it('triggers on "will it rain"', () => {
      const result = recommendTools('will it rain tomorrow?');
      expect(result.map(r => r.tool)).toContain('weather_info');
    });
  });

  describe('math_evaluate', () => {
    it('triggers on "calculate"', () => {
      const result = recommendTools('calculate the area of a circle with radius 5');
      expect(result.map(r => r.tool)).toContain('math_evaluate');
    });

    it('triggers on arithmetic expression', () => {
      const result = recommendTools('what is 42 * 17?');
      expect(result.map(r => r.tool)).toContain('math_evaluate');
    });

    it('triggers on "solve" for basic math', () => {
      // "solve...equation" triggers wolfram_alpha (better suited for algebra);
      // use simpler prompts for math_evaluate
      const result = recommendTools('solve 5 + 3 * 2');
      expect(result.map(r => r.tool)).toContain('math_evaluate');
    });

    it('triggers on "square root"', () => {
      const result = recommendTools('what is the square root of 144?');
      expect(result.map(r => r.tool)).toContain('math_evaluate');
    });

    it('triggers on complex arithmetic', () => {
      const result = recommendTools('what is 15 + 27?');
      expect(result.map(r => r.tool)).toContain('math_evaluate');
    });
  });

  describe('current_datetime', () => {
    it('triggers on "what time"', () => {
      const result = recommendTools('what time is it?');
      expect(result.map(r => r.tool)).toContain('current_datetime');
    });

    it('triggers on "what day"', () => {
      const result = recommendTools('what day is it?');
      expect(result.map(r => r.tool)).toContain('current_datetime');
    });

    it('triggers on "today\'s date"', () => {
      const result = recommendTools("what is today's date?");
      expect(result.map(r => r.tool)).toContain('current_datetime');
    });
  });

  describe('image_generation', () => {
    it('triggers on "generate an image"', () => {
      const result = recommendTools('generate an image of a sunset over mountains');
      expect(result.map(r => r.tool)).toContain('image_generation');
    });

    it('triggers on "create a picture"', () => {
      const result = recommendTools('create a picture of a cat');
      expect(result.map(r => r.tool)).toContain('image_generation');
    });

    it('triggers on "draw me an illustration"', () => {
      const result = recommendTools('draw me an illustration of a robot');
      expect(result.map(r => r.tool)).toContain('image_generation');
    });
  });

  describe('mermaid_chart', () => {
    it('triggers on "flowchart"', () => {
      const result = recommendTools('create a flowchart of the login process');
      expect(result.map(r => r.tool)).toContain('mermaid_chart');
    });

    it('triggers on "sequence diagram"', () => {
      const result = recommendTools('show me a sequence diagram for the API');
      expect(result.map(r => r.tool)).toContain('mermaid_chart');
    });

    it('triggers on "ERD"', () => {
      const result = recommendTools('make an ERD for the database');
      expect(result.map(r => r.tool)).toContain('mermaid_chart');
    });
  });

  describe('recharts', () => {
    it('triggers on "bar chart"', () => {
      const result = recommendTools('create a bar chart of sales data');
      expect(result.map(r => r.tool)).toContain('recharts');
    });

    it('triggers on "pie chart"', () => {
      const result = recommendTools('show a pie chart of market share');
      expect(result.map(r => r.tool)).toContain('recharts');
    });

    it('triggers on "visualize the data"', () => {
      const result = recommendTools('visualize the data in a graph');
      expect(result.map(r => r.tool)).toContain('recharts');
    });
  });

  describe('dice_roll', () => {
    it('triggers on "roll d20"', () => {
      const result = recommendTools('roll a d20 for initiative');
      expect(result.map(r => r.tool)).toContain('dice_roll');
    });

    it('triggers on "2d6"', () => {
      const result = recommendTools('I need 2d6 for damage');
      expect(result.map(r => r.tool)).toContain('dice_roll');
    });

    it('triggers on "roll dice"', () => {
      const result = recommendTools('roll the dice');
      expect(result.map(r => r.tool)).toContain('dice_roll');
    });
  });

  describe('moon_phase', () => {
    it('triggers on "moon phase"', () => {
      const result = recommendTools('what is the current moon phase?');
      expect(result.map(r => r.tool)).toContain('moon_phase');
    });

    it('triggers on "full moon"', () => {
      const result = recommendTools('when is the next full moon?');
      expect(result.map(r => r.tool)).toContain('moon_phase');
    });
  });

  describe('sunrise_sunset', () => {
    it('triggers on "sunrise"', () => {
      const result = recommendTools('when is sunrise tomorrow?');
      expect(result.map(r => r.tool)).toContain('sunrise_sunset');
    });

    it('triggers on "sunset"', () => {
      const result = recommendTools('what time is sunset today?');
      expect(result.map(r => r.tool)).toContain('sunrise_sunset');
    });

    it('triggers on "golden hour"', () => {
      const result = recommendTools('when is golden hour for photography?');
      expect(result.map(r => r.tool)).toContain('sunrise_sunset');
    });
  });

  describe('iss_tracker', () => {
    it('triggers on "ISS"', () => {
      const result = recommendTools('where is the ISS right now?');
      expect(result.map(r => r.tool)).toContain('iss_tracker');
    });

    it('triggers on "space station"', () => {
      const result = recommendTools('where is the international space station?');
      expect(result.map(r => r.tool)).toContain('iss_tracker');
    });
  });

  describe('planet_visibility', () => {
    it('triggers on "planets visible"', () => {
      const result = recommendTools('what planets are visible tonight?');
      expect(result.map(r => r.tool)).toContain('planet_visibility');
    });

    it('triggers on "stargazing"', () => {
      const result = recommendTools('good night for stargazing?');
      expect(result.map(r => r.tool)).toContain('planet_visibility');
    });
  });

  describe('wikipedia_on_this_day', () => {
    it('triggers on "on this day"', () => {
      const result = recommendTools('what happened on this day in history?');
      expect(result.map(r => r.tool)).toContain('wikipedia_on_this_day');
    });

    it('triggers on "today in history"', () => {
      const result = recommendTools('show me today in history');
      expect(result.map(r => r.tool)).toContain('wikipedia_on_this_day');
    });
  });

  describe('search_knowledge_base', () => {
    it('triggers on "in my files"', () => {
      const result = recommendTools('search in my files for the quarterly report');
      expect(result.map(r => r.tool)).toContain('search_knowledge_base');
    });

    it('triggers on "search my documents"', () => {
      const result = recommendTools('search my documents for revenue data');
      expect(result.map(r => r.tool)).toContain('search_knowledge_base');
    });
  });

  describe('never auto-recommend', () => {
    it('does not recommend deep_research', () => {
      const result = recommendTools('do deep research on climate modeling');
      expect(result.map(r => r.tool)).not.toContain('deep_research');
    });

    it('does not recommend prompt_enhancement', () => {
      const result = recommendTools('enhance this prompt');
      expect(result.map(r => r.tool)).not.toContain('prompt_enhancement');
    });

    it('does not recommend edit_file', () => {
      const result = recommendTools('edit this file for me');
      expect(result.map(r => r.tool)).not.toContain('edit_file');
    });

    it('does not recommend edit_image', () => {
      const result = recommendTools('edit this image');
      expect(result.map(r => r.tool)).not.toContain('edit_image');
    });

    it('does not recommend blog tools', () => {
      const result = recommendTools('publish this blog post');
      expect(result.map(r => r.tool)).not.toContain('blog_publish');
      expect(result.map(r => r.tool)).not.toContain('blog_edit');
      expect(result.map(r => r.tool)).not.toContain('blog_draft');
    });
  });

  describe('no false positives', () => {
    it('returns empty for generic questions', () => {
      const result = recommendTools('tell me a joke');
      expect(result).toHaveLength(0);
    });

    it('returns empty for simple conversation', () => {
      const result = recommendTools('hello, how are you?');
      expect(result).toHaveLength(0);
    });

    it('returns empty for code questions', () => {
      const result = recommendTools('explain how React hooks work');
      expect(result).toHaveLength(0);
    });
  });

  describe('multiple tools', () => {
    it('recommends both web_search and math for a combined prompt', () => {
      const result = recommendTools('search for the population of Japan and calculate the density per sq km');
      const tools = result.map(r => r.tool);
      expect(tools).toContain('web_search');
      expect(tools).toContain('math_evaluate');
    });

    it('recommends web_fetch and web_search when URL + search keywords present', () => {
      const result = recommendTools('look up this page https://example.com and search for related articles');
      const tools = result.map(r => r.tool);
      expect(tools).toContain('web_fetch');
      expect(tools).toContain('web_search');
    });
  });

  describe('each tool recommended only once', () => {
    it('does not duplicate tools with multiple pattern matches', () => {
      const result = recommendTools('search for and look up the latest news about weather forecast');
      const webSearchCount = result.filter(r => r.tool === 'web_search').length;
      expect(webSearchCount).toBe(1);
    });
  });
});

describe('mergeTools', () => {
  it('returns manual tools when no recommendations', () => {
    const result = mergeTools([], ['web_search', 'math_evaluate']);
    expect(result).toEqual(['web_search', 'math_evaluate']);
  });

  it('returns recommended tools when no manual tools', () => {
    const recommendations = [
      { tool: 'weather_info' as B4MLLMTools, reason: 'Weather Info' },
      { tool: 'web_search' as B4MLLMTools, reason: 'Web Search' },
    ];
    const result = mergeTools(recommendations, []);
    expect(result).toContain('weather_info');
    expect(result).toContain('web_search');
    expect(result).toHaveLength(2);
  });

  it('deduplicates overlapping tools', () => {
    const recommendations = [
      { tool: 'web_search' as B4MLLMTools, reason: 'Web Search' },
      { tool: 'weather_info' as B4MLLMTools, reason: 'Weather Info' },
    ];
    const manualTools: B4MLLMTools[] = ['web_search', 'math_evaluate'];
    const result = mergeTools(recommendations, manualTools);
    expect(result).toHaveLength(3);
    expect(result).toContain('web_search');
    expect(result).toContain('math_evaluate');
    expect(result).toContain('weather_info');
  });

  it('returns empty when both are empty', () => {
    const result = mergeTools([], []);
    expect(result).toEqual([]);
  });

  it('preserves manual tools order first', () => {
    const recommendations = [{ tool: 'weather_info' as B4MLLMTools, reason: 'Weather Info' }];
    const manualTools: B4MLLMTools[] = ['math_evaluate', 'dice_roll'];
    const result = mergeTools(recommendations, manualTools);
    // Manual tools should come first since they're the base of the Set
    expect(result[0]).toBe('math_evaluate');
    expect(result[1]).toBe('dice_roll');
    expect(result[2]).toBe('weather_info');
  });
});
