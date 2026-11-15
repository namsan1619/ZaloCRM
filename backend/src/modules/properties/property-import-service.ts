// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyễn Tiến Lộc
/**
 * property-import-service.ts — Parse bảng hàng (CSV/XLSX) → validate → upsert Căn.
 *
 * Luồng:
 *   1. parseImportFile(buffer, filename)  → { headers, rows } (CSV tự parse, XLSX dùng ExcelJS)
 *   2. mapRows(headers, rows)              → ImportedProperty[] + lỗi theo dòng
 *   3. previewImport(...)                  → KHÔNG ghi DB, trả preview + thống kê
 *   4. runImport(...)                      → upsert theo unique(orgId, projectId, unitCode)
 *
 * Khoá duy nhất: @@unique([orgId, projectId, unitCode]) trên model Property.
 * Dòng đã tồn tại → UPDATE (chỉ các field có trong file), chưa có → CREATE.
 *
 * GIÁ (BigInt): priceVnd & priceRentVnd là BigInt trong DB. Import parse từ text
 * ("1.2 tỷ", "850tr", "1.200.000.000") → BigInt, và serialize ra string khi trả về
 * client (JSON.stringify không nhận BigInt — xem property-service.serializeProperty).
 */

import ExcelJS from 'exceljs';
import { prisma, tenantTransaction } from '../../shared/database/prisma-client.js';
import { CrmError, normalizeUnitCode, parsePriceText } from './property-service.js';

// ── Kiểu dữ liệu ───────────────────────────────────────────────────────────
export type ImportField =
  | 'unitCode'
  | 'projectName'
  | 'agencyCode'
  | 'agencyName'
  | 'zoneName'
  | 'blockName'
  | 'propertyTypeCode'
  | 'category'
  | 'transactionType'
  | 'statusCode'
  | 'statusNote'
  | 'floorNo'
  | 'totalFloors'
  | 'bedrooms'
  | 'bathrooms'
  | 'priceVnd'
  | 'priceRentVnd'
  | 'priceBasisCode'
  | 'priceNote'
  | 'usableAreaM2'
  | 'timTuongAreaM2'
  | 'landAreaM2'
  | 'constructionAreaM2'
  | 'frontageM'
  | 'depthM'
  | 'directionCode'
  | 'balconyDirectionCode'
  | 'viewCode'
  | 'legalCode'
  | 'legalNote'
  | 'handoverCode'
  | 'furnitureCode'
  | 'handoverYear'
  | 'specialMechanismCode'
  | 'note';

export interface ParsedImportFile {
  headers: string[];
  rows: string[][];
  /** Số dòng bỏ trống hoàn toàn (đã skip). */
  skippedBlankRows: number;
}

export interface ImportedProperty {
  unitCode: string;
  projectName?: string | null;
  agencyCode?: string | null;
  agencyName?: string | null;
  zoneName?: string | null;
  blockName?: string | null;
  propertyTypeCode?: string | null;
  category?: string | null;
  transactionType?: string | null;
  statusCode?: string | null;
  statusNote?: string | null;
  floorNo?: number | null;
  totalFloors?: number | null;
  bedrooms?: number | null;
  bathrooms?: number | null;
  priceVnd?: bigint | null;
  priceRentVnd?: bigint | null;
  priceBasisCode?: string | null;
  priceNote?: string | null;
  usableAreaM2?: number | null;
  timTuongAreaM2?: number | null;
  landAreaM2?: number | null;
  constructionAreaM2?: number | null;
  frontageM?: number | null;
  depthM?: number | null;
  directionCode?: string | null;
  balconyDirectionCode?: string | null;
  viewCode?: string | null;
  legalCode?: string | null;
  legalNote?: string | null;
  handoverCode?: string | null;
  furnitureCode?: string | null;
  handoverYear?: number | null;
  specialMechanismCode?: string | null;
  note?: string | null;
}

export interface ImportRowResult {
  /** Số dòng trong file (1-based, tính cả header). */
  rowNumber: number;
  unitCode: string | null;
  action: 'create' | 'update' | 'error';
  errors: string[];
  warnings: string[];
  /** Giá đã serialize sang string (BigInt → string) để client hiển thị. */
  priceVnd?: string | null;
  priceRentVnd?: string | null;
}

