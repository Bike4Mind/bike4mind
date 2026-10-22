/**
 * What this client tells the model about artifacts.
 *
 * It has to say something, because nothing else does. The desktop talks to the stateless
 * completions endpoint (`POST /api/ai/v1/completions` -> `executeCompletion`), which forwards
 * the message array to the provider and assembles no prompt of its own. The server's
 * `ARTIFACT_EMISSION_PROMPT` is injected by `ChatCompletionProcess` (the quest/WebSocket path)
 * and by the agent executor - neither of which this client goes through - so without this text
 * the model is never asked for an <artifact> block and never emits one.
 *
 * Deliberately NOT a re-export of `ARTIFACT_EMISSION_PROMPT`, despite the duplication that
 * costs. Most of that text is about a surface this app does not have: the Share/publish
 * toolbar, /p/ links, the publish transpiler, the blessed same-origin script paths. Telling a
 * desktop user's model to "use the in-app Share action" describes a button that is not there.
 * It is also ~2.8k tokens on every turn of a client whose sessions replay their whole history.
 *
 * What it MUST stay in step with is `RENDERED_TYPES` in the renderer's ArtifactCard: this
 * advertises the MIME types the desktop can show, and advertising one it cannot renders as a
 * wall of source. The list is narrower than the server's on purpose - see the comment there.
 */
export const DESKTOP_ARTIFACT_PROMPT = [
  'ARTIFACT OUTPUT:',
  'When you are asked for something substantial and self-contained - a complete HTML page, an',
  'SVG, a diagram, or a long code file - put it inside an <artifact> tag rather than in the',
  'reply body, so this app can show and store it as its own document. Shape:',
  '<artifact identifier="kebab-case-id" type="text/html" title="Short Title">THE COMPLETE FILE</artifact>',
  'Types: text/html, image/svg+xml, application/vnd.ant.mermaid, application/vnd.ant.react,',
  'application/vnd.ant.code, application/vnd.ant.python. Use the same identifier when you revise',
  'an artifact you already emitted, and emit the whole file again rather than a patch.',
  'This app draws html, svg and mermaid artifacts as they will look, and shows the rest as',
  'source. Pick the type that genuinely fits the deliverable anyway - every artifact is also',
  'saved to the Bike4Mind web app, which renders the others properly, so do not downgrade a',
  'React component to plain code just because the source is what you see here.',
  'A mermaid diagram is drawn as a picture rather than run, so a journey or a mindmap - the two',
  'kinds mermaid can only draw with embedded HTML - still comes out as source here. Every other',
  'kind, flowchart and sequence included, is shown.',
  'The body must be the entire file, written out. Never put an ellipsis, a "rest of the code"',
  'comment, or any stand-in for content you wrote earlier in its place: an artifact whose logic',
  'is replaced by a summary still renders a complete-looking page whose controls do nothing,',
  'and the user cannot see the difference. Re-emitting the same lines verbatim is correct. If',
  'the whole thing genuinely will not fit, build fewer features completely and say in the reply',
  'body which ones you left out.',
  'An artifact runs with no network: fetch, XHR, WebSocket and remote scripts, styles, fonts and',
  'images are all blocked and fail silently. Bake any data in as a literal or a data: URI. There',
  'is no storage that survives a reload, so keep state in memory. Never put a key or token in',
  'one. HTML artifacts must be a single file with CSS and JS inline - no sibling files, no',
  'iframes, and no separate second artifact.',
  'Only use an artifact for a real deliverable. An ordinary answer, a short snippet, or a reply',
  'that is mostly explanation stays in the reply body as normal prose.',
].join('\n');
