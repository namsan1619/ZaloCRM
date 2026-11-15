// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyễn Tiến Lộc
/**
 * contact-import-service.ts — Parse file KH → staging ContactImportRow (chunking + dry-run).
 *
 * Pipeline:
 *   1. Upload route nhận multipart (hoặc JSON base64) → lưu file thô xuống UPLOAD_DIR,
 *      tạo ContactImportJob (status='pending'), kick worker.
 *   2. Worker gọi stageImportRowsFromFile(jobId, filePath, opts) → đọc file THEO DÒNG
 *      (streaming, không nạp cả file vào RAM), map cột (phone/name/payload), normalize
 *      SĐT qua normalizeVnMobile, ghi ContactImportRow theo CHUNK (createMany) →
 *      status 'invalid' cho SĐT lỗi, 'pending' cho SĐT hợp lệ.
 *   3. Worker tiếp tục dedup + create contact (xem contact-import-worker.ts).
 *
 * Dry-run: previewImport() parse + validate + đếm preview KHÔNG ghi DB →
 * { totalRows, validRows, invalidRows, duplicatedRows, existingRows, sampleErrors }.
 *
 * Format hỗ trợ:
 *   - .csv / .txt / .tsv  — stream dòng (readline), delimiter tự detect (tab > ';' > ',').
 *   - .xlsx — stream worksheet qua ExcelJS.stream.xlsx.WorkbookReader (sheet đầu tiên).
 *
 * Vì sao streaming: mục tiêu 1 TRIỆU SĐT — nạp toàn bộ file vào RAM sẽ ngốn
 * Node (mỗi row ~200B × 1M ≈ 200MB+ chưa kể object overhead). Mọi đường đọc file
 * đều qua async iterator + chunk ghi DB.
 *
 * Quy tắc normalize (thống nhất với list-import-service):
 *   - normalizeVnMobile STRICT: chỉ nhận VN mobile 10-digit prefix [35789] →
 *     canonical "84xxx" (không +). SĐT khác (số bàn, nước khác) → invalid.
 *   - Dòng rỗng → bỏ qua (không tăng rowIndex).
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { basename } from 'node:path';
import ExcelJS from 'exceljs';
import { prisma } from '../../shared/database/prisma-client.js';
import { normalizeVnMobile } from '../../shared/utils/phone.js';
import type { Prisma } from '@prisma/client';

export const IMPORT_SOURCE = 'phone_import';
export const STAGING_CHUNK_SIZE = 2000;

export interface ImportColumnMap {
  /** Tên cột HOẶC index (0-based) của cột SĐT. Mặc định: detect header / cột 0. */
  phone?: string | number;
  /** Cột tên KH. Mặc định: detect header / cột 1. */
  name?: ImportColumnMap['phone'];
}

export interface ImportOptions {
  /** Nguồn gắn cho Contact (source). Mặc định 'phone_import'. */
  source?: string;
  /** Map cột thủ công từ FE. */
  columnMap?: ImportColumnMap;
  /** Gán tất cả KH import cho user tạo job (ContactAccess role primary). Mặc định false. */
  assignToCreator?: boolean;
}

export interface ParsedImportRow {
  rowIndex: number; // 1-based, đếm trên các dòng có SĐT (bỏ dòng rỗng)
  phoneRaw: string | null;
  phoneNormalized: string | null;
  nameRaw: string | null;
  payload: Record<string, unknown>;
}

export interface ImportPreview {
  totalRows: number;
  validRows: number;
  invalidRows: number;
  /** Trùng SĐT trong chính file (first wins). */
  duplicatedRows: number;
  /** Trùng với Contact CRM đã có (theo phoneNormalized). */
  existingRows: number;
  sampleErrors: Array<{ rowIndex: number; phoneRaw: string | null; reason: string }>;
}

/** Header aliases VN/EN cho cột SĐT và cột tên. */
const PHONE_HEADER_RE = /^\s*(s?dt|sđt|so\s*dien\s*thoai|số\s*điện\s*thoại|dien\s*thoai|điện\s*thoại|phone|mobile|tel(ephone)?|hotline)\s*$/i;
const NAME_HEADER_RE = /^\s*(ho\s*ten|họ\s*tên|ten\s*kh|tên\s*kh|ten|tên|full\s*name|name|customer\s*name|khach\s*hang|khách\s*hàng)\s*$/i;

