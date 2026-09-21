import { describe, it, expect, vi } from 'vitest';
import { ToolBuilder, type ToolBuilderConfig, type BuildToolsArgs } from './ToolBuilder';
import { b4mTools } from './index';
import { AUTO_ADDED_TOOL_NAMES, resolveEnabledTools } from '../ChatCompletionProcess';
import { createTokenizer } from '@bike4mind/utils';

/**
 * Tool schemas are serialized into every completion request whether or not the model calls one, so
 * a verbose description is a tax on each turn that offers it. Two guards live here, and they pull
 * in opposite directions on purpose:
 *
 *   1. CEILINGS on token cost - trimming stays green, re-inflating fails.
 *   2. CONTENT assertions on the rules a description must still carry - because every ceiling here
 *      gets GREENER as text is deleted, so cost alone would reward trimming away a real constraint.
 *      These strings are what the model reads to decide whether and how to call the tool.
 *
 * Counted exactly as ChatCompletionProcess does it (see its toolSchemaTokens block): the
 * `{name, description, input_schema}` proxy of the Anthropic wire form, same tokenizer. It is an
 * estimate, not the per-backend bytes each adapter's formatTools finally emits.
 */

/**
 * Worst case for the set the server can attach without the caller naming a tool - NOT a per-turn
 * floor. Every one of these is conditional: `navigate_view` needs a navigable view context
 * (shouldAutoEnableNavigateView is false on the main chat page), the blog trio needs an admin with
 * a blog integration and blog intent in the turn, and `skill` needs invocable skills. A default
 * non-admin turn on the main chat page pays none of it. `skipAutoOffers` suppresses all of them.
 */
const PER_TOOL_CEILINGS: Record<string, number> = {
  recharts: 800,
  excel_generation: 950,
  math_evaluate: 340,
  chess_engine: 440,
};

/** Any tool without its own line above must stay under this. Catches re-inflating an unlisted tool. */
const UNLISTED_TOOL_CEILING = 600;
const AUTO_ADDED_CEILING = 1250;
const AUTO_ADDED_PLUS_KNOWLEDGE_CEILING = 2100;
/** Headroom for a few new tools, so legitimate growth does not force a ceiling bump. */
const WHOLE_REGISTRY_CEILING = 9600;

/**
 * Derived, never hand-copied: the knowledge offer drags its companions along via addPairedTool
 * inside resolveEnabledTools, and a fifth companion added there must show up in this budget
 * rather than being silently missed by a stale literal.
 */
const KNOWLEDGE_AUTO_OFFER = resolveEnabledTools({ requestTools: [], hasAttachedKnowledge: true });

function buildSchemas(enabledTools: string[]) {
  const builder = new ToolBuilder({
    user: { id: 'budget-probe' },
    db: {},
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), updateMetadata: vi.fn() },
    storage: {},
    imageGenerateStorage: {},
    toolCreditsMap: new Map(),
    subagentTelemetryData: [],
    sendStatusUpdate: vi.fn(),
  } as unknown as ToolBuilderConfig);

  return (
    builder.buildTools({
      enabledTools,
      quest: {} as never,
      saveQuest: vi.fn() as never,
      llm: {} as never,
      config: {},
    } as unknown as BuildToolsArgs) ?? []
  );
}

const tokenizer = createTokenizer({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
});

function descriptionOf(tool: string): string {
  const built = buildSchemas([tool]);
  expect(built).toHaveLength(1);
  return String(built[0].toolSchema.description);
}

async function countSchemaTokens(enabledTools: string[]): Promise<number> {
  const built = buildSchemas(enabledTools);
  // Without this a broken builder returns nothing, every ceiling below passes on 0 tokens, and the
  // budget silently stops being enforced. The count is the assertion that makes the rest mean something.
  expect(built.map(tool => tool.toolSchema.name).sort()).toEqual([...enabledTools].sort());

  const serialized = built
    .map(tool =>
      JSON.stringify({
        name: tool.toolSchema.name,
        description: tool.toolSchema.description,
        input_schema: tool.toolSchema.parameters,
      })
    )
    .join('');
  return tokenizer.countTokens(serialized);
}

