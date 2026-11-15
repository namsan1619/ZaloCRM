-- P4 — Chiến dịch Marketing (tracker — không gửi thật) (2026-11-15)
-- Add-only. Lưu ý: không xung đột với bảng automation_* của EE (tên khác).

CREATE TABLE IF NOT EXISTS campaigns (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL,
  name         TEXT NOT NULL,
  channel_code TEXT,
  type_code    TEXT,
  start_at     TIMESTAMP,
  end_at       TIMESTAMP,
  cost_vnd     BIGINT,
  status       TEXT NOT NULL DEFAULT 'DRAFT',
  script       TEXT,
  note         TEXT,
  created_by_id TEXT,
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS campaign_customer_lists (
  id               TEXT PRIMARY KEY,
  campaign_id      TEXT NOT NULL,
  customer_list_id TEXT NOT NULL,
  created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS campaign_projects (
  id          TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  project_id  TEXT NOT NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS campaigns_org_id_status_idx
  ON campaigns (org_id, status);
CREATE INDEX IF NOT EXISTS campaigns_org_id_start_at_end_at_idx
  ON campaigns (org_id, start_at, end_at);
CREATE UNIQUE INDEX IF NOT EXISTS campaign_customer_lists_campaign_id_customer_list_id_key
  ON campaign_customer_lists (campaign_id, customer_list_id);
CREATE UNIQUE INDEX IF NOT EXISTS campaign_projects_campaign_id_project_id_key
  ON campaign_projects (campaign_id, project_id);

DO $$ BEGIN
  ALTER TABLE campaigns ADD CONSTRAINT campaigns_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE campaign_customer_lists ADD CONSTRAINT ccl_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES campaigns (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE campaign_projects ADD CONSTRAINT cp_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES campaigns (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;