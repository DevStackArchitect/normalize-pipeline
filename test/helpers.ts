import { Pool } from 'pg';

export interface CapturedQuery {
  text: string;
  params: unknown[];
}

export function makeFakePool(): { pool: Pool; captured: CapturedQuery[] } {
  const captured: CapturedQuery[] = [];
  const query = async (text: string, params?: unknown[]): Promise<{ rows: never[]; rowCount: number }> => {
    captured.push({ text, params: params ?? [] });
    return { rows: [], rowCount: 0 };
  };
  const client = { query, release: (): void => undefined };
  const pool = { query, connect: async () => client } as unknown as Pool;
  return { pool, captured };
}
