import mongoose from 'mongoose';

type ValidatorLike = { type?: string };
type SchemaTypeLike = mongoose.SchemaType & {
  validators?: ValidatorLike[];
  schema?: mongoose.Schema;
  caster?: { validators?: ValidatorLike[] };
};

// `required` is excluded on purpose: it behaves differently on updates, so it is not the class of
// bypass this audit tracks.
const kindsOf = (type: SchemaTypeLike): string[] => {
  const kinds = [...(type.validators ?? []), ...(type.caster?.validators ?? [])]
    .map(validator => validator.type)
    .filter((kind): kind is string => !!kind && kind !== 'required');
  return [...new Set(kinds)].sort();
};

export function collectConstrainedPaths(schema: mongoose.Schema, prefix = ''): Map<string, string[]> {
  const out = new Map<string, string[]>();
  schema.eachPath((relative, schemaType) => {
    const type = schemaType as SchemaTypeLike;
    const full = `${prefix}${relative}`;
    const kinds = kindsOf(type);
    if (kinds.length > 0) out.set(full, kinds);
    if (type.schema) {
      for (const [path, nested] of collectConstrainedPaths(type.schema, `${full}.`)) out.set(path, nested);
    }
  });
  return out;
}

/** Constrained paths per model name, with each discriminator's own paths merged into its base model. */
export function collectModelConstraints(connection: typeof mongoose = mongoose): Map<string, Map<string, string[]>> {
  const out = new Map<string, Map<string, string[]>>();
  for (const name of connection.modelNames()) {
    const model = connection.model(name);
    const paths = collectConstrainedPaths(model.schema);
    for (const discriminator of Object.values(model.discriminators ?? {})) {
      for (const [path, kinds] of collectConstrainedPaths(discriminator.schema)) paths.set(path, kinds);
    }
    out.set(name, paths);
  }
  return out;
}
