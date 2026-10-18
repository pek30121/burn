-- Schema-agnostic on purpose: objects are created in the connection's search_path,
-- so tests can run each case in its own throw-away schema.

CREATE TABLE projects (
  id                 text PRIMARY KEY CHECK (id ~ '^[a-z0-9]([a-z0-9-]{0,46}[a-z0-9])?$'),
  name               text NOT NULL,
  ticker             text NOT NULL,
  cluster            text NOT NULL CHECK (cluster IN ('devnet', 'mainnet-beta')),
  mint               text NOT NULL,
  decimals           smallint NOT NULL CHECK (decimals BETWEEN 0 AND 18),
  token_program      text NOT NULL CHECK (token_program IN ('spl-token', 'token-2022')),
  initial_supply_raw numeric(20,0) CHECK (initial_supply_raw > 0 AND initial_supply_raw <= 18446744073709551615),
  start_slot         bigint NOT NULL DEFAULT 0 CHECK (start_slot >= 0),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cluster, mint)
);

-- Snapshot of the configured levels (the engine keeps computing from its config).
CREATE TABLE levels (
  project_id    text NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  position      integer NOT NULL CHECK (position >= 0),
  level_id      text NOT NULL,
  name          text NOT NULL,
  threshold_raw numeric(20,0) NOT NULL CHECK (threshold_raw >= 0 AND threshold_raw <= 18446744073709551615),
  PRIMARY KEY (project_id, position),
  UNIQUE (project_id, level_id)
);

-- One row per burn instruction. The primary key IS the idempotency key.
CREATE TABLE burns (
  project_id       text NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
  signature        text NOT NULL,
  instruction_path text NOT NULL CHECK (instruction_path ~ '^(0|[1-9][0-9]{0,2})(\.(0|[1-9][0-9]{0,2}))?$'),
  slot             bigint NOT NULL CHECK (slot >= 0),
  block_time       bigint,
  owner            text NOT NULL,
  amount_raw       numeric(20,0) NOT NULL CHECK (amount_raw > 0 AND amount_raw <= 18446744073709551615),
  commitment       text NOT NULL CHECK (commitment IN ('confirmed', 'finalized')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  finalized_at     timestamptz,
  PRIMARY KEY (project_id, signature, instruction_path),
  CHECK ((commitment = 'finalized') = (finalized_at IS NOT NULL))
);
CREATE INDEX burns_by_slot ON burns (project_id, slot DESC, signature);
CREATE INDEX burns_by_owner ON burns (project_id, owner);
CREATE INDEX burns_confirmed ON burns (project_id, slot) WHERE commitment = 'confirmed';

-- Running totals, updated in the same transaction as the burn that changes them.
CREATE TABLE project_counters (
  project_id         text PRIMARY KEY REFERENCES projects (id) ON DELETE CASCADE,
  finalized_raw      numeric(20,0) NOT NULL DEFAULT 0 CHECK (finalized_raw >= 0),
  confirmed_only_raw numeric(20,0) NOT NULL DEFAULT 0 CHECK (confirmed_only_raw >= 0),
  burn_count         bigint NOT NULL DEFAULT 0 CHECK (burn_count >= 0),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Level reached + outbox in one table: the primary key makes "level reached" happen
-- at most once per project; delivered_at only tracks delivery, never the business effect.
CREATE TABLE level_events (
  seq          bigint GENERATED ALWAYS AS IDENTITY,
  project_id   text NOT NULL,
  level_id     text NOT NULL,
  level_index  integer NOT NULL CHECK (level_index >= 1),
  total_raw    numeric(20,0) NOT NULL,
  triggered_by text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  PRIMARY KEY (project_id, level_id),
  FOREIGN KEY (project_id, level_id) REFERENCES levels (project_id, level_id)
);
CREATE INDEX level_events_pending ON level_events (project_id, seq) WHERE delivered_at IS NULL;

CREATE TABLE index_state (
  project_id          text PRIMARY KEY REFERENCES projects (id) ON DELETE CASCADE,
  finalized_head      text,
  finalized_head_slot bigint,
  backfill_before     text,
  backfill            text NOT NULL CHECK (backfill IN ('pending', 'running', 'done_start_slot', 'done_exhausted')),
  verification        jsonb NOT NULL,
  version             bigint NOT NULL DEFAULT 0,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE index_issues (
  seq        bigint GENERATED ALWAYS AS IDENTITY,
  project_id text NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  code       text NOT NULL,
  signature  text NOT NULL DEFAULT '',
  detail     text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, code, signature)
);
CREATE INDEX index_issues_order ON index_issues (project_id, seq);
