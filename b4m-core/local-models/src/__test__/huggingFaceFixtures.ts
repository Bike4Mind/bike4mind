// Trimmed from real Hugging Face Hub API responses (`_id`, chat templates, xet hashes and most tags dropped).

export const qwenSha = '9217f5db79a29953eb74d5343926648285ec7e67';
export const vlSha = '924acccaaefe1cd2569c717379d20d68be50df06';
export const gatedSha = 'd1be121d36172a4b0b964657e2ee859d61138593';

/** `GET /api/models?search=qwen2.5 0.5b&filter=gguf&...`; the second entry came from a request without `expand`. */
export const searchPage = [
  {
    id: 'Qwen/Qwen2.5-0.5B-Instruct-GGUF',
    author: 'Qwen',
    gated: false,
    lastModified: '2024-09-20T06:20:24.000Z',
    likes: 157,
    private: false,
    downloads: 325006,
    tags: [
      'gguf',
      'chat',
      'text-generation',
      'en',
      'arxiv:2407.10671',
      'base_model:Qwen/Qwen2.5-0.5B-Instruct',
      'base_model:quantized:Qwen/Qwen2.5-0.5B-Instruct',
      'license:apache-2.0',
      'endpoints_compatible',
      'region:us',
      'conversational',
    ],
    pipeline_tag: 'text-generation',
  },
  {
    id: 'bartowski/Qwen2.5-0.5B-Instruct-GGUF',
    likes: 19,
    private: false,
    downloads: 108989,
    tags: [
      'gguf',
      'chat',
      'text-generation',
      'en',
      'base_model:Qwen/Qwen2.5-0.5B-Instruct',
      'base_model:quantized:Qwen/Qwen2.5-0.5B-Instruct',
      'license:apache-2.0',
      'endpoints_compatible',
      'region:us',
      'conversational',
    ],
    pipeline_tag: 'text-generation',
    createdAt: '2024-09-17T19:30:40.000Z',
    modelId: 'bartowski/Qwen2.5-0.5B-Instruct-GGUF',
  },
];

export const searchCursor =
  'eyIkb3IiOlt7ImRvd25sb2FkcyI6NjA3MywiX2lkIjp7IiRndCI6IjY3MmMzZTcwN2YxYTI3Njk4ZGFjYTg4NSJ9fV19';

export const qwenInfo = {
  id: 'Qwen/Qwen2.5-0.5B-Instruct-GGUF',
  sha: qwenSha,
  gated: false,
  cardData: {
    license: 'apache-2.0',
    license_link: 'https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/blob/main/LICENSE',
    language: ['en'],
    pipeline_tag: 'text-generation',
    base_model: 'Qwen/Qwen2.5-0.5B-Instruct',
    tags: ['chat'],
  },
  gguf: {
    total: 630167424,
    architecture: 'qwen2',
    context_length: 8192,
    bos_token: '<|endoftext|>',
    eos_token: '<|im_end|>',
    totalFileSize: 1266425696,
  },
  lastModified: '2024-09-20T06:20:24.000Z',
  author: 'Qwen',
  private: false,
  disabled: false,
  tags: searchPage[0]?.tags,
  pipeline_tag: 'text-generation',
  downloads: 325006,
  likes: 157,
};

const lfsFile = (path: string, size: number, oid: string) => ({
  type: 'file',
  oid: 'x',
  size,
  lfs: { oid, size },
  path,
});

export const qwenTree = [
  { type: 'file', oid: 'e79ce6a89353fed9e05c6bd0e566fbd82c8d6d5f', size: 1561, path: '.gitattributes' },
  { type: 'file', oid: '6634c8cc3133b3848ec74b9f275acaaa1ea618ab', size: 11343, path: 'LICENSE' },
  { type: 'file', oid: '6c5b52e47b307cc84626fe22508f95e1cf617488', size: 4856, path: 'README.md' },
  lfsFile(
    'qwen2.5-0.5b-instruct-fp16.gguf',
    1266425696,
    '8e0ae26000627ed62de0e78e41860af70094558b9d2913385c842a6aa06cf3fc'
  ),
  lfsFile(
    'qwen2.5-0.5b-instruct-q2_k.gguf',
    415182688,
    '9ee36184e616dfc76df4f5dd66f908dbde6979524ae36e6cefb67f532f798cb8'
  ),
  lfsFile(
    'qwen2.5-0.5b-instruct-q4_k_m.gguf',
    491400032,
    '74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db'
  ),
  lfsFile(
    'qwen2.5-0.5b-instruct-q8_0.gguf',
    675710816,
    'ca59ca7f13d0e15a8cfa77bd17e65d24f6844b554a7b6c12e07a5f89ff76844e'
  ),
];

export const vlInfo = {
  id: 'unsloth/Qwen2.5-VL-72B-Instruct-GGUF',
  author: 'unsloth',
  downloads: 3303,
  likes: 11,
  lastModified: '2025-05-18T06:48:38.000Z',
  gated: false,
  private: false,
  pipeline_tag: 'image-text-to-text',
  tags: [
    'transformers',
    'gguf',
    'qwen2_5_vl',
    'image-text-to-text',
    'multimodal',
    'unsloth',
    'base_model:Qwen/Qwen2.5-VL-72B-Instruct',
    'base_model:quantized:Qwen/Qwen2.5-VL-72B-Instruct',
    'license:other',
    'endpoints_compatible',
    'region:us',
    'imatrix',
    'conversational',
  ],
  sha: vlSha,
  cardData: {
    license: 'other',
    license_name: 'qwen',
    license_link: 'https://huggingface.co/Qwen/Qwen2.5-VL-72B-Instruct/blob/main/LICENSE',
    language: ['en'],
    pipeline_tag: 'image-text-to-text',
    tags: ['multimodal', 'unsloth'],
    library_name: 'transformers',
    base_model: ['Qwen/Qwen2.5-VL-72B-Instruct'],
  },
  gguf: {
    total: 72706203648,
    architecture: 'qwen2vl',
    context_length: 128000,
    quantize_imatrix_file: 'Qwen2.5-VL-72B-Instruct-GGUF/imatrix_unsloth.dat',
    eos_token: '<|im_end|>',
    totalFileSize: 41315623328,
  },
};

