type RegisteredProvider<TProviderId extends string, TModelId extends string> = {
  readonly id: TProviderId;
  readonly models: readonly TModelId[];
};

export type GenerationProviderRegistry<TProviderId extends string, TProvider> = {
  get(id: TProviderId): TProvider | undefined;
  ids(): TProviderId[];
};

export type ProviderCatalog<TProviderId extends string, TModelId extends string> = {
  /** Names errors, e.g. 'video'. */
  label: string;
  modelIds: readonly TModelId[];
  providerOf(model: TModelId): TProviderId;
};

// The catalog is the single owner of model -> provider, so a provider must serve exactly the models assigned to it.
const assertModelsMatchCatalog = <TProviderId extends string, TModelId extends string>(
  provider: RegisteredProvider<TProviderId, TModelId>,
  catalog: ProviderCatalog<TProviderId, TModelId>
): void => {
  for (const model of provider.models) {
    const owner = catalog.providerOf(model);
    if (owner !== provider.id) {
      throw new Error(`${catalog.label} provider ${provider.id} lists ${model}, which the catalog assigns to ${owner}`);
    }
  }
  const missing = catalog.modelIds.filter(
    id => catalog.providerOf(id) === provider.id && !provider.models.includes(id)
  );
  if (missing.length > 0) {
    throw new Error(`${catalog.label} provider ${provider.id} does not list catalog models: ${missing.join(', ')}`);
  }
};

export const createGenerationProviderRegistry = <
  TProviderId extends string,
  TModelId extends string,
  TProvider extends RegisteredProvider<TProviderId, TModelId>,
>(
  catalog: ProviderCatalog<TProviderId, TModelId>,
  providers: readonly TProvider[]
): GenerationProviderRegistry<TProviderId, TProvider> => {
  const byId = new Map<TProviderId, TProvider>();
  for (const provider of providers) {
    if (byId.has(provider.id)) throw new Error(`duplicate ${catalog.label} provider: ${provider.id}`);
    assertModelsMatchCatalog(provider, catalog);
    byId.set(provider.id, provider);
  }
  return { get: id => byId.get(id), ids: () => [...byId.keys()] };
};
