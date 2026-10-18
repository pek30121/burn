-- Durable, ordered event log per project: the source of truth of the REST /events endpoint
-- and of the SSE stream. One row per finalized burn and per level reached ("mutation").
--
-- Ordering guarantee: seq is allocated from project_counters.event_seq while the writer holds
-- that row's lock (FOR UPDATE) until commit, so commit order == seq order for a project and a
-- reader can never observe seq N+1 without seq N. Rows are inserted in the same transaction
-- as the burn / counters / level event they describe.

ALTER TABLE project_counters ADD COLUMN event_seq bigint NOT NULL DEFAULT 0 CHECK (event_seq >= 0);

CREATE TABLE project_events (
  project_id       text NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
  seq              bigint NOT NULL CHECK (seq >= 1),
  kind             text NOT NULL CHECK (kind IN ('burn', 'mutation')),
  signature        text,
  instruction_path text,
  level_id         text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, seq),
  CHECK (
    (kind = 'burn' AND signature IS NOT NULL AND instruction_path IS NOT NULL AND level_id IS NULL) OR
    (kind = 'mutation' AND level_id IS NOT NULL AND signature IS NULL AND instruction_path IS NULL)
  ),
  FOREIGN KEY (project_id, signature, instruction_path) REFERENCES burns (project_id, signature, instruction_path),
  FOREIGN KEY (project_id, level_id) REFERENCES level_events (project_id, level_id)
);
-- A burn / a level produces at most one event, whatever is replayed.
CREATE UNIQUE INDEX project_events_burn_once ON project_events (project_id, signature, instruction_path) WHERE kind = 'burn';
CREATE UNIQUE INDEX project_events_mutation_once ON project_events (project_id, level_id) WHERE kind = 'mutation';

-- Databases created before this migration: rebuild the log from what is stored. Historic
-- order is approximate (burns by finalization time, then levels); new events are exact.
INSERT INTO project_events (project_id, seq, kind, signature, instruction_path, created_at)
SELECT project_id,
       row_number() OVER (PARTITION BY project_id ORDER BY finalized_at, slot, signature, instruction_path),
       'burn', signature, instruction_path, finalized_at
FROM burns WHERE commitment = 'finalized';

INSERT INTO project_events (project_id, seq, kind, level_id, created_at)
SELECT le.project_id,
       COALESCE(c.n, 0) + row_number() OVER (PARTITION BY le.project_id ORDER BY le.seq),
       'mutation', le.level_id, le.created_at
FROM level_events le
LEFT JOIN (SELECT project_id, count(*) AS n FROM project_events GROUP BY project_id) c ON c.project_id = le.project_id;

UPDATE project_counters pc
SET event_seq = COALESCE((SELECT max(seq) FROM project_events e WHERE e.project_id = pc.project_id), 0);
