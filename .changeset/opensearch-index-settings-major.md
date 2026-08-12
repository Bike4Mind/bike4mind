---
"@bike4mind/fab-pipeline": major
---

remove the unused, hardcoded-dimension `searchIndexSettings` export - it modeled a single-dimension, nested-per-file document that the new per-embeddingModel, flat-per-chunk index shape (`buildSearchIndexSettings`/`buildSearchIndexSettingsForModel`) replaces outright, so a compatible re-export was not possible
