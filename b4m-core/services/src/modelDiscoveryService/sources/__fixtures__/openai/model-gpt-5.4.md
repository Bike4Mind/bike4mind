# GPT-5.4

> For the complete documentation index, see [llms.txt](/llms.txt). Markdown versions of documentation pages are available by appending `.md` to the page URL.

> A more affordable model for coding and professional work.

Model ID: `gpt-5.4`

GPT-5.4 is our frontier model for complex professional work.
Learn more in our [GPT-5.4 model guidance](/api/docs/guides/latest-model?model=gpt-5.4). Reasoning.effort supports: none (default), low, medium, high and xhigh.

## Model details

- Default snapshot: `gpt-5.4-2026-03-05`
- Input modalities: text, image
- Output modalities: text
- 1,050,000 context window
- 128,000 max output tokens
- Aug 31, 2025 knowledge cutoff
- Reasoning token support

## Pricing


### Text tokens

| Metric | Price | Unit |
| --- | ---: | --- |
| Input | $2.5 | 1M tokens |
| Cached input | $0.25 | 1M tokens |
| Output | $15 | 1M tokens |

- For models with a 1.05M context window (GPT-5.4 and GPT-5.4 Pro), prompts with >272K input tokens are priced at 2x input and 1.5x output for the full session for standard, batch, and flex.
- Regional processing (data residency) endpoints are charged a 10% uplift for GPT-5.4 and GPT-5.4 Pro.