export interface ImportSummary {
  totalRows: number;
  created: number;
  updated: number;
  skipped: number;
  errorRows: number;
  /** Danh sách lỗi (rowNumber, unitCode, message) — client tải về để sửa file. */
  errors: Array<{ rowNumber: number; unitCode: string | null; message: string }>;
}

export interface ImportPreview {
  totalRows: number;
  validRows: number;
  invalidRows: number;
  willCreate: number;
  willUpdate: number;
  /** Map mã đại lý trong file → tên hiện có trong DB (null = chưa có, sẽ tạo khi import). */
  projects: Array<{ id: string; name: string }>;
  agencies: Array<{ id: string; code: string; name: string }>;
  rows: ImportRowResult[];
}

// ── Chuẩn hoá header ───────────────────────────────────────────────────────
/** Bỏ dấu + lowercase + gộp khoảng trắng. "Mã Căn  " → "ma can". */
export function normalizeHeader(raw: string): string {
  return String(raw ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Ánh xạ header tiếng Việt/English → field Property.
 * Key = header đã normalize (lowercase, dấu đã bỏ).
 */
const HEADER_ALIASES: Record<string, ImportField> = {
  // Mã căn
  'ma can': 'unitCode',
  'ma canh': 'unitCode',
  'ma so can': 'unitCode',
  'unit code': 'unitCode',
  'unitcode': 'unitCode',
  'can': 'unitCode',
  // Dự án
  'du an': 'projectName',
  'ten du an': 'projectName',
  'project': 'projectName',
  'project name': 'projectName',
  // Đại lý
  'ma dai ly': 'agencyCode',
  'ma dl': 'agencyCode',
  'agency code': 'agencyCode',
  'agencycode': 'agencyCode',
  'ten dai ly': 'agencyName',
  'dai ly': 'agencyName',
  'agency name': 'agencyName',
  'agency': 'agencyName',
  // Vị trí
  'phan khu': 'zoneName',
  'zone': 'zoneName',
  'toa': 'blockName',
  'toa nha': 'blockName',
  'block': 'blockName',
  'tower': 'blockName',
  // Phân loại
  'loai can': 'propertyTypeCode',
  'loai hinh': 'propertyTypeCode',
  'property type': 'propertyTypeCode',
  'hang muc': 'category',
  'category': 'category',
  'loai giao dich': 'transactionType',
  'giao dich': 'transactionType',
  'transaction type': 'transactionType',
  // Trạng thái
  'trang thai': 'statusCode',
  'status': 'statusCode',
  'status code': 'statusCode',
  'ghi chu trang thai': 'statusNote',
  'status note': 'statusNote',
  // Số liệu
  'tang': 'floorNo',
  'tang so': 'floorNo',
  'floor': 'floorNo',
  'floor no': 'floorNo',
  'tong so tang': 'totalFloors',
  'total floors': 'totalFloors',
  'phong ngu': 'bedrooms',
  'so phong ngu': 'bedrooms',
  'bedroom': 'bedrooms',
  'bedrooms': 'bedrooms',
  'phong tam': 'bathrooms',
  'toilet': 'bathrooms',
  'bathroom': 'bathrooms',
  'bathrooms': 'bathrooms',
  // Giá
  'gia': 'priceVnd',
  'gia ban': 'priceVnd',
  'gia vnd': 'priceVnd',
  'price': 'priceVnd',
  'gia thue': 'priceRentVnd',
  'gia cho thue': 'priceRentVnd',
  'rent price': 'priceRentVnd',
  'don vi gia': 'priceBasisCode',
  'price basis': 'priceBasisCode',
  'ghi chu gia': 'priceNote',
  'price note': 'priceNote',
  // Diện tích
  'dien tich': 'usableAreaM2',
  'dien tich su dung': 'usableAreaM2',
  'usable area': 'usableAreaM2',
  'area': 'usableAreaM2',
  'dien tich tim tuong': 'timTuongAreaM2',
  'tim tuong': 'timTuongAreaM2',
  'dien tich dat': 'landAreaM2',
  'land area': 'landAreaM2',
  'dien tich xay dung': 'constructionAreaM2',
  'construction area': 'constructionAreaM2',
  'mat tien': 'frontageM',
  'frontage': 'frontageM',
  'chieu sau': 'depthM',
  'depth': 'depthM',
  // Đặc tính
  'huong': 'directionCode',
  'direction': 'directionCode',
  'huong ban cong': 'balconyDirectionCode',
  'balcony direction': 'balconyDirectionCode',
  'view': 'viewCode',
  'tam nhin': 'viewCode',
  // Pháp lý / bàn giao
  'phap ly': 'legalCode',
  'legal': 'legalCode',
  'ghi chu phap ly': 'legalNote',
  'ban giao': 'handoverCode',
  'handover': 'handoverCode',
  'noi that': 'furnitureCode',
  'furniture': 'furnitureCode',
  'nam ban giao': 'handoverYear',
  'handover year': 'handoverYear',
  'co che dac biet': 'specialMechanismCode',
  // Ghi chú
  'ghi chu': 'note',
  'note': 'note',
  'mo ta': 'note',
};

/** Field nào parse từ số nguyên. */
const INT_FIELDS = new Set<ImportField>(['floorNo', 'totalFloors', 'bedrooms', 'bathrooms', 'handoverYear']);
/** Field nào parse từ số thực. */
const FLOAT_FIELDS = new Set<ImportField>(['usableAreaM2', 'timTuongAreaM2', 'landAreaM2', 'constructionAreaM2', 'frontageM', 'depthM']);
/** Field nào parse thành BigInt giá. */
const PRICE_FIELDS = new Set<ImportField>(['priceVnd', 'priceRentVnd']);

// ── Parse CSV ──────────────────────────────────────────────────────────────
/**
 * CSV parser tối giảu: hỗ trợ dấu nháy kép, dấu nháy kép lặp ("" → "),
 * phân cách phẩy, xuống dòng CRLF/LF. Không thêm dependency.
 */
export function parseCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // strip BOM
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (ch === '\r') {
      i += 1;
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Chuẩn hoá 1 cell của Excel → string (xử lý Date, rich text, formula, hyperlink). */
function excelCellToString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (Array.isArray(obj.richText)) {
      return obj.richText.map((t) => String((t as { text?: string }).text ?? '')).join('');
    }
    if (obj.text !== undefined) return String(obj.text);
    if (obj.result !== undefined) return excelCellToString(obj.result);
    if (obj.hyperlink !== undefined) return String(obj.hyperlink);
  }
  return String(value);
}

/**
 * Parse file import (CSV hoặc XLSX) thành { headers, rows }.
 * Dòng header = dòng đầu tiên. Dòng trống hoàn toàn bị skip.
 */
export async function parseImportFile(buffer: Buffer, filename?: string): Promise<ParsedImportFile> {
  const lower = String(filename ?? '').toLowerCase();
  const isXlsx = lower.endsWith('.xlsx') || lower.endsWith('.xlsm');
  const isCsv = lower.endsWith('.csv') || lower.endsWith('.txt');

  if (!isXlsx && !isCsv) {
    throw new CrmError(400, 'Định dạng file không hỗ trợ (chỉ .csv hoặc .xlsx)');
  }
  if (!buffer || buffer.length === 0) {
    throw new CrmError(400, 'File rỗng');
  }

  let matrix: string[][];
  if (isXlsx) {
    const workbook = new ExcelJS.Workbook();
    try {
      // ExcelJS khai báo Buffer theo @types/node cũ riêng → cast qua kiểu tham số
      // thật của hàm load thay vì ép trực tiếp (tránh copy buffer 20MB).
      type XlsxLoadArg = Parameters<ExcelJS.Workbook['xlsx']['load']>[0];
      await workbook.xlsx.load(buffer as unknown as XlsxLoadArg);
    } catch {
      throw new CrmError(400, 'Không đọc được file XLSX (file hỏng hoặc sai định dạng)');
    }
    const sheet = workbook.worksheets[0];
    if (!sheet) throw new CrmError(400, 'File XLSX không có sheet nào');
    matrix = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const values = row.values as unknown[];
      const cells: string[] = [];
      // row.values là mảng 1-based (index 0 rỗng)
      for (let c = 1; c < values.length; c++) cells.push(excelCellToString(values[c]));
      matrix.push(cells);
    });
  } else {
    matrix = parseCsv(buffer.toString('utf8'));
  }

  if (matrix.length === 0) throw new CrmError(400, 'File không có dữ liệu');

  const headers = matrix[0].map((h) => String(h ?? '').trim());
  const dataRows = matrix.slice(1);
  const rows: string[][] = [];
  let skippedBlankRows = 0;
  for (const r of dataRows) {
    const cleaned = r.map((c) => String(c ?? '').trim());
    if (cleaned.every((c) => c === '')) {
      skippedBlankRows += 1;
      continue;
    }
    rows.push(cleaned);
  }
  return { headers, rows, skippedBlankRows };
}

