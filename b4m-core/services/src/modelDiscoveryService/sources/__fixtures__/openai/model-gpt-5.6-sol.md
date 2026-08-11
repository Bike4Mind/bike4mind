# GPT-5.6 Sol

> For the complete documentation index, see [llms.txt](/llms.txt). Markdown versions of documentation pages are available by appending `.md` to the page URL.

> Frontier model for complex professional work

Model ID: `gpt-5.6-sol`

GPT-5.6 Sol is the frontier model in the GPT-5.6 family. It roughly
corresponds to the unsuffixed model tier used in earlier GPT-5 families.
The `gpt-5.6` alias routes requests to GPT-5.6 Sol.

## Model details

- Default snapshot: `gpt-5.6-sol`
- Input modalities: text, image
- Output modalities: text
- 1,050,000 context window
- Maximum input tokens: 922,000
- 128,000 max output tokens
- Feb 16, 2026 knowledge cutoff
- Reasoning token support

## Pricing


### Text tokens

| Metric | Price | Unit |
| --- | ---: | --- |
| Input | $5 | 1M tokens |
| Cached input | $0.5 | 1M tokens |
| Output | $30 | 1M tokens |

- Prompts with >272K input tokens are priced at 2x input and 1.5x output for the full request.
- Cache writes are billed at 1.25x the uncached input token rate.

