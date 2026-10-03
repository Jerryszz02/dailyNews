-- Keep the fixed cohort and each source baseline immutable after trial initialization.
CREATE FUNCTION dailynews_trial_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'dailynews_trials' THEN
    IF (NEW.id,NEW.normal_limit,NEW.backfill_limit,NEW.manifest_hash,NEW.settings_hash,NEW.created_at)
       IS DISTINCT FROM (OLD.id,OLD.normal_limit,OLD.backfill_limit,OLD.manifest_hash,OLD.settings_hash,OLD.created_at)
       OR (OLD.status = 'closed' AND NEW.status <> 'closed')
       OR (OLD.status = 'frozen' AND NEW.status = 'open') THEN
      RAISE EXCEPTION 'bounded trial identity and limits are immutable';
    END IF;
  ELSIF TG_TABLE_NAME = 'dailynews_trial_sources' THEN
    IF (NEW.trial_id,NEW.source_id,NEW.source_config_hash)
       IS DISTINCT FROM (OLD.trial_id,OLD.source_id,OLD.source_config_hash)
       OR (OLD.initialized_at IS NOT NULL AND NEW.initialized_at IS DISTINCT FROM OLD.initialized_at) THEN
      RAISE EXCEPTION 'bounded trial source baseline is immutable';
    END IF;
  ELSIF TG_TABLE_NAME = 'dailynews_trial_articles' THEN
    RAISE EXCEPTION 'bounded trial article admission is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER dailynews_trials_immutable_update BEFORE UPDATE ON dailynews_trials
  FOR EACH ROW EXECUTE FUNCTION dailynews_trial_immutable();
CREATE TRIGGER dailynews_trial_sources_immutable_update BEFORE UPDATE ON dailynews_trial_sources
  FOR EACH ROW EXECUTE FUNCTION dailynews_trial_immutable();
CREATE TRIGGER dailynews_trial_articles_immutable_update BEFORE UPDATE ON dailynews_trial_articles
  FOR EACH ROW EXECUTE FUNCTION dailynews_trial_immutable();
