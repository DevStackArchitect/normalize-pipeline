CREATE TABLE IF NOT EXISTS records (
  id                 BIGSERIAL PRIMARY KEY,
  source             TEXT NOT NULL,
  external_id        TEXT NOT NULL,
  entity_type        TEXT NOT NULL,
  title              TEXT,
  amount_cents       BIGINT,
  currency           TEXT,
  occurred_at        TIMESTAMPTZ,
  source_updated_at  TIMESTAMPTZ,
  raw                JSONB NOT NULL,
  synced_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source, external_id)
);

CREATE INDEX IF NOT EXISTS idx_records_source ON records (source);
CREATE INDEX IF NOT EXISTS idx_records_entity ON records (entity_type);

CREATE TABLE IF NOT EXISTS sync_state (
  source     TEXT PRIMARY KEY,
  cursor     TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id          BIGSERIAL PRIMARY KEY,
  source      TEXT NOT NULL,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  status      TEXT NOT NULL,
  upserted    INT NOT NULL DEFAULT 0,
  rejected    INT NOT NULL DEFAULT 0,
  error       TEXT
);

CREATE TABLE IF NOT EXISTS rejected_records (
  id          BIGSERIAL PRIMARY KEY,
  source      TEXT NOT NULL,
  raw         JSONB,
  reason      TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
