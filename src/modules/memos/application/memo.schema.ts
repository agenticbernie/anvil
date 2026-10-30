import { z } from 'zod';

export const CreditMemoSchema = z.object({
  borrower_overview: z.string().max(8_000),
  request_summary: z.string().max(4_000),
  financial_highlights: z.array(z.object({
    field_name: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
    summary: z.string().max(2_000),
    source_fact_ids: z.array(z.string().uuid()).max(50),
  }).strict()).max(50),
  risks: z.array(z.string().max(2_000)).max(50),
  mitigants: z.array(z.string().max(2_000)).max(50),
  recommendation: z.enum(['proceed_to_review', 'request_more_information', 'decline', 'undetermined']),
}).strict();

export type CreditMemoContent = z.infer<typeof CreditMemoSchema>;
