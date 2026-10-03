-- Keep article-level AI judgements and fact-level Daily News decisions separate.
ALTER TABLE articles ADD COLUMN editorial_category text
  CHECK (editorial_category IN ('ai','technology','finance','international','china','policy','society','science','sports','entertainment'));

CREATE TABLE editorial_decisions (
  id bigserial PRIMARY KEY,
  scope text NOT NULL CHECK (scope IN ('article','fact')),
  subject_id text NOT NULL,
  policy_id text NOT NULL,
  policy_version text NOT NULL,
  classification_version text NOT NULL,
  input_signature text NOT NULL,
  input_revision integer,
  evidence_version text,
  primary_category text,
  score_kind text,
  score numeric,
  importance_tier text,
  fact_status text,
  selected boolean NOT NULL DEFAULT false,
  representative_article_id text REFERENCES articles(id) ON DELETE SET NULL,
  details jsonb NOT NULL DEFAULT '{}',
  evaluated_at timestamptz NOT NULL DEFAULT now(),
  next_reevaluation_at timestamptz
);
CREATE INDEX editorial_decisions_subject_idx ON editorial_decisions(scope, subject_id, id DESC);

CREATE TABLE fact_editorial_state (
  fact_id bigint PRIMARY KEY REFERENCES facts(id) ON DELETE CASCADE,
  decision_id bigint REFERENCES editorial_decisions(id),
  primary_category text,
  evidence_version text NOT NULL,
  representative_article_id text REFERENCES articles(id) ON DELETE SET NULL,
  next_reevaluation_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fact_editorial_due_idx ON fact_editorial_state(next_reevaluation_at)
  WHERE next_reevaluation_at IS NOT NULL;

ALTER TABLE publications
  ADD COLUMN decision_id bigint REFERENCES editorial_decisions(id),
  ADD COLUMN policy_id text,
  ADD COLUMN policy_version text,
  ADD COLUMN classification_version text,
  ADD COLUMN policy_signature text,
  ADD COLUMN input_revision integer,
  ADD COLUMN policy_tier text,
  ADD COLUMN score_kind text,
  ADD COLUMN importance_tier text,
  ADD COLUMN fact_status text;
