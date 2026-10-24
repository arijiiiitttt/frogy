import pg from "pg";
import { requireEnv } from "../shared/util.js";

let pool: pg.Pool | null = null;
export function getPool(): pg.Pool {
  if (!pool) pool = new pg.Pool({ connectionString: requireEnv("DATABASE_URL"), max: 8, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 15_000 });
  return pool;
}
export const q = <T extends pg.QueryResultRow = any>(text: string, params: unknown[] = []) => getPool().query<T>(text, params);

export async function migrate(): Promise<void> {
  await q(`
CREATE TABLE IF NOT EXISTS tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  action text,
  input jsonb NOT NULL DEFAULT '{}',
  goal text,
  dry_run boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'queued',
  note text,
  result jsonb,
  error text,
  attempts int NOT NULL DEFAULT 0,
  idempotency_key text UNIQUE,
  schedule_id uuid,
  model text,
  tier text,
  run_after timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tasks_claim ON tasks (status, run_after);
CREATE TABLE IF NOT EXISTS events (
  id bigserial PRIMARY KEY,
  task_id uuid NOT NULL,
  ts timestamptz NOT NULL DEFAULT now(),
  type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS events_task ON events (task_id, id);
CREATE TABLE IF NOT EXISTS schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cron text NOT NULL,
  timezone text NOT NULL DEFAULT 'UTC',
  action text,
  input jsonb NOT NULL DEFAULT '{}',
  goal text,
  enabled boolean NOT NULL DEFAULT true,
  next_run_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS llm_calls (
  id bigserial PRIMARY KEY,
  task_id uuid,
  ts timestamptz NOT NULL DEFAULT now(),
  provider text, model text, via text,
  input_tokens int NOT NULL DEFAULT 0,
  output_tokens int NOT NULL DEFAULT 0,
  latency_ms int, switch_reason text
);
CREATE TABLE IF NOT EXISTS recipes (name text PRIMARY KEY, steps jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS cache (key text PRIMARY KEY, value jsonb NOT NULL, expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key text PRIMARY KEY, value jsonb NOT NULL);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS parent_id uuid;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS root_id uuid;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS depth int NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS role text;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS allow_actions boolean NOT NULL DEFAULT false;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS agent_state jsonb;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS max_steps int;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS budget_tokens int;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS want_plan boolean NOT NULL DEFAULT false;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS question text;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS answer text;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS want_verify boolean NOT NULL DEFAULT false;
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS agent jsonb;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS start_tier text;
CREATE TABLE IF NOT EXISTS tool_approvals (
  id text PRIMARY KEY, task_id uuid NOT NULL, tool_call_id text NOT NULL, summary text NOT NULL,
  status text NOT NULL DEFAULT 'pending', created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, tool_call_id)
);
CREATE TABLE IF NOT EXISTS skills (
  name text PRIMARY KEY, description text NOT NULL, instructions text NOT NULL, roles text[], updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tasks_parent ON tasks (parent_id);
CREATE INDEX IF NOT EXISTS tasks_root ON tasks (root_id);
CREATE TABLE IF NOT EXISTS memory (key text PRIMARY KEY, text text NOT NULL, root_id uuid, created_at timestamptz NOT NULL DEFAULT now());
`);
}

export async function addEvent(taskId: string, type: string, payload: Record<string, unknown> = {}): Promise<void> {
  await q("INSERT INTO events (task_id, type, payload) VALUES ($1,$2,$3)", [taskId, type, JSON.stringify(payload)]);
}

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const r = await q("SELECT value FROM settings WHERE key=$1", [key]);
  return r.rows[0] ? (r.rows[0].value as T) : fallback;
}
export async function setSetting(key: string, value: unknown): Promise<void> {
  await q("INSERT INTO settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", [key, JSON.stringify(value)]);
}
