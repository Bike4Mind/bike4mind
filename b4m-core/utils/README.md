# Bike4Mind Utils Documentation

## Syncing Model Descriptions

This script synchronizes local model descriptions with the latest metadata from OpenAI and other sources.

### 📁 File Location

b4m-core/llm-adapters/src/syncModelDescriptions.ts

### Env Variables

Create a .env file at the root of your project and add:

API_KEY=###########
MODEL_ID=#########
MODEL_BACKEND=#########

MODEL_ID is the model that rewrites the descriptions. MODEL_BACKEND is the `ModelBackend` value that serves it (e.g. `openai`, `ollama`, `bedrock`); API_KEY is filed under that backend (still required, but unused, for the AWS-IAM backends `bedrock` and `aws`). It is stated rather than inferred because the same id text is served by more than one backend.

### Running the script

pnpm run sync-descriptions

### 📝 Notes

Requires an OpenAI API key with access to the latest models
Works best when run after model version changes or cost updates from OpenAI
Don’t forget to commit any updated files the script touches
