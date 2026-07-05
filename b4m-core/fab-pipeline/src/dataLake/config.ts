export type SearchDocument = {
  id: string;
  text: string;
  vectorChunk: {
    text: string;
    vector: number[];
  }[];
  score?: number;
};

export const searchIndexSettings: Record<string, any> = {
  mappings: {
    properties: {
      id: {
        type: 'keyword',
      },
      vectorChunk: {
        type: 'nested',
        properties: {
          text: {
            type: 'text',
          },
          vector: {
            type: 'knn_vector',
            dimension: 1536, // OpenAI embedding dimension
          },
        },
      },
      text: {
        type: 'text',
      },
    },
  },
};
