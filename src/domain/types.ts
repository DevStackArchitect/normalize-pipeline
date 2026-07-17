export type SourceName = 'hubspot' | 'razorpay' | 'gcal';
export type EntityType = 'contact' | 'payment' | 'event';

export interface NormalizedRecord {
  source: SourceName;
  externalId: string;
  entityType: EntityType;
  title: string | null;
  amountCents: number | null;
  currency: string | null;
  occurredAt: Date | null;
  sourceUpdatedAt: Date | null;
  raw: unknown;
}

export interface FetchResult {
  records: NormalizedRecord[];
  nextCursor: string | null;
}

export class StaleCursorError extends Error {
  constructor(source: string, cause?: unknown) {
    super(`Stale or rejected cursor for source: ${source}`);
    this.name = 'StaleCursorError';
    this.cause = cause;
  }
}

export interface SourceAdapter {
  name: SourceName;
  fetchIncremental(cursor: string): Promise<FetchResult>;
  fetchFull(): Promise<FetchResult>;
  mapWebhookPayload(payload: unknown): NormalizedRecord[];
}

export type RunStatus = 'ok' | 'fallback_full' | 'failed' | 'skipped_locked';

export interface RunSummary {
  source: SourceName;
  status: RunStatus;
  upserted: number;
  rejected: number;
  durationMs: number;
  error: string | null;
}