describe('tool schema token budget', () => {
  it.each(Object.entries(PER_TOOL_CEILINGS))('keeps %s under its schema budget', async (tool, ceiling) => {
    expect(await countSchemaTokens([tool])).toBeLessThanOrEqual(ceiling);
  });

  it('keeps every unlisted tool under the generic per-tool cap', async () => {
    const unlisted = Object.keys(b4mTools).filter(name => !(name in PER_TOOL_CEILINGS));
    const overBudget: string[] = [];
    for (const tool of unlisted) {
      if ((await countSchemaTokens([tool])) > UNLISTED_TOOL_CEILING) overBudget.push(tool);
    }
    expect(overBudget).toEqual([]);
  });

  it('keeps the auto-added tools the server can attach uninvited under budget', async () => {
    expect(await countSchemaTokens([...AUTO_ADDED_TOOL_NAMES])).toBeLessThanOrEqual(AUTO_ADDED_CEILING);
  });

  it('keeps the auto-added set plus the knowledge auto-offer under budget', async () => {
    expect(await countSchemaTokens([...AUTO_ADDED_TOOL_NAMES, ...KNOWLEDGE_AUTO_OFFER])).toBeLessThanOrEqual(
      AUTO_ADDED_PLUS_KNOWLEDGE_CEILING
    );
  });

  it('keeps the whole registry under budget for tool-heavy sessions', async () => {
    expect(await countSchemaTokens(Object.keys(b4mTools))).toBeLessThanOrEqual(WHOLE_REGISTRY_CEILING);
  });

  it('pins the auto-added list the budget above is measured against', () => {
    expect([...AUTO_ADDED_TOOL_NAMES].sort()).toEqual(
      ['blog_draft', 'blog_edit', 'blog_publish', 'navigate_view', 'skill'].sort()
    );
  });

  it('derives the knowledge companions rather than hard-coding them', () => {
    expect(KNOWLEDGE_AUTO_OFFER).toContain('search_knowledge_base');
    expect(KNOWLEDGE_AUTO_OFFER.length).toBeGreaterThanOrEqual(4);
  });

  /**
   * A ceiling can only ever be satisfied by deleting text, so these pin the constraints that must
   * survive the next trim. Each one exists because the tool has no runtime validation behind it:
   * nothing checks that chart data is numeric, and nothing re-renders a chart the model drew itself.
   */
  describe('descriptions keep the rules a ceiling would happily delete', () => {
    it('recharts still forbids images and hand-rolled components, and demands real numeric data', () => {
      const desc = descriptionOf('recharts');
      expect(desc).toMatch(/never emit an image/i);
      expect(desc).toMatch(/react component/i);
      expect(desc).toMatch(/numeric/i);
      expect(desc).toMatch(/artifact/i);
    });

    it('recharts still states the axis contract, including the Pie/Funnel case', () => {
      const desc = descriptionOf('recharts');
      expect(desc).toMatch(/yAxis/);
      expect(desc).toMatch(/xAxis/);
      expect(desc).toMatch(/PieChart\/FunnelChart|PieChart and FunnelChart/);
    });

    it('math_evaluate still steers inline LaTeX to a backslash command', () => {
      // apps/client/app/utils/remarkPlugins.ts only promotes a `$...$` span to math when it holds a
      // `\command`, and every render surface sets singleDollarTextMath:false - so a bare `$x^2=9$`
      // reaches the user as literal dollar text. Losing this line is a visible rendering bug.
      const desc = descriptionOf('math_evaluate');
      expect(desc).toMatch(/backslash command/i);
      expect(desc).toContain('\\int');
    });

    it('chess_engine top-level description stands alone for tool-listing surfaces', () => {
      // ReActAgent and the CLI tool registry render the top-level description WITHOUT parameters,
      // so a bare "see the action parameter" cross-reference would be dangling there.
      const desc = descriptionOf('chess_engine');
      expect(desc).toMatch(/play_turn/);
      expect(desc).toMatch(/FEN/);
      expect(desc).toMatch(/SAN/);
    });
  });
});
