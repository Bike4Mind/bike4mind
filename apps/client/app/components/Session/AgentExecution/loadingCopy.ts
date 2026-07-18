/**
 * Loading copy for the agent iteration stream. Three goals:
 * - Contextual: when a tool name is available, describe what the agent is
 *   doing instead of a generic "Running tool". toolName is already on the
 *   action step metadata, so the contextual copy is free.
 * - Alive: the dispatch gap and the model's thinking phase can each take
 *   several seconds, and a static label that long reads as stalled. Rotating
 *   phrases signal progress at zero cost.
 * - Polished, not silly: shown to enterprise users evaluating reasoning
 *   quality. Aim for a considered voice, not memes.
 *
 * Each list is intentionally short (3-4 entries) so a rarely-seen phrase does
 * not land at a key demo moment and feel random.
 */

// Tool-specific labels for the inline "Running tool - waiting for result"
// placeholder. Fallback covers any tool not listed (including ones added
// after this map ships) without breaking the surface.
//
// Keys mirror tool names registered in `b4m-core/services/src/llm/tools/`:
// when adding a new tool there, add a matching entry here so the loading
// state reads as deliberate rather than the auto-humanized `Running x_y_z`
// fallback. Could eventually derive this from registry metadata.
const TOOL_RUNNING_COPY: Record<string, string> = {
  web_search: 'Scouring the web…',
  web_fetch: 'Reading the page…',
  image_generation: 'Painting your image…',
  edit_image: 'Editing the image…',
  delegate_to_agent: 'Conferring with a specialist agent…',
  send_slack_message: 'Drafting a Slack message…',
  knowledge_base: 'Searching knowledge base…',
  deep_research: 'Deep-diving into sources…',
  wolfram_alpha: 'Consulting Wolfram Alpha…',
  weather: 'Checking the weather…',
  math_evaluate: 'Crunching the math…',
  mermaid: 'Sketching the diagram…',
  excel_generator: 'Building the spreadsheet…',
  current_date_time: 'Checking the clock…',
  dice_roll: 'Rolling the dice…',
  on_this_day: 'Flipping through the history books…',
  moon_phase: 'Reading the moon…',
  sunrise_sunset: 'Tracking the sun…',
  iss_tracker: 'Pinging the ISS…',
  planet_visibility: 'Mapping the night sky…',
  chess_engine: 'Calculating the next move…',
  recharts: 'Drawing the chart…',
  thinking: 'Working through it…',
  // OptiHashi autonomous-optimizer loop: name the current rung of the walk so a
  // multi-minute decompose -> formulate -> solve -> advance run reads as purposeful
  // progress rather than a generic spinner.
  optihashi_decompose: 'Breaking the scenario into sub-problems…',
  optihashi_formulate: 'Formulating the optimization model…',
  optihashi_edit_problem: 'Refining the model…',
  optihashi_schedule: 'Racing solvers…',
  optihashi_solve: 'Racing solvers…',
};

export function copyForRunningTool(toolName: string | undefined): string {
  if (!toolName) return 'Working on it…';
  return TOOL_RUNNING_COPY[toolName] ?? `Running ${humanize(toolName)}…`;
}

function humanize(snake: string): string {
  return snake.replace(/_/g, ' ');
}

// Rotated while the model is "thinking": between iterations, or between an
// observation landing and the next action being chosen. Not running a tool
// here; the LLM is deliberating.
export const THINKING_COPY = [
  'Reasoning through this…',
  'Weighing options…',
  'Plotting the next move…',
  'Considering approaches…',
] as const;

// Rotated during the dispatch gap before the server fires execution_started.
// Cold-start on a low-traffic preview env can be 5-10s; the rotation makes
// that wait feel intentional rather than dropped.
export const STARTING_COPY = ['Waking the agent…', 'Spinning up reasoning…', 'Loading expertise…'] as const;