interface ColumnLayout {
  phoneIdx: number;
  nameIdx: number | null;
  hasHeader: boolean;
}

function isHeaderRow(cells: string[]): boolean {
  return cells.some((c) => PHONE_HEADER_RE.test(c));
}

/** Detect layout cột từ dòng đầu (header) + columnMap thủ công. */
function detectLayout(first: string[], columnMap?: ImportColumnMap): ColumnLayout {
  const hasHeader = first.length > 0 && isHeaderRow(first);
  let phoneIdx = 0;
  let nameIdx: number | null = 1;

  if (columnMap?.phone !== undefined) {
    phoneIdx =
      typeof columnMap.phone === 'number'
        ? columnMap.phone
        : first.findIndex((c) => c.trim().toLowerCase() === String(columnMap.phone).trim().toLowerCase());
    if (phoneIdx < 0) phoneIdx = 0;
  } else if (hasHeader) {
    phoneIdx = first.findIndex((c) => PHONE_HEADER_RE.test(c));
    if (phoneIdx < 0) phoneIdx = 0;
  }

  if (columnMap?.name !== undefined) {
    if (columnMap.name === null || columnMap.name === '') {
      nameIdx = null;
    } else {
      nameIdx =
        typeof columnMap.name === 'number'
          ? columnMap.name
          : first.findIndex((c) => c.trim().toLowerCase() === String(columnMap.name).trim().toLowerCase());
      if (nameIdx === -1) nameIdx = null;
    }
  } else if (hasHeader) {
    const found = first.findIndex((c) => NAME_HEADER_RE.test(c));
    nameIdx = found >= 0 ? found : null;
  }

  return { phoneIdx, nameIdx, hasHeader };
}

/** Phân tách 1 dòng CSV/TSV (hỗ trợ quote double). */
function splitDelimited(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

/** Detect delimiter từ dòng đầu: ưu tiên tab > dấu chấm phẩy > phẩy. */
function detectDelimiter(firstLine: string): string {
  const counts = [
    ['\t', (firstLine.match(/\t/g) ?? []).length],
    [';', (firstLine.match(/;/g) ?? []).length],
    [',', (firstLine.match(/,/g) ?? []).length],
  ] as const;
  const best = counts.reduce((a, b) => (b[1] > a[1] ? b : a));
  return best[1] > 0 ? best[0] : ',';
}

/** Dòng đang mở quote → nối dòng sau (CSV có newline trong ô). */
function isQuoteOpen(line: string): boolean {
  let open = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') {
      if (open && line[i + 1] === '"') { i++; continue; }
      open = !open;
    }
  }
  return open;
}

/**
 * Stream dòng từ file phẳng (csv/tsv/txt) → mảng cell.
 * Tự detect delimiter từ dòng đầu; nối dòng nếu ô đang mở quote.
 */
export async function* streamDelimitedRows(filePath: string): AsyncGenerator<string[]> {
  const rl = createInterface({
    input: createReadStream(filePath),
    crlfDelay: Infinity,
  });
  let delimiter: string | null = null;
  let pending = '';
  let first = true;

  for await (const rawLine of rl) {
    let line = rawLine;
    if (first) {
      line = line.charCodeAt(0) === 0xfeff ? line.slice(1) : line; // bỏ BOM
      first = false;
    }
    if (!line.trim() && !pending) continue;

    if (pending) {
      pending += '\n' + line;
    } else {
      pending = line;
    }

    if (isQuoteOpen(pending)) continue; // ô đang mở quote → chờ dòng sau

    if (delimiter === null) delimiter = detectDelimiter(pending);
    const cells = splitDelimited(pending, delimiter);
    pending = '';
    if (cells.length === 1 && !cells[0]) continue; // dòng rỗng
    yield cells;
  }

  if (pending.trim()) {
    if (delimiter === null) delimiter = detectDelimiter(pending);
    yield splitDelimited(pending, delimiter);
  }
}

