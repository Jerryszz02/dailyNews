-- Raw listings and their handoff survive worker interruption without advancing a source cursor.
ALTER TABLE sources ADD COLUMN collection_run_id bigint;
CREATE TABLE collection_intakes (
  run_id bigint PRIMARY KEY REFERENCES fetch_runs(id) ON DELETE CASCADE,
  source_id text NOT NULL REFERENCES sources(id),
  trial_id text,
  backfill text,
  cursor jsonb NOT NULL,
  receipt_ids jsonb NOT NULL DEFAULT '[]',
  detail jsonb NOT NULL DEFAULT '{}',
  finished_at timestamptz
);
CREATE TABLE collection_batches (
  id bigserial PRIMARY KEY,
  run_id bigint NOT NULL REFERENCES collection_intakes(run_id) ON DELETE CASCADE,
  dispatched_at timestamptz
);
CREATE TABLE collection_items (
  id bigserial PRIMARY KEY,
  batch_id bigint NOT NULL REFERENCES collection_batches(id) ON DELETE CASCADE,
  candidate jsonb NOT NULL,
  need jsonb,
  detail_attempts integer NOT NULL DEFAULT 0,
  detail_error text,
  detail_retry_at timestamptz,
  completed_at timestamptz,
  result jsonb
);
CREATE INDEX collection_batches_pending_idx ON collection_batches(run_id) WHERE dispatched_at IS NULL;
CREATE INDEX collection_items_pending_idx ON collection_items(batch_id) WHERE completed_at IS NULL;
CREATE INDEX collection_intakes_pending_idx ON collection_intakes(source_id) WHERE finished_at IS NULL;

CREATE TABLE collection_flow_control (
  id integer PRIMARY KEY CHECK(id=1), blocked boolean NOT NULL DEFAULT false,
  pending bigint NOT NULL DEFAULT 0,updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE articles ADD COLUMN source_detail_checked_at timestamptz;
ALTER TABLE articles ADD COLUMN source_listing_signature text;
