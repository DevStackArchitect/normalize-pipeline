import { calendar_v3, google } from 'googleapis';
import {
  FetchResult,
  NormalizedRecord,
  SourceAdapter,
  StaleCursorError,
} from '../domain/types';
import { getStatusCode, withRetry } from '../lib/retry';

const PAGE_SIZE = 250;

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

export function createGcalAdapter(serviceAccountJson: string, calendarId: string): SourceAdapter {
  let cached: calendar_v3.Calendar | null = null;

  function client(): calendar_v3.Calendar {
    if (cached !== null) return cached;
    const key = JSON.parse(serviceAccountJson) as Partial<ServiceAccountKey>;
    if (typeof key.client_email !== 'string' || typeof key.private_key !== 'string') {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON must contain client_email and private_key');
    }
    const auth = new google.auth.JWT({
      email: key.client_email,
      key: key.private_key,
      scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
    });
    cached = google.calendar({ version: 'v3', auth });
    return cached;
  }

  async function listPages(
    params: calendar_v3.Params$Resource$Events$List
  ): Promise<FetchResult> {
    const cal = client();
    const records: NormalizedRecord[] = [];
    let nextSyncToken: string | null = null;
    let pageToken: string | undefined;
    do {
      const requestParams = { ...params, ...(pageToken !== undefined ? { pageToken } : {}) };
      const res = await withRetry(() => cal.events.list(requestParams));
      for (const event of res.data.items ?? []) {
        records.push(mapEvent(event));
      }
      pageToken = res.data.nextPageToken ?? undefined;
      nextSyncToken = res.data.nextSyncToken ?? nextSyncToken;
    } while (pageToken !== undefined);
    return { records, nextCursor: nextSyncToken };
  }

  async function fetchFull(): Promise<FetchResult> {
    return listPages({ calendarId, singleEvents: true, maxResults: PAGE_SIZE });
  }

  async function fetchIncremental(cursor: string): Promise<FetchResult> {
    try {
      return await listPages({
        calendarId,
        singleEvents: true,
        maxResults: PAGE_SIZE,
        syncToken: cursor,
      });
    } catch (err) {
      if (getStatusCode(err) === 410) throw new StaleCursorError('gcal', err);
      throw err;
    }
  }

  function mapWebhookPayload(payload: unknown): NormalizedRecord[] {
    if (payload === null || typeof payload !== 'object') return [];
    const container = payload as { items?: unknown };
    const items = Array.isArray(payload)
      ? payload
      : Array.isArray(container.items)
        ? container.items
        : [payload];
    return items
      .filter((item): item is calendar_v3.Schema$Event => item !== null && typeof item === 'object')
      .map(mapEvent);
  }

  return { name: 'gcal', fetchFull, fetchIncremental, mapWebhookPayload };
}

export function mapEvent(event: calendar_v3.Schema$Event): NormalizedRecord {
  return {
    source: 'gcal',
    externalId: typeof event.id === 'string' ? event.id : '',
    entityType: 'event',
    title: typeof event.summary === 'string' && event.summary.length > 0 ? event.summary : null,
    amountCents: null,
    currency: null,
    occurredAt: parseDate(event.start?.dateTime ?? event.start?.date),
    sourceUpdatedAt: parseDate(event.updated),
    raw: event,
  };
}

function parseDate(value: string | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms);
}
