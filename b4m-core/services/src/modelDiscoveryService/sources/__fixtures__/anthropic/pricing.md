# Pricing


## Model pricing

The following table shows pricing for all Claude models:

| Model                                                                                                         | Base Input Tokens | 5m Cache Writes | 1h Cache Writes | Cache Hits & Refreshes | Output Tokens |
| ------------------------------------------------------------------------------------------------------------- | ----------------- | --------------- | --------------- | ---------------------- | ------------- |
| Claude Fable 5                                                                                                | $10 / MTok        | $12.50 / MTok   | $20 / MTok      | $1 / MTok              | $50 / MTok    |
| Claude Mythos 5 ([limited availability](https://anthropic.com/glasswing))                                     | $10 / MTok        | $12.50 / MTok   | $20 / MTok      | $1 / MTok              | $50 / MTok    |
| Claude Opus 5                                                                                                 | $5 / MTok         | $6.25 / MTok    | $10 / MTok      | $0.50 / MTok           | $25 / MTok    |
| Claude Opus 4.8                                                                                               | $5 / MTok         | $6.25 / MTok    | $10 / MTok      | $0.50 / MTok           | $25 / MTok    |
| Claude Opus 4.7                                                                                               | $5 / MTok         | $6.25 / MTok    | $10 / MTok      | $0.50 / MTok           | $25 / MTok    |
| Claude Opus 4.6                                                                                               | $5 / MTok         | $6.25 / MTok    | $10 / MTok      | $0.50 / MTok           | $25 / MTok    |
| Claude Opus 4.5                                                                                               | $5 / MTok         | $6.25 / MTok    | $10 / MTok      | $0.50 / MTok           | $25 / MTok    |
| Claude Opus 4.1 ([deprecated](/docs/en/about-claude/model-deprecations))                                      | $15 / MTok        | $18.75 / MTok   | $30 / MTok      | $1.50 / MTok           | $75 / MTok    |
| Claude Opus 4 ([retired, except on Google Cloud](/docs/en/about-claude/model-deprecations))                   | $15 / MTok        | $18.75 / MTok   | $30 / MTok      | $1.50 / MTok           | $75 / MTok    |
| Claude Sonnet 5 [through August 31, 2026](/docs/en/about-claude/pricing#claude-sonnet-5-introductory-pricing) | $2 / MTok         | $2.50 / MTok    | $4 / MTok       | $0.20 / MTok           | $10 / MTok    |
| Claude Sonnet 5 starting September 1, 2026                                                                    | $3 / MTok         | $3.75 / MTok    | $6 / MTok       | $0.30 / MTok           | $15 / MTok    |
| Claude Sonnet 4.6                                                                                             | $3 / MTok         | $3.75 / MTok    | $6 / MTok       | $0.30 / MTok           | $15 / MTok    |
| Claude Sonnet 4.5                                                                                             | $3 / MTok         | $3.75 / MTok    | $6 / MTok       | $0.30 / MTok           | $15 / MTok    |
| Claude Sonnet 4 ([retired, except on Bedrock and Google Cloud](/docs/en/about-claude/model-deprecations))     | $3 / MTok         | $3.75 / MTok    | $6 / MTok       | $0.30 / MTok           | $15 / MTok    |
| Claude Haiku 4.5                                                                                              | $1 / MTok         | $1.25 / MTok    | $2 / MTok       | $0.10 / MTok           | $5 / MTok     |
| Claude Haiku 3.5 ([retired, except on Bedrock and Google Cloud](/docs/en/about-claude/model-deprecations))    | $0.80 / MTok      | $1 / MTok       | $1.60 / MTok    | $0.08 / MTok           | $4 / MTok     |

<Note id="claude-sonnet-5-introductory-pricing">
  Introductory pricing of $2/$10 per million input/output tokens is in effect through August 31, 2026, after which the standard pricing of $3/$15 per million input/output tokens will take effect.
</Note>

<Note>
  MTok = Million tokens. The "Base Input Tokens" column shows standard input pricing, the "5m Cache Writes", "1h Cache Writes", and "Cache Hits & Refreshes" columns are specific to [prompt caching](#prompt-caching), and "Output Tokens" shows output pricing. See [prompt caching pricing](#prompt-caching) for an explanation of the cache columns and pricing multipliers.
</Note>

<Note>
  Claude 4.7 and later models and Claude Mythos Preview use a newer tokenizer that contributes to their improved performance on a wide range of tasks. This tokenizer produces approximately 30% more tokens for the same text. The exact increase depends on the content and workload shape. Claude Sonnet 4.6 and earlier models use the previous tokenizer.
</Note>

For Claude Platform on AWS pricing, see [Claude Platform on AWS pricing](#claude-platform-on-aws-pricing).

## Feature-specific pricing

### Batch processing

The Batch API allows asynchronous processing of large volumes of requests with a 50% discount on both input and output tokens.

| Model                                                                                                         | Batch input  | Batch output  |
| ------------------------------------------------------------------------------------------------------------- | ------------ | ------------- |
| Claude Fable 5                                                                                                | $5 / MTok    | $25 / MTok    |
| Claude Mythos 5 ([limited availability](https://anthropic.com/glasswing))                                     | $5 / MTok    | $25 / MTok    |
| Claude Opus 5                                                                                                 | $2.50 / MTok | $12.50 / MTok |
| Claude Opus 4.8                                                                                               | $2.50 / MTok | $12.50 / MTok |
| Claude Opus 4.7                                                                                               | $2.50 / MTok | $12.50 / MTok |
| Claude Opus 4.6                                                                                               | $2.50 / MTok | $12.50 / MTok |
| Claude Opus 4.5                                                                                               | $2.50 / MTok | $12.50 / MTok |
| Claude Opus 4.1 ([deprecated](/docs/en/about-claude/model-deprecations))                                      | $7.50 / MTok | $37.50 / MTok |
| Claude Opus 4 ([retired, except on Google Cloud](/docs/en/about-claude/model-deprecations))                   | $7.50 / MTok | $37.50 / MTok |
| Claude Sonnet 5 [through August 31, 2026](/docs/en/about-claude/pricing#claude-sonnet-5-introductory-pricing) | $1 / MTok    | $5 / MTok     |
| Claude Sonnet 5 starting September 1, 2026                                                                    | $1.50 / MTok | $7.50 / MTok  |
| Claude Sonnet 4.6                                                                                             | $1.50 / MTok | $7.50 / MTok  |
| Claude Sonnet 4.5                                                                                             | $1.50 / MTok | $7.50 / MTok  |
| Claude Sonnet 4 ([retired, except on Bedrock and Google Cloud](/docs/en/about-claude/model-deprecations))     | $1.50 / MTok | $7.50 / MTok  |
| Claude Haiku 4.5                                                                                              | $0.50 / MTok | $2.50 / MTok  |
| Claude Haiku 3.5 ([retired, except on Bedrock and Google Cloud](/docs/en/about-claude/model-deprecations))    | $0.40 / MTok | $2 / MTok     |

For more information about batch processing, see [Batch processing](/docs/en/build-with-claude/batch-processing).
