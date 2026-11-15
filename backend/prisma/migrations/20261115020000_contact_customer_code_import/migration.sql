-- P2 — Mã KH + Import 1M SĐT (2026-11-15)
-- Add-only: thêm cột + bảng mới, không xoá/sửa dữ liệu cũ.

-- Ghi chú: chống trùng mạnh theo SĐT chuẩn hoá được thêm ở bước SAU (sau khi dọn trùng),
-- vì unique index trên cột có dữ liệu cũ trùng sẽ fail migration. Bảng import dùng
-- chính pipeline hiện có (chống trùng app) trước; bước chỉ mục DB làm ở phase tinh chỉnh.

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS customer_code TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS rating_code TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS rating_note TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS rated_by_id TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS rated_at TIMESTAMP;

CREATE UNIQUE INDEX IF NOT EXISTS contacts_org_id_customer_code_key
  ON contacts (org_id, customer_code)
  WHERE customer_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS contacts_org_id_rating_code_idx
  ON contacts (org_id, rating_code);

CREATE TABLE IF NOT EXISTS contact_code_sequences (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL UNIQUE,
  last_value INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS contact_import_jobs (
  id             TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL,
  file_name      TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending',
  total_rows     INTEGER NOT NULL DEFAULT 0,
  processed_rows INTEGER NOT NULL DEFAULT 0,
  created_rows   INTEGER NOT NULL DEFAULT 0,
  duplicate_rows INTEGER NOT NULL DEFAULT 0,
  invalid_rows   INTEGER NOT NULL DEFAULT 0,
  error_rows     INTEGER NOT NULL DEFAULT 0,
  error_file     TEXT,
  options        JSONB,
  created_by_id  TEXT,
  started_at     TIMESTAMP,
  finished_at    TIMESTAMP,
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS contact_import_rows (
  id               TEXT PRIMARY KEY,
  job_id           TEXT NOT NULL,
  row_index        INTEGER NOT NULL,
  phone_raw        TEXT,
  phone_normalized TEXT,
  name_raw         TEXT,
  payload          JSONB NOT NULL DEFAULT '{}',
  status           TEXT NOT NULL DEFAULT 'pending',
  error_reason     TEXT,
  contact_id       TEXT,
  created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS contact_import_jobs_org_id_status_idx
  ON contact_import_jobs (org_id, status);
CREATE INDEX IF NOT EXISTS contact_import_jobs_org_id_created_at_idx
  ON contact_import_jobs (org_id, created_at);
CREATE INDEX IF NOT EXISTS contact_import_rows_job_id_status_idx
  ON contact_import_rows (job_id, status);
CREATE INDEX IF NOT EXISTS contact_import_rows_job_id_phone_normalized_idx
  ON contact_import_rows (job_id, phone_normalized);

DO $$ BEGIN
  ALTER TABLE contact_code_sequences
    ADD CONSTRAINT contact_code_sequences_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES organizations (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE contact_import_jobs
    ADD CONSTRAINT contact_import_jobs_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES organizations (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE contact_import_rows
    ADD CONSTRAINT contact_import_rows_job_id_fkey
    FOREIGN KEY (job_id) REFERENCES contact_import_jobs (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE contact_import_rows
    ADD CONSTRAINT contact_import_rows_contact_id_fkey
    FOREIGN KEY (contact_id) REFERENCES contacts (id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN null; END $$;