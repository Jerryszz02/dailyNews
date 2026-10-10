-- Immutable review materials survive changes to articles and analyses. Annotation never edits publication.
CREATE TABLE review_batches (
 id text PRIMARY KEY, request_id text NOT NULL UNIQUE, request_hash text NOT NULL,
 label text NOT NULL, mode text NOT NULL CHECK (mode='assisted'), created_by text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE review_tasks (
 id text PRIMARY KEY, batch_id text NOT NULL REFERENCES review_batches(id) ON DELETE CASCADE,
 position integer NOT NULL, kind text NOT NULL CHECK (kind IN ('article','relation')),
 mode text NOT NULL CHECK (mode='assisted'), stratum text NOT NULL,
 snapshot_key text NOT NULL UNIQUE, snapshot jsonb NOT NULL,
 version integer NOT NULL DEFAULT 0, status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','skipped','later')),
 answer jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(batch_id,position)
);
CREATE TABLE review_revisions (
 task_id text NOT NULL REFERENCES review_tasks(id) ON DELETE CASCADE, version integer NOT NULL,
 request_id text NOT NULL UNIQUE, request_hash text NOT NULL, status text NOT NULL CHECK (status IN ('completed','skipped','later')),
 answer jsonb NOT NULL, actor text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(task_id,version)
);
CREATE INDEX review_tasks_batch_idx ON review_tasks(batch_id,position);
