-- P3 — Nguồn hàng: Đại lý / Dự án / Căn (2026-11-15)
-- Add-only.

CREATE TABLE IF NOT EXISTS agencies (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL,
  code         TEXT NOT NULL,
  name         TEXT NOT NULL,
  phone        TEXT,
  contact_name TEXT,
  note         TEXT,
  is_active    BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS projects (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  name          TEXT NOT NULL,
  developer     TEXT,
  province      TEXT,
  district      TEXT,
  address       TEXT,
  handover_year INTEGER,
  note          TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS properties (
  id                    TEXT PRIMARY KEY,
  org_id                TEXT NOT NULL,
  project_id            TEXT NOT NULL,
  agency_id             TEXT,
  unit_code             TEXT NOT NULL,
  zone_name             TEXT,
  block_name            TEXT,
  property_type_code    TEXT,
  category              TEXT,
  transaction_type      TEXT DEFAULT 'SALE',
  status_code           TEXT NOT NULL DEFAULT 'AVAILABLE',
  status_note           TEXT,
  floor_no              INTEGER,
  total_floors          INTEGER,
  bedrooms              INTEGER,
  bathrooms             INTEGER,
  price_vnd             BIGINT,
  price_rent_vnd        BIGINT,
  price_basis_code      TEXT DEFAULT 'TOTAL',
  price_note            TEXT,
  price_tts_vnd         BIGINT,
  price_htls_vnd        BIGINT,
  unit_price_tts_vnd    BIGINT,
  special_mechanism_code TEXT,
  usable_area_m2        DOUBLE PRECISION,
  tim_tuong_area_m2     DOUBLE PRECISION,
  land_area_m2          DOUBLE PRECISION,
  construction_area_m2  DOUBLE PRECISION,
  frontage_m            DOUBLE PRECISION,
  depth_m               DOUBLE PRECISION,
  road_width_m          DOUBLE PRECISION,
  balcony_direction_code TEXT,
  view_code             TEXT,
  direction_code        TEXT,
  land_direction_code   TEXT,
  legal_code            TEXT,
  legal_note            TEXT,
  handover_code         TEXT,
  furniture_code        TEXT,
  handover_year         INTEGER,
  assigned_user_id      TEXT,
  note                  TEXT,
  info_checked_at       TIMESTAMP,
  attributes            JSONB NOT NULL DEFAULT '{}',
  is_active             BOOLEAN NOT NULL DEFAULT true,
  created_at            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS property_media (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL,
  property_id TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'IMAGE',
  url         TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS agencies_org_id_code_key
  ON agencies (org_id, code);
CREATE UNIQUE INDEX IF NOT EXISTS projects_org_id_name_key
  ON projects (org_id, name);
CREATE UNIQUE INDEX IF NOT EXISTS properties_org_id_project_id_unit_code_key
  ON properties (org_id, project_id, unit_code);
CREATE INDEX IF NOT EXISTS properties_org_id_project_id_status_code_idx
  ON properties (org_id, project_id, status_code);
CREATE INDEX IF NOT EXISTS properties_org_id_status_code_idx
  ON properties (org_id, status_code);
CREATE INDEX IF NOT EXISTS properties_org_id_agency_id_idx
  ON properties (org_id, agency_id);
CREATE INDEX IF NOT EXISTS properties_org_id_price_vnd_idx
  ON properties (org_id, price_vnd);
CREATE INDEX IF NOT EXISTS properties_org_id_property_type_code_idx
  ON properties (org_id, property_type_code);
CREATE INDEX IF NOT EXISTS property_media_property_id_sort_order_idx
  ON property_media (property_id, sort_order);

DO $$ BEGIN
  ALTER TABLE agencies   ADD CONSTRAINT agencies_org_id_fkey    FOREIGN KEY (org_id) REFERENCES organizations (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE projects   ADD CONSTRAINT projects_org_id_fkey    FOREIGN KEY (org_id) REFERENCES organizations (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE properties ADD CONSTRAINT properties_org_id_fkey  FOREIGN KEY (org_id) REFERENCES organizations (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE properties ADD CONSTRAINT properties_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE properties ADD CONSTRAINT properties_agency_id_fkey  FOREIGN KEY (agency_id) REFERENCES agencies (id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE property_media ADD CONSTRAINT property_media_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE property_media ADD CONSTRAINT property_media_property_id_fkey FOREIGN KEY (property_id) REFERENCES properties (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;