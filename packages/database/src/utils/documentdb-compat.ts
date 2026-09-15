// Facade: DocumentDB compat moved to @bike4mind/db-core
export {
  USE_DOCUMENTDB,
  executeFacetCompatible,
  createCompatibleLookup,
  convertPipelineForDocumentDB,
  convertLookupForDocumentDB,
  addLowercaseField,
  migrateLowercaseFields,
  getCompatibleSort,
} from '@bike4mind/db-core';