/** Stream dòng từ XLSX (sheet đầu tiên) → mảng cell. */
export async function* streamXlsxRows(filePath: string): AsyncGenerator<string[]> {
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(createReadStream(filePath), {
    worksheets: 'emit',
    sharedStrings: 'cache',
  });
  let sheetSeen = 0;
  for await (const worksheet of reader) {
    if (sheetSeen > 0) break; // chỉ đọc sheet đầu tiên
    sheetSeen++;
    for await (const row of worksheet) {
      const values = row.values as unknown[];
      // values[0] là index cột trong exceljs → lấy từ 1
      yield values.slice(1).map((v) => (v == null ? '' : String(v)));
    }
  }
}

/**
 * Stream dòng theo extension → mảng cell (chưa map cột).
 * Hỗ trợ: .csv/.txt/.tsv/.xlsx. Extension khác → throw Error.
 */
export async function* streamImportRows(filePath: string): AsyncGenerator<string[]> {
  const ext = basename(filePath).split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'xlsx') {
    yield* streamXlsxRows(filePath);
    return;
  }
  yield* streamDelimitedRows(filePath);
}

/** Đọc file theo extension → string[][] (dòng chưa map cột) — cho file vừa/nhỏ. */
export async function readImportRowsFromFile(filePath: string): Promise<string[][]> {
  const out: string[][] = [];
  for await (const row of streamImportRows(filePath)) out.push(row);
  return out;
}

/**
 * Parse 1 dòng → ParsedImportRow. Trả null nếu dòng rỗng (bỏ qua).
 * SĐT normalize STRICT qua normalizeVnMobile; không hợp lệ → phoneNormalized=null,
 * phoneRaw giữ nguyên (để ghi vào errors CSV).
 */
function parseRow(
  cells: string[],
  rowIndex: number,
  layout: ColumnLayout,
  header: string[] | null,
): ParsedImportRow | null {
  if (!cells.length) return null;
  const rawPhone = (cells[layout.phoneIdx] ?? '').trim();
  if (!rawPhone) return null; // dòng rỗng → bỏ, không tăng rowIndex

  const nameRaw = layout.nameIdx !== null ? (cells[layout.nameIdx] ?? '').trim() || null : null;

  // Payload: các cột khác (địa chỉ, ghi chú, field tùy biễn).
  const payload: Record<string, unknown> = {};
  for (let c = 0; c < cells.length; c++) {
    if (c === layout.phoneIdx || (layout.nameIdx !== null && c === layout.nameIdx)) continue;
    const val = (cells[c] ?? '').trim();
    if (!val) continue;
    payload[header?.[c]?.trim() || `col${c}`] = val;
  }

  return {
    rowIndex,
    phoneRaw: rawPhone,
    phoneNormalized: normalizeVnMobile(rawPhone),
    nameRaw,
    payload,
  };
}

/**
 * Parse mảng rows → ParsedImportRow[] (thuần, dùng cho test + file nhỏ).
 */
export function parseContactRows(
  rows: string[][],
  opts?: ImportColumnMap,
): ParsedImportRow[] {
  const layout = detectLayout(rows[0] ?? [], opts);
  const header = layout.hasHeader ? rows[0] ?? null : null;
  const out: ParsedImportRow[] = [];

  for (let i = layout.hasHeader ? 1 : 0; i < rows.length; i++) {
    const parsed = parseRow(rows[i], out.length + 1, layout, header);
    if (parsed) out.push(parsed);
  }
  return out;
}

/**
 * Stream parse file → ParsedImportRow (async iterator).
 * Không nạp toàn bộ file vào RAM — dùng cho import 1 triệu SĐT.
 */
export async function* streamParsedContactRows(
  filePath: string,
  opts?: ImportColumnMap,
): AsyncGenerator<ParsedImportRow> {
  let layout: ColumnLayout | null = null;
  let header: string[] | null = null;
  let emitted = 0;

  for await (const cells of streamImportRows(filePath)) {
    if (!layout) {
      layout = detectLayout(cells, opts);
      header = layout.hasHeader ? cells : null;
      if (layout.hasHeader) continue; // bỏ dòng header
    }
    const parsed = parseRow(cells, emitted + 1, layout, header);
    if (!parsed) continue;
    emitted++;
    yield parsed;
  }
}

