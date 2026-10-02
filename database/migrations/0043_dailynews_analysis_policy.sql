-- Analysis remains append-only. Readers compare input_signature with the current material,
-- source tier, taxonomy, prompt, model and manual classification before using a result.
ALTER TABLE analyses
  ADD COLUMN policy_id text,
  ADD COLUMN policy_version text,
  ADD COLUMN classification_version text,
  ADD COLUMN input_signature text;

-- A null classification stays pending. Only this many automatic retries are offered for a
-- material revision; a new revision starts with a fresh budget.
ALTER TABLE articles
  ADD COLUMN classification_retry_revision integer NOT NULL DEFAULT 0,
  ADD COLUMN classification_retry_count integer NOT NULL DEFAULT 0,
  ADD COLUMN classification_fallback_revision integer NOT NULL DEFAULT 0,
  ADD COLUMN classification_fallback_count integer NOT NULL DEFAULT 0,
  ADD COLUMN classification_fallback_category text,
  ADD COLUMN classification_fallback_config_version text;
