import { createRequire } from 'node:module';
import { Ajv2020, type ErrorObject } from 'ajv/dist/2020.js';
import type { FormatsPlugin } from 'ajv-formats';
import { Type, type Static, type TSchema } from '@sinclair/typebox';

export function Envelope<T extends TSchema>(schemaId: string, version: number, dataSchema: T) {
  return Type.Object({
    schema_id: Type.Literal(schemaId),
    schema_version: Type.Literal(version),
    data: dataSchema,
  }, { additionalProperties: false });
}

function formatErrors(errors: ErrorObject[] | null | undefined): string {
  return [...(errors ?? [])]
    .sort((left, right) => `${left.instancePath}:${left.keyword}`.localeCompare(`${right.instancePath}:${right.keyword}`))
    .map((error) => `${error.instancePath || '/'} ${error.keyword}: ${error.message ?? 'invalid'}`)
    .join('; ');
}

export class ContractValidator {
  readonly #ajv: Ajv2020;

  constructor() {
    this.#ajv = new Ajv2020({ allErrors: true, strict: false });
    const addFormats = createRequire(import.meta.url)('ajv-formats') as FormatsPlugin;
    addFormats(this.#ajv);
  }

  check<T extends TSchema>(schema: T, value: unknown): Static<T> {
    const validate = this.#ajv.compile(schema);
    if (!validate(value)) throw new Error(`SCHEMA_INVALID: ${formatErrors(validate.errors)}`);
    return value as Static<T>;
  }
}

export const GenericEnvelopeSchema = Type.Object({
  schema_id: Type.String({ minLength: 1 }),
  schema_version: Type.Integer({ minimum: 1 }),
  data: Type.Unknown(),
}, { additionalProperties: false });

export type GenericEnvelope = Static<typeof GenericEnvelopeSchema>;
