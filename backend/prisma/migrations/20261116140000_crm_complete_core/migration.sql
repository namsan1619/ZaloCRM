-- P0 CRM môi giới Vinhomes (2026-11-16)
-- 5 bảng additive cho CRM hoàn chỉnh. Idempotent: CREATE ... IF NOT EXISTS.

-- ── Sản phẩm KH quan tâm (tab CRM chat) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS contact_interests (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  contact_id    TEXT NOT NULL,
  property_id   TEXT,
  project_id    TEXT,
  interest_code TEXT NOT NULL DEFAULT 'QUAN_TAM',
  note          TEXT,
  source        TEXT,
  created_by_id TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS contact_interests_org_contact_idx ON contact_interests (org_id, contact_id);
CREATE INDEX IF NOT EXISTS contact_interests_org_property_idx ON contact_interests (org_id, property_id);
CREATE INDEX IF NOT EXISTS contact_interests_org_project_idx ON contact_interests (org_id, project_id);
CREATE INDEX IF NOT EXISTS contact_interests_org_interest_idx ON contact_interests (org_id, interest_code);

-- ── Kịch bản tin nhắn chiến dịch ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS campaign_scripts (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL,
  content       TEXT NOT NULL,
  media_urls    JSONB NOT NULL DEFAULT '[]',
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_by_id TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT campaign_scripts_org_name_unique UNIQUE (org_id, name)
);

CREATE INDEX IF NOT EXISTS campaign_scripts_org_kind_idx ON campaign_scripts (org_id, kind, is_active);

-- ── Đợt chạy chiến dịch thật (kết bạn / chăm sóc) ───────────────────────────
CREATE TABLE IF NOT EXISTS campaign_runs (
  id                        TEXT PRIMARY KEY,
  org_id                    TEXT NOT NULL,
  campaign_id               TEXT NOT NULL,
  name                      TEXT NOT NULL,
  mode                      TEXT NOT NULL DEFAULT 'friend_request',
  status                    TEXT NOT NULL DEFAULT 'DRAFT',
  zalo_account_ids          JSONB NOT NULL DEFAULT '[]',
  daily_friend_request_limit INTEGER,
  greeting_script_id        TEXT,
  greeting_script_text      TEXT,
  care_script_ids           JSONB NOT NULL DEFAULT '[]',
  care_interval_days        INTEGER,
  configured_total          INTEGER NOT NULL DEFAULT 0,
  queued_count              INTEGER NOT NULL DEFAULT 0,
  sent_count                INTEGER NOT NULL DEFAULT 0,
  accepted_count            INTEGER NOT NULL DEFAULT 0,
  replied_count             INTEGER NOT NULL DEFAULT 0,
  no_zalo_count             INTEGER NOT NULL DEFAULT 0,
  failed_count              INTEGER NOT NULL DEFAULT 0,
  skipped_count             INTEGER NOT NULL DEFAULT 0,
  started_at                TIMESTAMPTZ,
  paused_at                 TIMESTAMPTZ,
  finished_at               TIMESTAMPTZ,
  created_by_id             TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS campaign_runs_org_status_idx ON campaign_runs (org_id, status);
CREATE INDEX IF NOT EXISTS campaign_runs_campaign_status_idx ON campaign_runs (campaign_id, status);
CREATE INDEX IF NOT EXISTS campaign_runs_org_campaign_created_idx ON campaign_runs (org_id, campaign_id, created_at DESC);

-- ── Trạng thái per-KH trong đợt chạy ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS campaign_contacts (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL,
  campaign_id     TEXT NOT NULL,
  run_id          TEXT NOT NULL,
  contact_id      TEXT NOT NULL,
  zalo_account_id TEXT,
  state           TEXT NOT NULL DEFAULT 'queued',
  attempt_id      TEXT,
  error_code      TEXT,
  error_detail    TEXT,
  scheduled_at    TIMESTAMPTZ,
  sent_at         TIMESTAMPTZ,
  accepted_at     TIMESTAMPTZ,
  replied_at      TIMESTAMPTZ,
  last_care_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT campaign_contacts_run_contact_unique UNIQUE (run_id, contact_id)
);

CREATE INDEX IF NOT EXISTS campaign_contacts_org_state_idx ON campaign_contacts (org_id, state);
CREATE INDEX IF NOT EXISTS campaign_contacts_run_state_idx ON campaign_contacts (run_id, state);
CREATE INDEX IF NOT EXISTS campaign_contacts_org_contact_campaign_idx ON campaign_contacts (org_id, contact_id, campaign_id);

-- ── Lịch sử đánh giá KH (A/B/C/D theo thời gian) ────────────────────────────
CREATE TABLE IF NOT EXISTS rating_histories (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  contact_id    TEXT NOT NULL,
  from_code     TEXT,
  to_code       TEXT NOT NULL,
  reason        TEXT,
  changed_by_id TEXT,
  changed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  campaign_id   TEXT
);

CREATE INDEX IF NOT EXISTS rating_histories_org_contact_changed_idx ON rating_histories (org_id, contact_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS rating_histories_org_campaign_idx ON rating_histories (org_id, campaign_id);