/** Two pages, split where the real listing would be cut by a smaller page size. */
export const vlTreePages = [
  [
    { type: 'directory', oid: '27c093293125f838c5633c294fcdda80aeae027e', size: 0, path: 'BF16' },
    { type: 'directory', oid: 'd42fd2d1cef15bb3d4a05d0596c515439f1c9d90', size: 0, path: 'Q5_K_M' },
    lfsFile(
      'BF16/Qwen2.5-VL-72B-Instruct-BF16-00002-of-00003.gguf',
      49938328960,
      '2938fa51b1550bb4b12259472789522297aa7bec2b2d3042d68f169c5cea86e4'
    ),
    lfsFile(
      'BF16/Qwen2.5-VL-72B-Instruct-BF16-00001-of-00003.gguf',
      49893814848,
      '9ff82e582308b2953ab29992816c3fa63102be1d0e5497625f73ee858179c80b'
    ),
    lfsFile(
      'BF16/Qwen2.5-VL-72B-Instruct-BF16-00003-of-00003.gguf',
      45590528544,
      'dfd3cb35b521c24ae6551996f2b9988e72c271ad8268cea62f350a0433f3e83d'
    ),
    lfsFile(
      'Q5_K_M/Qwen2.5-VL-72B-Instruct-Q5_K_M-00001-of-00002.gguf',
      49941713184,
      'b0c7e36ed18debf33b0e8cf021c6a19d21b03a090ad87884e780408438de4973'
    ),
    lfsFile(
      'Q5_K_M/Qwen2.5-VL-72B-Instruct-Q5_K_M-00002-of-00002.gguf',
      4505751872,
      'e16ab2ebd5956857b158c652d67de0711d84071510b9e9267e58509f586c23e3'
    ),
    lfsFile(
      'Qwen2.5-VL-72B-Instruct-Q2_K.gguf',
      29811761568,
      '693c519ea8e4a52c460666c297deeaa69068dd59f56488fe8ef4f1a26c538858'
    ),
  ],
  [
    lfsFile(
      'Qwen2.5-VL-72B-Instruct-Q2_K_L.gguf',
      30103724448,
      '289d494b54e4d0fb407c88b0eb0a26823ff36188d7e475deebcf3a7293f1663e'
    ),
    lfsFile(
      'Qwen2.5-VL-72B-Instruct-Q4_K_M.gguf',
      47415714208,
      'ec42ea2c536aec5510af2ddd3125e81d494833de070255e933867f65dae8ec21'
    ),
    lfsFile(
      'Qwen2.5-VL-72B-Instruct-UD-Q4_K_XL.gguf',
      47321080224,
      '21de7ef2b0d4cecf2c37d485c2eca375331ee273974237f7f7f67e92f165dd07'
    ),
    { type: 'file', oid: 'ecf525d413a04b17dada7b09496f71d286e18e97', size: 21103, path: 'README.md' },
    lfsFile('mmproj-BF16.gguf', 1410223552, '4239068914bc91fcb4e004271deeaaa230f855a1b704629dae4b9e1a3e432bcd'),
    lfsFile('mmproj-F16.gguf', 1410223552, 'add333fada915332370b62d3fb1b6fc21e3615002f667e96f241d85213e1956d'),
    lfsFile('mmproj-F32.gguf', 2815315392, 'b8981253075f46ec5f3de366a07df2bb20a628c7e636a99713543e3a1b1ce8a3'),
  ],
];

export const gatedInfo = {
  id: 'google/gemma-3-1b-it-qat-q4_0-gguf',
  sha: gatedSha,
  gated: 'manual',
  cardData: {
    license: 'gemma',
    pipeline_tag: 'text-generation',
    base_model: 'google/gemma-3-1b-it',
    tags: ['gemma', 'gemma3'],
  },
  gguf: { total: 999885952, architecture: 'gemma3', context_length: 32768, totalFileSize: 1003541152 },
  lastModified: '2025-04-11T00:54:27.000Z',
  author: 'google',
  private: false,
  disabled: false,
  tags: [
    'gguf',
    'gemma',
    'gemma3',
    'text-generation',
    'base_model:google/gemma-3-1b-it',
    'base_model:quantized:google/gemma-3-1b-it',
    'license:gemma',
    'endpoints_compatible',
    'region:us',
    'conversational',
  ],
  pipeline_tag: 'text-generation',
  downloads: 1039,
  likes: 174,
};

/** Without access the Hub lists gated files but masks their LFS sha256. */
export const gatedTree = [
  { type: 'file', oid: 'e61bdc6b29c6b0402b74683f2eb2db01ea063ab3', size: 1954, path: '.gitattributes' },
  { type: 'file', oid: '0d4eb046d040f712915e977b8c1ffcf938aeaeb1', size: 23213, path: 'README.md' },
  lfsFile('gemma-3-1b-it-q4_0.gguf', 1003541152, '*'.repeat(64)),
];

export const gatedMessage =
  'Access to model google/gemma-3-1b-it-qat-q4_0-gguf is restricted. You must have access to it and be authenticated to access it. Please log in.';
