# GPT-6 Sol

> For the complete documentation index, see [llms.txt](/llms.txt). Markdown versions of documentation pages are available by appending `.md` to the page URL.

> Built to power complex coding and agentic workflows.

Model ID: `gpt-6-sol`

GPT-6 Sol is built for complex coding and agentic workflows.

`reasoning.effort` supports `none`, `low`, `medium` (default), `high`, `xhigh`, and `max`.
Use the Responses API for built-in tools and function calling. Chat Completions supports function calling only with `reasoning_effort` set to `none`.

EU data residency is available only with Standard processing.
See [data residency eligibility](/api/docs/guides/your-data#which-models-and-features-are-eligible-for-data-residency).

## Model details

- Default snapshot: `gpt-6-sol`
- Input modalities: text, image
- Output modalities: text
- 1,050,000 context window
- Maximum input tokens: 922,000
- 128,000 max output tokens
- Apr 20, 2026 knowledge cutoff
- Reasoning token support

## Pricing


### Text tokens

| Metric | Price | Unit |
| --- | ---: | --- |
| Input | $2 | 1M tokens |
| Cached input | $0.2 | 1M tokens |
| Cache writes | $2.5 | 1M tokens |
| Output | $10 | 1M tokens |

- Cached input tokens are priced at 10% of the uncached input token rate.
- Cache writes are billed at 1.25x the uncached input token rate.
- Prompts with more than 272K input tokens are priced at 2x input and cache rates and 1.5x output for the full request.
- Regional processing adds a 10% premium where available. EU data residency is available only with Standard processing.
- Batch and Flex are priced at 50% of Standard rates. Fast mode is priced at 2x the applicable rates.