/** Row tối thiểu cho dedup (worker + test dùng chung). */
export interface DedupableRow {
  id: string;
  phoneNormalized: string | null;
}

export interface DedupResult {
  /** Row trùng SĐT trong chính batch (first-wins) — chỉ giữ id. */
  duplicatesInFile: string[];
  /** Row trùng Contact CRM hiện có — kèm contactId đích. */
  duplicatesWithCrm: Array<{ id: string; contactId: string }>;
  /** Row mới (không trùng) — cần tạo Contact. */
  newRows: DedupableRow[];
}

/**
 * Dedup thuần (pure) — worker import + unit test dùng chung.
 * 1. Trùng trong file (cùng batch): first-wins.
 * 2. Trùng với Contact CRM hiện có theo phoneNormalized.
 */
export function dedupImportRows(
  rows: DedupableRow[],
  existingByPhone: Map<string, string>,
): DedupResult {
  const seen = new Set<string>();
  const duplicatesInFile: string[] = [];
  const candidates: DedupableRow[] = [];

  for (const row of rows) {
    const p = row.phoneNormalized;
    if (!p) continue; // invalid — xử lý ở tầng khác
    if (seen.has(p)) {
      duplicatesInFile.push(row.id);
    } else {
      seen.add(p);
      candidates.push(row);
    }
  }

  const duplicatesWithCrm: Array<{ id: string; contactId: string }> = [];
  const newRows: DedupableRow[] = [];
  for (const row of candidates) {
    const contactId = row.phoneNormalized ? existingByPhone.get(row.phoneNormalized) : undefined;
    if (contactId) {
      duplicatesWithCrm.push({ id: row.id, contactId });
    } else {
      newRows.push(row);
    }
  }

  return { duplicatesInFile, duplicatesWithCrm, newRows };
}

/**
 * Tạo ContactImportRow theo lô (createMany chunk) cho 1 job.
 * Idempotent theo (jobId): nếu job đã có row → bỏ qua ghi, chỉ đếm lại counters.
 */
export async function stageImportRows(
  jobId: string,
  rows: ParsedImportRow[],
): Promise<{ totalRows: number; invalidRows: number }> {
  const existing = await prisma.contactImportRow.count({ where: { jobId } });
  if (existing > 0) {
    // Đã stage (vd crash giữa chừng) → đếm lại từ DB, không ghi lần 2
    const invalidRows = await prisma.contactImportRow.count({
      where: { jobId, status: 'invalid' },
    });
    return { totalRows: existing, invalidRows };
  }

  let totalRows = 0;
  let invalidRows = 0;
  for (let i = 0; i < rows.length; i += STAGING_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + STAGING_CHUNK_SIZE);
    const data = chunk
      .filter((r) => r.phoneRaw) // không bao giờ rỗng (parse đã lọc) — defensive
      .map((r) => ({
        jobId,
        rowIndex: r.rowIndex,
        phoneRaw: r.phoneRaw ?? null,
        phoneNormalized: r.phoneNormalized,
        nameRaw: r.nameRaw,
        payload: (r.payload ?? {}) as Prisma.InputJsonValue,
        status: r.phoneNormalized ? 'pending' : 'invalid',
        errorReason: r.phoneNormalized ? null : 'invalid_phone',
      })) as Prisma.ContactImportRowCreateManyInput[];
    await prisma.contactImportRow.createMany({ data });
    totalRows += data.length;
    invalidRows += data.filter((d) => d.status === 'invalid').length;
  }
  return { totalRows, invalidRows };
}

/**
 * Stage trực tiếp từ file (streaming) — đường chính cho import 1 triệu SĐT.
 * Ghi ContactImportRow theo chunk, không giữ toàn bộ file trong RAM.
 */
