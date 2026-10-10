-- A dirty generation commits with public article updates; jobs are only wake-ups.
CREATE TABLE editorial_batch_state (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  generation bigint NOT NULL DEFAULT 0,
  applied_generation bigint NOT NULL DEFAULT 0,
  pending_events integer NOT NULL DEFAULT 0 CHECK (pending_events >= 0),
  first_dirty_at timestamptz,
  CHECK (applied_generation <= generation)
);
INSERT INTO editorial_batch_state(id) VALUES(true);
CREATE TABLE fact_feature_cache (
  fact_id bigint PRIMARY KEY REFERENCES facts(id) ON DELETE CASCADE,
  input_signature text NOT NULL,
  policy_version text NOT NULL,
  features jsonb NOT NULL,
  evaluated_at timestamptz NOT NULL,
  next_reevaluation_at timestamptz
);