// ── Mapping dòng ───────────────────────────────────────────────────────────
/** Parse số nguyên từ text, trả null nếu rỗng/không hợp lệ. */
function parseIntOrNull(text: string): number | null {
  if (!text.trim()) return null;
  const cleaned = text.replace(/[^\d-]/g, '');
  if (!cleaned || cleaned === '-') return null;
  const n = parseInt(cleaned, 10);
  return Number.isFinite(n) ? n : null;
}

/** Parse số thực từ text (chấp nhận "85,5"), trả null nếu rỗng/không hợp lệ. */
function parseFloatOrNull(text: string): number | null {
  if (!text.trim()) return null;
  const normalized = text.replace(/\s/g, '').replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(normalized)) return null;
  const n = parseFloat(normalized);
  return Number.isFinite(n) ? n : null;
}

/**
 * Map 1 dòng file → ImportedProperty. Trả về { data, errors }.
 * Dòng thiếu mã căn → lỗi. Giá không parse được → lỗi (bỏ dòng, không tự sửa).
 */
export function mapRow(
  headers: string[],
  cells: string[],
  rowNumber: number,
): { data: ImportedProperty; errors: string[] } {
  const errors: string[] = [];
  const data: ImportedProperty = { unitCode: '' };

  const fieldByIndex = new Map<number, ImportField>();
  headers.forEach((h, idx) => {
    const field = HEADER_ALIASES[normalizeHeader(h)];
    if (field && !fieldByIndex.has(idx)) fieldByIndex.set(idx, field);
  });

  for (const [idx, field] of fieldByIndex) {
    const raw = String(cells[idx] ?? '').trim();
    if (!raw) continue;
    if (field === 'unitCode') {
      data.unitCode = normalizeUnitCode(raw);
      continue;
    }
    if (PRICE_FIELDS.has(field)) {
      const parsed = parsePriceText(raw);
      if (parsed === null) {
        errors.push(`row ${rowNumber}: ${field} không parse được ("${raw}")`);
        continue;
      }
      (data as unknown as Record<string, unknown>)[field] = parsed;
      continue;
    }
    if (INT_FIELDS.has(field)) {
      const parsed = parseIntOrNull(raw);
      if (parsed === null) {
        errors.push(`row ${rowNumber}: ${field} không phải số ("${raw}")`);
        continue;
      }
      (data as unknown as Record<string, unknown>)[field] = parsed;
      continue;
    }
    if (FLOAT_FIELDS.has(field)) {
      const parsed = parseFloatOrNull(raw);
      if (parsed === null) {
        errors.push(`row ${rowNumber}: ${field} không phải số ("${raw}")`);
        continue;
      }
      (data as unknown as Record<string, unknown>)[field] = parsed;
      continue;
    }
    (data as unknown as Record<string, unknown>)[field] = raw;
  }

  if (!data.unitCode) errors.push(`row ${rowNumber}: thiếu mã căn (unitCode)`);

  return { data, errors };
}

