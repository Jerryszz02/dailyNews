-- P5's local, immutable admission ledger. Keeping a row here also prevents ordinary
-- article retention from deleting a member of the measured cohort.
CREATE TABLE dailynews_trials (
  id text PRIMARY KEY,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'frozen', 'closed')),
  normal_limit integer NOT NULL DEFAULT 100 CHECK (normal_limit BETWEEN 1 AND 100),
  backfill_limit integer NOT NULL DEFAULT 20 CHECK (backfill_limit BETWEEN 0 AND 20),
  manifest_hash text NOT NULL,
  settings_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  frozen_at timestamptz,
  closed_at timestamptz
);
-- One measured cohort per isolated database. A new ID cannot refill a frozen quota.
CREATE UNIQUE INDEX dailynews_trials_single_cohort_idx ON dailynews_trials ((true));

CREATE TABLE dailynews_trial_sources (
  trial_id text NOT NULL REFERENCES dailynews_trials (id) ON DELETE RESTRICT,
  source_id text NOT NULL REFERENCES sources (id) ON DELETE RESTRICT,
  -- Set by the first actual collection, not by manifest creation.
  initialized_at timestamptz,
  source_config_hash text NOT NULL,
  PRIMARY KEY (trial_id, source_id)
);

CREATE TABLE dailynews_trial_articles (
  trial_id text NOT NULL REFERENCES dailynews_trials (id) ON DELETE RESTRICT,
  article_id text NOT NULL UNIQUE REFERENCES articles (id) ON DELETE RESTRICT,
  source_id text NOT NULL REFERENCES sources (id) ON DELETE RESTRICT,
  lane text NOT NULL CHECK (lane IN ('normal', 'backfill')),
  revision_at_admission integer NOT NULL,
  published_at_at_admission timestamptz,
  admitted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (trial_id, article_id),
  FOREIGN KEY (trial_id, source_id) REFERENCES dailynews_trial_sources (trial_id, source_id) ON DELETE RESTRICT
);
CREATE INDEX dailynews_trial_articles_lane_idx ON dailynews_trial_articles (trial_id, lane, admitted_at);

CREATE TABLE dailynews_trial_reports (
  trial_id text NOT NULL REFERENCES dailynews_trials (id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('daily', 'weekly', 'monthly')),
  report_key text NOT NULL,
  admitted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (trial_id, kind, report_key)
);
