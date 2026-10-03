-- The first time this policy result was eligible for public reading. A material or
-- policy invalidation clears it; a new decision gets a new timestamp. Reports use
-- this gate so a post-cutoff publication cannot enter an earlier frozen issue.
ALTER TABLE publications ADD COLUMN public_ready_at timestamptz;

CREATE INDEX publications_daily_ready_idx ON publications (public_ready_at, article_id)
  WHERE visibility = 'public' AND eligible AND NOT backfill;

CREATE INDEX editorial_decisions_daily_first_qualified_idx
  ON editorial_decisions (subject_id, primary_category, representative_article_id, evaluated_at)
  WHERE scope = 'fact' AND policy_id = 'dailynews-non-ai-fact'
    AND importance_tier IS NOT NULL AND importance_tier <> 'noise';