// ── Resolve project / agency ───────────────────────────────────────────────
async function resolveProjects(orgId: string, names: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const unique = [...new Set(names.filter((n) => n.trim()))];
  if (unique.length === 0) return map;
  // Dùng OR + equals(mode insensitive) thay vì `in` — Prisma không hỗ trợ
  // `mode` trên filter `in`.
  const rows = await prisma.project.findMany({
    where: {
      orgId,
      OR: unique.map((n) => ({ name: { equals: n, mode: 'insensitive' as const } })),
    },
    select: { id: true, name: true },
  });
  for (const row of rows) map.set(row.name.toLowerCase(), row.id);
  return map;
}

async function resolveAgencies(orgId: string, codes: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const unique = [...new Set(codes.filter((c) => c.trim()).map((c) => c.trim().toUpperCase()))];
  if (unique.length === 0) return map;
  const rows = await prisma.agency.findMany({
    where: {
      orgId,
      OR: unique.map((c) => ({ code: { equals: c, mode: 'insensitive' as const } })),
    },
    select: { id: true, code: true },
  });
  for (const row of rows) map.set(row.code.toUpperCase(), row.id);
  return map;
}

export interface ImportContext {
  orgId: string;
  /** projectId cố định (nếu user chọn trước khi upload) — ghi đè cột "Dự án". */
  projectId?: string | null;
  /** agencyId cố định (nếu user chọn trước khi upload) — ghi đè cột "Mã đại lý". */
  agencyId?: string | null;
}

