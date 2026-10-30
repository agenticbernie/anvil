import { z } from 'zod';

const JsonScalarSchema: z.ZodType<unknown> = z.union([
  z.string().max(20_000),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

function jsonValueSchema(depth: number): z.ZodType<unknown> {
  if (depth >= 8) return JsonScalarSchema;
  const child = jsonValueSchema(depth + 1);
  return z.union([
    JsonScalarSchema,
    z.array(child).max(500),
    z.record(z.string().max(128), child).refine((record) => Object.keys(record).length <= 500),
  ]);
}

const JsonValueSchema = jsonValueSchema(0);

export const ExtractedFactCandidateSchema = z.object({
  field_name: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
  raw_value: JsonValueSchema,
  normalized_value: JsonValueSchema,
  source_page: z.number().int().min(1).max(1_000_000),
  confidence: z.number().finite().min(0).max(1),
}).strict();

export const ExtractionResultSchema = z.object({
  facts: z.array(ExtractedFactCandidateSchema).max(250),
}).strict();

export type ExtractedFactCandidate = z.infer<typeof ExtractedFactCandidateSchema>;
export type ValidatedExtractionOutput = z.infer<typeof ExtractionResultSchema>;
