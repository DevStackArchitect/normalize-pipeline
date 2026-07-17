import {
  FetchResult,
  NormalizedRecord,
  SourceAdapter,
  StaleCursorError,
} from '../domain/types';
import { HttpError, withRetry } from '../lib/retry';

const BASE_URL = 'https://api.hubapi.com';
const PROPERTIES = ['firstname', 'lastname', 'email', 'createdate', 'lastmodifieddate'];
const PAGE_SIZE = 100;

export interface HubspotContact {
  id: string;
  properties: Record<string, string | null>;
}

interface HubspotPage {
  results: HubspotContact[];
  paging?: { next?: { after?: string } };
}

export function createHubspotAdapter(accessToken: string): SourceAdapter {
  async function request<T>(path: string, init: { method: string; body?: string }): Promise<T> {
    return withRetry(async () => {
      const res = await fetch(`${BASE_URL}${path}`, {
        method: init.method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        ...(init.body !== undefined ? { body: init.body } : {}),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new HttpError(`hubspot ${init.method} ${path} returned ${res.status}`, res.status, body);
      }
      return (await res.json()) as T;
    });
  }

  async function fetchFull(): Promise<FetchResult> {
    const records: NormalizedRecord[] = [];
    let maxModifiedMs = 0;
    let after: string | undefined;
    do {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        properties: PROPERTIES.join(','),
      });
      if (after !== undefined) params.set('after', after);
      const page = await request<HubspotPage>(
        `/crm/v3/objects/contacts?${params.toString()}`,
        { method: 'GET' }
      );
      for (const contact of page.results) {
        const mapped = mapContact(contact);
        records.push(mapped);
        maxModifiedMs = maxTime(maxModifiedMs, mapped.sourceUpdatedAt);
      }
      after = page.paging?.next?.after;
    } while (after !== undefined);
    return { records, nextCursor: maxModifiedMs > 0 ? String(maxModifiedMs) : null };
  }

  async function fetchIncremental(cursor: string): Promise<FetchResult> {
    const records: NormalizedRecord[] = [];
    let maxModifiedMs = Number.isInteger(Number(cursor)) ? Number(cursor) : 0;
    let after: string | undefined;
    do {
      const body: Record<string, unknown> = {
        filterGroups: [
          {
            filters: [
              { propertyName: 'hs_lastmodifieddate', operator: 'GTE', value: cursor },
            ],
          },
        ],
        sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'ASCENDING' }],
        properties: PROPERTIES,
        limit: PAGE_SIZE,
      };
      if (after !== undefined) body['after'] = after;

      let page: HubspotPage;
      try {
        page = await request<HubspotPage>('/crm/v3/objects/contacts/search', {
          method: 'POST',
          body: JSON.stringify(body),
        });
      } catch (err) {
        if (isStaleCursorResponse(err)) throw new StaleCursorError('hubspot', err);
        throw err;
      }

      for (const contact of page.results) {
        const mapped = mapContact(contact);
        records.push(mapped);
        maxModifiedMs = maxTime(maxModifiedMs, mapped.sourceUpdatedAt);
      }
      after = page.paging?.next?.after;
    } while (after !== undefined);
    return { records, nextCursor: maxModifiedMs > 0 ? String(maxModifiedMs) : null };
  }

  function mapWebhookPayload(payload: unknown): NormalizedRecord[] {
    if (payload === null || typeof payload !== 'object') return [];
    const items = Array.isArray(payload) ? payload : [payload];
    return items.map((item) => mapContact(toContactShape(item)));
  }

  return { name: 'hubspot', fetchFull, fetchIncremental, mapWebhookPayload };
}

function isStaleCursorResponse(err: unknown): boolean {
  if (!(err instanceof HttpError)) return false;
  if (err.status === 410) return true;
  return err.status === 400 && /invalid|timestamp|filter/i.test(err.body);
}

export function mapContact(contact: HubspotContact): NormalizedRecord {
  const props = contact.properties;
  const name = [props['firstname'], props['lastname']]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .map((part) => part.trim())
    .join(' ');
  return {
    source: 'hubspot',
    externalId: contact.id,
    entityType: 'contact',
    title: name.length > 0 ? name : props['email'] ?? null,
    amountCents: null,
    currency: null,
    occurredAt: parseDate(props['createdate']),
    sourceUpdatedAt: parseDate(props['lastmodifieddate']),
    raw: contact,
  };
}

function toContactShape(value: unknown): HubspotContact {
  if (value === null || typeof value !== 'object') return { id: '', properties: {} };
  const obj = value as { id?: unknown; properties?: unknown };
  const id =
    typeof obj.id === 'string' ? obj.id : typeof obj.id === 'number' ? String(obj.id) : '';
  const properties =
    obj.properties !== null && typeof obj.properties === 'object' && !Array.isArray(obj.properties)
      ? Object.fromEntries(
          Object.entries(obj.properties as Record<string, unknown>).map(([key, value]) => [
            key,
            typeof value === 'string' ? value : null,
          ])
        )
      : {};
  return { id, properties };
}

function parseDate(value: string | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const ms = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  if (Number.isNaN(ms)) return null;
  return new Date(ms);
}

function maxTime(currentMs: number, candidate: Date | null): number {
  if (candidate === null) return currentMs;
  const ms = candidate.getTime();
  return ms > currentMs ? ms : currentMs;
}
