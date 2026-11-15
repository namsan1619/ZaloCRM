-- P1 — MasterData / Tùy chọn tự thêm-sửa (2026-11-15)
-- Add-only: không đụng dữ liệu bảng cũ.

CREATE TABLE IF NOT EXISTS master_data_categories (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL,
  key        TEXT NOT NULL,
  label      TEXT NOT NULL,
  icon       TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_system  BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS master_data (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL,
  category_id TEXT NOT NULL,
  code        TEXT NOT NULL,
  label       TEXT NOT NULL,
  parent_code TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  color       TEXT,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  metadata    JSONB,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS master_data_categories_org_id_key_key
  ON master_data_categories (org_id, key);
CREATE INDEX IF NOT EXISTS master_data_categories_org_id_sort_order_idx
  ON master_data_categories (org_id, sort_order);
CREATE UNIQUE INDEX IF NOT EXISTS master_data_category_id_code_key
  ON master_data (category_id, code);
CREATE INDEX IF NOT EXISTS master_data_org_id_category_id_sort_order_idx
  ON master_data (org_id, category_id, sort_order);

DO $$ BEGIN
  ALTER TABLE master_data_categories
    ADD CONSTRAINT master_data_categories_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES organizations (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE master_data
    ADD CONSTRAINT master_data_category_id_fkey
    FOREIGN KEY (category_id) REFERENCES master_data_categories (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE master_data
    ADD CONSTRAINT master_data_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES organizations (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
