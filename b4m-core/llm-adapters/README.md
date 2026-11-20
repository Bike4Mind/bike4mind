# LLM adapters

## Web-chat reasoning preferences

Resolve a shared user preference for every attempt, using the model that will serve that attempt:

```ts
import { chatReasoningEffortFor } from '@bike4mind/llm-adapters';

const explicitEffort = userPreference && userPreference !== 'auto' ? userPreference : undefined;
const reasoningEffort = chatReasoningEffortFor(modelInfo, explicitEffort);
```

Pass `undefined` for Auto. The resolver withholds effort on legacy Claude models and clamps supported models to their accepted chat levels. Resolve again after choosing a fallback model. The browser-safe `/model-sizing` entry exports `chatReasoningEffortsFor` for building a matching selector; the shared `OPENAI_XHIGH_REASONING_EFFORT_MODELS` set in `@bike4mind/common` identifies the OpenAI models offered Extra High.
