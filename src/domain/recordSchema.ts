import { z } from 'zod';
import { NormalizedRecord } from './types';

const recordSchema = z.object({
  source: z.enum(['hubspot', 'razorpay', 'gcal']),
  externalId: z.string().min(1),
  entityType: z.enum(['contact', 'payment', 'event']),
  title: z.string().nullable(),
  amountCents: z.number().int().nonnegative().nullable(),
  currency: z.string().nullable(),
  occurredAt: z.date().nullable(),
  sourceUpdatedAt: z.date().nullable(),
  raw: z.unknown(),
});

export type ValidationResult =
  | { ok: true; record: NormalizedRecord }
  | { ok: false; reason: string };

export function validateRecord(input: unknown): ValidationResult {
  const parsed = recordSchema.safeParse(input);
  if (!parsed.success) {
    const reason = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    return { ok: false, reason };
  }
  return { ok: true, record: { ...parsed.data, raw: parsed.data.raw ?? null } };
}
