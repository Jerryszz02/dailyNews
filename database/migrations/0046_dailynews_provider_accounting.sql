-- P5: provider response identity, observed token breakdown and the explicit price snapshot
-- used for an estimate. No historical receipt is assigned a guessed model or price.
ALTER TABLE receipts
  ADD COLUMN response_model text,
  ADD COLUMN prompt_tokens integer,
  ADD COLUMN cache_hit_tokens integer,
  ADD COLUMN cache_miss_tokens integer,
  ADD COLUMN completion_tokens integer,
  ADD COLUMN price_snapshot jsonb,
  ADD COLUMN priced_at timestamptz,
  ALTER COLUMN cost TYPE numeric(20, 12);

ALTER TABLE receipt_attempts
  ADD COLUMN is_llm boolean NOT NULL DEFAULT false,
  ADD COLUMN response_model text,
  ADD COLUMN prompt_tokens integer,
  ADD COLUMN cache_hit_tokens integer,
  ADD COLUMN cache_miss_tokens integer,
  ADD COLUMN completion_tokens integer,
  ADD COLUMN price_snapshot jsonb,
  ADD COLUMN priced_at timestamptz,
  ALTER COLUMN cost TYPE numeric(20, 12);

CREATE INDEX receipt_attempts_active_llm_idx ON receipt_attempts (started_at)
  WHERE is_llm AND origin = 'live' AND status = 'pending';
