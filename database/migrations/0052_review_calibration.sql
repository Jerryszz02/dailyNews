-- One bounded local experiment. Existing assisted answers and revisions stay intact.
ALTER TABLE review_batches DROP CONSTRAINT review_batches_mode_check;
ALTER TABLE review_batches ADD CONSTRAINT review_batches_mode_check CHECK (mode IN ('assisted','blind'));
ALTER TABLE review_tasks DROP CONSTRAINT review_tasks_mode_check;
ALTER TABLE review_tasks ADD CONSTRAINT review_tasks_mode_check CHECK (mode IN ('assisted','blind'));

CREATE TABLE review_calibration_candidates (
 id text PRIMARY KEY,
 batch_id text NOT NULL REFERENCES review_batches(id),
 request_id text NOT NULL UNIQUE,
 labels_hash text NOT NULL,
 policy jsonb NOT NULL,
 report jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (batch_id,labels_hash)
);
CREATE TABLE review_calibration_state (
 id integer PRIMARY KEY CHECK (id=1),
 batch_id text NOT NULL UNIQUE REFERENCES review_batches(id),
 active_candidate_id text REFERENCES review_calibration_candidates(id),
 frozen boolean NOT NULL DEFAULT false
);
CREATE TABLE review_calibration_members (
 task_id text PRIMARY KEY REFERENCES review_tasks(id),
 batch_id text NOT NULL REFERENCES review_batches(id),
 split text NOT NULL CHECK (split IN ('train','holdout')),
 event_key text NOT NULL,
 UNIQUE (batch_id,event_key)
);
CREATE TABLE review_calibration_actions (
 request_id text PRIMARY KEY,
 request_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
