-- Frozen Daily News source/section identity and publisher grouping for the AIHOT source table.
-- Seed rows are inserted by scripts/seed.ts only when an ID is absent; later config changes require
-- an explicit reviewed migration or admin edit and are never pushed by reseeding.
ALTER TABLE sources
  ADD COLUMN publisher_key text GENERATED ALWAYS AS (NULLIF(config #>> '{dailyNews,publisherKey}', '')) STORED,
  ADD COLUMN legacy_source_id text GENERATED ALWAYS AS (NULLIF(config #>> '{dailyNews,legacySourceId}', '')) STORED,
  ADD COLUMN legacy_section_id text GENERATED ALWAYS AS (NULLIF(config #>> '{dailyNews,sectionId}', '')) STORED;

CREATE UNIQUE INDEX dailynews_legacy_section_unique ON sources (legacy_source_id, legacy_section_id)
  WHERE legacy_source_id IS NOT NULL AND legacy_section_id IS NOT NULL;
CREATE INDEX dailynews_publisher_key_idx ON sources (publisher_key) WHERE publisher_key IS NOT NULL;

-- Existing heat/participant readers use signal_group_id, so every imported section of one
-- publisher must receive the same value on first insert. A later identity change is intentional
-- admin/migration work; this trigger never silently rewrites an existing source's identity.
CREATE FUNCTION dailynews_source_identity_on_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.config ? 'dailyNews' THEN
    IF NEW.config #>> '{dailyNews,legacySourceId}' IS NULL OR
       NEW.config #>> '{dailyNews,sectionId}' IS NULL OR
       NEW.config #>> '{dailyNews,publisherKey}' IS NULL THEN
      RAISE EXCEPTION 'Daily News source % lacks section/publisher identity', NEW.id;
    END IF;
    IF NEW.signal_group_id IS NULL THEN
      NEW.signal_group_id := NEW.config #>> '{dailyNews,publisherKey}';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER dailynews_source_identity_insert BEFORE INSERT ON sources
  FOR EACH ROW EXECUTE FUNCTION dailynews_source_identity_on_insert();

-- Missing budget rows are unlimited in the receipt layer. Explicit zero prevents accidental
-- Firecrawl spending even if a per-source flag and credentials are configured.
INSERT INTO budgets (service, per_minute, per_hour, per_day, note)
VALUES ('firecrawl', 0, 0, 0, 'Daily News fallback disabled until reviewed source and spend budget approval')
ON CONFLICT (service) DO NOTHING;
