# Bike4Mind Utils Documentation

## Syncing Model Descriptions

This script synchronizes local model descriptions with the latest metadata from OpenAI and other sources.

### 📁 File Location

packages/utils/src/llm/syncModelDescriptions.ts

### Env Variables

Create a .env file at the root of your project and add:

API_KEY=###########
MODEL_ID=#########

Model_id is from ChatModels enum

### Running the script

pnpm run sync-descriptions

### 📝 Notes

Requires an OpenAI API key with access to the latest models
Works best when run after model version changes or cost updates from OpenAI
Don’t forget to commit any updated files the script touches