export async function stageImportRowsFromFile(
  jobId: string,
  filePath: string,
  opts?: ImportColumnMap,
): Promise<{ totalRows: number; invalidRows: number }> {
  const existing = await prisma.contactImportRow.count({ where: { jobId } });
  if (existing > 0) {
    const invalidRows = await prisma.contactImportRow.count({
      where: { jobId, status: 'invalid' },
    });
    return { totalRows: existing, invalidRows };
  }

  let totalRows = 0;
  let invalidRows = 0;
  let buffer: ParsedImportRow[] = [];

  const flush = async (): Promise<void> => {
    if (buffer.length === 0) return;
    const data = buffer.map((r) => ({
      jobId,
      rowIndex: r.rowIndex,
      phoneRaw: r.phoneRaw ?? null,
      phoneNormalized: r.phoneNormalized,
      nameRaw: r.nameRaw,
      payload: (r.payload ?? {}) as Prisma.InputJsonValue,
      status: r.phoneNormalized ? 'pending' : 'invalid',
      errorReason: r.phoneNormalized ? null : 'invalid_phone',
    })) as Prisma.ContactImportRowCreateManyInput[];
    await prisma.contactImportRow.createMany({ data });
    totalRows += data.length;
    invalidRows += data.filter((d) => d.status === 'invalid').length;
    buffer = [];
  };

  for await (const row of streamParsedContactRows(filePath, opts)) {
    buffer.push(row);
    if (buffer.length >= STAGING_CHUNK_SIZE) await flush();
  }
  await flush();

  return { totalRows, invalidRows };
}

/**
 * Dry-run: parse file + validate + đếm preview KHÔNG ghi DB.
 * Dùng khi upload với flag dryRun=true (FE xem preview trước khi import thật).
 * Đếm trùng với Contact CRM theo orgId (chunked IN để tránh query quá dài).
 */
export async function previewImport(
  filePath: string,
  orgId: string,
  opts?: ImportOptions,
): Promise<ImportPreview> {
  let totalRows = 0;
  let invalidRows = 0;
  let duplicatedRows = 0;
  const seen = new Set<string>();
  const sampleErrors: ImportPreview['sampleErrors'] = [];

  for await (const r of streamParsedContactRows(filePath, opts?.columnMap)) {
    totalRows++;
    if (!r.phoneNormalized) {
      invalidRows++;
      if (sampleErrors.length < 20) {
        sampleErrors.push({ rowIndex: r.rowIndex, phoneRaw: r.phoneRaw, reason: 'invalid_phone' });
      }
      continue;
    }
    if (seen.has(r.phoneNormalized)) {
      duplicatedRows++;
    } else {
      seen.add(r.phoneNormalized);
    }
  }

  // Trùng với Contact CRM hiện có — trên tập phone duy nhất
  const uniquePhones = Array.from(seen);
  let existingRows = 0;
  const chunkSize = 500;
  for (let i = 0; i < uniquePhones.length; i += chunkSize) {
    const chunkPhones = uniquePhones.slice(i, i + chunkSize);
    const found = await prisma.contact.findMany({
      where: { orgId, phoneNormalized: { in: chunkPhones } },
      select: { id: true },
    });
    existingRows += found.length;
  }

  return {
    totalRows,
    validRows: uniquePhones.length,
    invalidRows,
    duplicatedRows,
    existingRows,
    sampleErrors,
  };
}

/**
 * Tạo CSV lỗi (errors file) từ danh sách row lỗi — trả về string CSV.
 * Route GET /import/:jobId/errors dùng hàm này (không phụ thuộc disk).
 */
export function buildErrorCsv(
  rows: Array<{
    rowIndex: number;
    phoneRaw: string | null;
    nameRaw: string | null;
    status: string;
    errorReason: string | null;
  }>,
): string {
  const header = 'row_index,phone_raw,name,status,error_reason';
  const escape = (v: string | number | null | undefined): string => {
    const s = v == null ? '' : String(v);
    if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  };
  const body = rows.map((r) =>
    [r.rowIndex, r.phoneRaw, r.nameRaw, r.status, r.errorReason].map(escape).join(','),
  );
  return [header, ...body].join('\n');
}