// ── Preview (dry-run) ──────────────────────────────────────────────────────
/**
 * Dry-run: KHÔNG ghi DB. Trả preview từng dòng + số lượng sẽ tạo/cập nhật.
 */
export async function previewImport(
  ctx: ImportContext,
  parsed: ParsedImportFile,
): Promise<ImportPreview> {
  const { orgId } = ctx;
  const mapped = parsed.rows.map((cells, idx) => mapRow(parsed.headers, cells, idx + 2));

  // Gom tên dự án / mã đại lý cần resolve.
  const projectNames = ctx.projectId
    ? []
    : mapped.map((m) => m.data.projectName ?? '').filter(Boolean);
  const agencyCodes = ctx.agencyId
    ? []
    : mapped.map((m) => m.data.agencyCode ?? '').filter(Boolean);

  const [projectIds, agencyIds] = await Promise.all([
    resolveProjects(orgId, projectNames),
    resolveAgencies(orgId, agencyCodes),
  ]);

  const projects = await prisma.project.findMany({
    where: { orgId },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });
  const agencies = await prisma.agency.findMany({
    where: { orgId },
    select: { id: true, code: true, name: true },
    orderBy: { code: 'asc' },
  });

  const rows: ImportRowResult[] = [];
  let willCreate = 0;
  let willUpdate = 0;
  let invalidRows = 0;

  // Cache property theo (projectId, unitCode) để không query lặp.
  const existingCache = new Map<string, boolean>();
  const allProjectIds = [
    ...(ctx.projectId ? [ctx.projectId] : []),
    ...mapped
      .map((m) => (m.data.projectName ? projectIds.get(m.data.projectName.toLowerCase()) : undefined))
      .filter((v): v is string => Boolean(v)),
  ];
  const allUnitCodes = mapped.map((m) => m.data.unitCode).filter(Boolean);
  if (allProjectIds.length > 0 && allUnitCodes.length > 0) {
    const existing = await prisma.property.findMany({
      where: { orgId, projectId: { in: allProjectIds }, unitCode: { in: allUnitCodes } },
      select: { id: true, projectId: true, unitCode: true },
    });
    for (const e of existing) existingCache.set(`${e.projectId}::${e.unitCode}`, true);
  }

  for (const [idx, m] of mapped.entries()) {
    const rowNumber = idx + 2; // +1 vì header, +1 vì index 0-based
    const errors = [...m.errors];
    const warnings: string[] = [];

    let projectId = ctx.projectId ?? null;
    if (!projectId) {
      const name = m.data.projectName?.trim();
      if (!name) {
        errors.push(`row ${rowNumber}: thiếu dự án (project)`);
      } else {
        const found = projectIds.get(name.toLowerCase());
        if (!found) {
          errors.push(`row ${rowNumber}: dự án "${name}" không tồn tại`);
        } else {
          projectId = found;
        }
      }
    }

    let agencyId = ctx.agencyId ?? null;
    if (!agencyId && m.data.agencyCode?.trim()) {
      const found = agencyIds.get(m.data.agencyCode.trim().toUpperCase());
      if (!found) {
        warnings.push(`row ${rowNumber}: đại lý "${m.data.agencyCode}" chưa có trong hệ thống — căn sẽ không gắn đại lý`);
      } else {
        agencyId = found;
      }
    }

    if (errors.length > 0) {
      invalidRows += 1;
      rows.push({
        rowNumber,
        unitCode: m.data.unitCode || null,
        action: 'error',
        errors,
        warnings,
        priceVnd: m.data.priceVnd !== undefined && m.data.priceVnd !== null ? m.data.priceVnd.toString() : null,
        priceRentVnd: m.data.priceRentVnd !== undefined && m.data.priceRentVnd !== null ? m.data.priceRentVnd.toString() : null,
      });
      continue;
    }

    const exists = projectId ? existingCache.get(`${projectId}::${m.data.unitCode}`) === true : false;
    if (exists) willUpdate += 1;
    else willCreate += 1;

    rows.push({
      rowNumber,
      unitCode: m.data.unitCode,
      action: exists ? 'update' : 'create',
      errors: [],
      warnings,
      priceVnd: m.data.priceVnd !== undefined && m.data.priceVnd !== null ? m.data.priceVnd.toString() : null,
      priceRentVnd: m.data.priceRentVnd !== undefined && m.data.priceRentVnd !== null ? m.data.priceRentVnd.toString() : null,
    });
  }

  return {
    totalRows: parsed.rows.length,
    validRows: parsed.rows.length - invalidRows,
    invalidRows,
    willCreate,
    willUpdate,
    projects,
    agencies,
    rows,
  };
}

