import {
  FetchResult,
  NormalizedRecord,
  SourceAdapter,
  StaleCursorError,
} from '../domain/types';
import { HttpError, withRetry } from '../lib/retry';

const BASE_URL = 'https://api.razorpay.com/v1';
const PAGE_SIZE = 100;

export interface RazorpayPayment {
  id: string;
  entity: string;
  amount: number;
  currency: string;
  description?: string | null;
  created_at: number;
}

interface RazorpayCollection {
  entity: string;
  count: number;
  items: RazorpayPayment[];
}

export function createRazorpayAdapter(keyId: string, keySecret: string): SourceAdapter {
  const authHeader = `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`;

  async function listPayments(params: Record<string, string>): Promise<RazorpayCollection> {
    const query = new URLSearchParams(params);
    return withRetry(async () => {
      const res = await fetch(`${BASE_URL}/payments?${query.toString()}`, {
        headers: { Authorization: authHeader },
      });
      if (!res.ok) {
        const body = await res.text();
        throw new HttpError(`razorpay GET /payments returned ${res.status}`, res.status, body);
      }
      return (await res.json()) as RazorpayCollection;
    });
  }

  async function collect(from: number | null): Promise<FetchResult> {
    const records: NormalizedRecord[] = [];
    let maxCreated = from ?? 0;
    let skip = 0;
    let page: RazorpayCollection;
    do {
      const params: Record<string, string> = {
        count: String(PAGE_SIZE),
        skip: String(skip),
      };
      if (from !== null) params['from'] = String(from);
      page = await listPayments(params);
      for (const payment of page.items) {
        records.push(mapPayment(payment));
        if (typeof payment.created_at === 'number' && payment.created_at > maxCreated) {
          maxCreated = payment.created_at;
        }
      }
      skip += page.items.length;
    } while (page.items.length === PAGE_SIZE);
    return { records, nextCursor: maxCreated > 0 ? String(maxCreated) : null };
  }

  async function fetchFull(): Promise<FetchResult> {
    return collect(null);
  }

  async function fetchIncremental(cursor: string): Promise<FetchResult> {
    const from = Number(cursor);
    if (!Number.isInteger(from) || from <= 0) {
      throw new StaleCursorError('razorpay');
    }
    return collect(from);
  }

  function mapWebhookPayload(payload: unknown): NormalizedRecord[] {
    if (payload === null || typeof payload !== 'object') return [];
    const envelope = payload as { entity?: unknown; payload?: unknown };
    let candidate: unknown = payload;
    if (
      envelope.entity === 'event' &&
      envelope.payload !== null &&
      typeof envelope.payload === 'object'
    ) {
      const wrapper = (envelope.payload as { payment?: unknown }).payment;
      if (wrapper !== null && typeof wrapper === 'object') {
        candidate = (wrapper as { entity?: unknown }).entity;
      }
    }
    if (candidate === null || typeof candidate !== 'object') return [];
    if ((candidate as { entity?: unknown }).entity !== 'payment') return [];
    return [mapPayment(candidate as RazorpayPayment)];
  }

  return { name: 'razorpay', fetchFull, fetchIncremental, mapWebhookPayload };
}

export function mapPayment(payment: RazorpayPayment): NormalizedRecord {
  const created =
    typeof payment.created_at === 'number' ? new Date(payment.created_at * 1000) : null;
  const id = typeof payment.id === 'string' ? payment.id : '';
  const description =
    typeof payment.description === 'string' && payment.description.length > 0
      ? payment.description
      : null;
  return {
    source: 'razorpay',
    externalId: id,
    entityType: 'payment',
    title: description ?? (id !== '' ? `Payment ${id}` : null),
    amountCents: typeof payment.amount === 'number' ? payment.amount : null,
    currency: typeof payment.currency === 'string' ? payment.currency.toUpperCase() : null,
    occurredAt: created,
    sourceUpdatedAt: created,
    raw: payment,
  };
}