// ── Import thật ────────────────────────────────────────────────────────────
/**
 * Ghi bảng hàng vào DB. Upsert theo unique(orgId, projectId, unitCode):
 *   - đã có  → UPDATE các field có trong file
 *   - chưa có → CREATE
 * Dòng lỗi bị skip (không rollback toàn bộ) và gom vào summary.errors.
 */
export async function runImport(
  ctx: ImportContext,
  parsed: ParsedImportFile,
): Promise<ImportSummary> {
  const { orgId } = ctx;
  const mapped = parsed.rows.map((cells, idx) => mapRow(parsed.headers, cells, idx + 2));

  const projectNames = ctx.projectId
    ? []
    : mapped.map((m) => m.data.projectName ?? '').filter(Boolean);
  const agencyCodes = ctx.agencyId
    ? []
    : mapped.map((m) => m.data.agencyCode ?? '').filter(Boolean);
  const [projectIds, agencyIds] = await Promise.all([
    resolveProjects(orgId, projectNames),
    resolveAgencies(orgId, agencyCodes),
  ]);

  const summary: ImportSummary = {
    totalRows: parsed.rows.length,
    created: 0,
    updated: 0,
    skipped: 0,
    errorRows: 0,
    errors: [],
  };

  await tenantTransaction(async (tx) => {
    for (const [idx, m] of mapped.entries()) {
      const rowNumber = idx + 2;
      const errors = [...m.errors];

      let projectId = ctx.projectId ?? null;
      if (!projectId) {
        const name = m.data.projectName?.trim();
        if (!name) errors.push(`row ${rowNumber}: thiếu dự án (project)`);
        else {
          const found = projectIds.get(name.toLowerCase());
          if (!found) errors.push(`row ${rowNumber}: dự án "${name}" không tồn tại`);
          else projectId = found;
        }
      }

      let agencyId = ctx.agencyId ?? null;
      if (!agencyId && m.data.agencyCode?.trim()) {
        agencyId = agencyIds.get(m.data.agencyCode.trim().toUpperCase()) ?? null;
      }

      if (errors.length > 0) {
        summary.errorRows += 1;
        summary.skipped += 1;
        summary.errors.push({
          rowNumber,
          unitCode: m.data.unitCode || null,
          message: errors.join('; '),
        });
        continue;
      }

      const d = m.data;
      const existing = await tx.property.findFirst({
        where: { orgId, projectId: projectId!, unitCode: d.unitCode },
        select: { id: true },
      });

      const data = {
        ...(agencyId ? { agencyId } : {}),
        ...(d.zoneName ? { zoneName: d.zoneName } : {}),
        ...(d.blockName ? { blockName: d.blockName } : {}),
        ...(d.propertyTypeCode ? { propertyTypeCode: d.propertyTypeCode } : {}),
        ...(d.category ? { category: d.category } : {}),
        ...(d.transactionType ? { transactionType: d.transactionType } : {}),
        ...(d.statusCode ? { statusCode: d.statusCode } : {}),
        ...(d.statusNote ? { statusNote: d.statusNote } : {}),
        ...(d.floorNo !== null && d.floorNo !== undefined ? { floorNo: d.floorNo } : {}),
        ...(d.totalFloors !== null && d.totalFloors !== undefined ? { totalFloors: d.totalFloors } : {}),
        ...(d.bedrooms !== null && d.bedrooms !== undefined ? { bedrooms: d.bedrooms } : {}),
        ...(d.bathrooms !== null && d.bathrooms !== undefined ? { bathrooms: d.bathrooms } : {}),
        ...(d.priceVnd !== null && d.priceVnd !== undefined ? { priceVnd: d.priceVnd } : {}),
        ...(d.priceRentVnd !== null && d.priceRentVnd !== undefined ? { priceRentVnd: d.priceRentVnd } : {}),
        ...(d.priceBasisCode ? { priceBasisCode: d.priceBasisCode } : {}),
        ...(d.priceNote ? { priceNote: d.priceNote } : {}),
        ...(d.usableAreaM2 !== null && d.usableAreaM2 !== undefined ? { usableAreaM2: d.usableAreaM2 } : {}),
        ...(d.timTuongAreaM2 !== null && d.timTuongAreaM2 !== undefined ? { timTuongAreaM2: d.timTuongAreaM2 } : {}),
        ...(d.landAreaM2 !== null && d.landAreaM2 !== undefined ? { landAreaM2: d.landAreaM2 } : {}),
        ...(d.constructionAreaM2 !== null && d.constructionAreaM2 !== undefined ? { constructionAreaM2: d.constructionAreaM2 } : {}),
        ...(d.frontageM !== null && d.frontageM !== undefined ? { frontageM: d.frontageM } : {}),
        ...(d.depthM !== null && d.depthM !== undefined ? { depthM: d.depthM } : {}),
        ...(d.directionCode ? { directionCode: d.directionCode } : {}),
        ...(d.balconyDirectionCode ? { balconyDirectionCode: d.balconyDirectionCode } : {}),
        ...(d.viewCode ? { viewCode: d.viewCode } : {}),
        ...(d.legalCode ? { legalCode: d.legalCode } : {}),
        ...(d.legalNote ? { legalNote: d.legalNote } : {}),
        ...(d.handoverCode ? { handoverCode: d.handoverCode } : {}),
        ...(d.furnitureCode ? { furnitureCode: d.furnitureCode } : {}),
        ...(d.handoverYear !== null && d.handoverYear !== undefined ? { handoverYear: d.handoverYear } : {}),
        ...(d.specialMechanismCode ? { specialMechanismCode: d.specialMechanismCode } : {}),
        ...(d.note ? { note: d.note } : {}),
      };

      try {
        if (existing) {
          await tx.property.update({ where: { id: existing.id }, data });
          summary.updated += 1;
        } else {
          await tx.property.create({
            data: {
              orgId,
              projectId: projectId!,
              unitCode: d.unitCode,
              statusCode: d.statusCode ?? 'AVAILABLE',
              ...data,
            },
          });
          summary.created += 1;
        }
      } catch (err) {
        summary.errorRows += 1;
        summary.skipped += 1;
        summary.errors.push({
          rowNumber,
          unitCode: d.unitCode,
          message: (err as { message?: string }).message ?? 'Lỗi khi ghi dữ liệu',
        });
      }
    }
  });

  return summary;
}
