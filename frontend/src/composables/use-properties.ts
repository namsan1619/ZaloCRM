// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyễn Tiến Lộc
/**
 * Composable cho Bảng hàng (Property / P3).
 *  - List: fetchProperties với filter (projectId, statusCode, propertyTypeCode,
 *    priceMin/priceMax, q) + phân trang + stats band tính từ dữ liệu đã tải.
 *  - Detail: fetchPropertyById, create/update/delete.
 *  - Compare: fetchCompare (GET /properties/compare?ids=a,b).
 *  - Import: importDryRun (multipart) + importCommit.
 *  - Helper dùng chung: fetchMasterItems (MasterData P1) + formatVnd / formatArea.
 *
 * LƯU Ý: Contract API chưa chốt shape response → đọc phòng thủ: ưu tiên
 * res.data.properties ?? res.data.items ?? res.data.list ?? array trần.
 * BigInt từ Prisma có thể tới dưới dạng string — mọi hàm format đều xử lý cả 2.
 */
import { ref, computed } from 'vue';
import { api } from '@/api/index';
import { useMasterData } from '@/composables/use-master-data';

// ─────────────────────────── Types ───────────────────────────
export interface PropertyItem {
  id: string;
  projectId: string;
  agencyId: string | null;
  unitCode: string;
  zoneName: string | null;
  blockName: string | null;
  propertyTypeCode: string | null;
  category: string | null; // HIGH_RISE | LOW_RISE | LAND
  transactionType: string | null; // SALE | RENT
  statusCode: string;
  statusNote: string | null;
  floorNo: number | null;
  totalFloors: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
  // BigInt fields — string | number để chống mất precision khi > 2^53
  priceVnd: string | number | null;
  priceRentVnd: string | number | null;
  priceBasisCode: string | null;
  priceNote: string | null;
  priceTtsVnd: string | number | null;
  priceHtlsVnd: string | number | null;
  unitPriceTtsVnd: string | number | null;
  specialMechanismCode: string | null;
  usableAreaM2: number | null;
  timTuongAreaM2: number | null;
  landAreaM2: number | null;
  constructionAreaM2: number | null;
  frontageM: number | null;
  depthM: number | null;
  roadWidthM: number | null;
  balconyDirectionCode: string | null;
  viewCode: string | null;
  directionCode: string | null;
  landDirectionCode: string | null;
  legalCode: string | null;
  legalNote: string | null;
  handoverCode: string | null;
  furnitureCode: string | null;
  handoverYear: number | null;
  assignedUserId: string | null;
  note: string | null;
  infoCheckedAt: string | null;
  attributes: Record<string, unknown>;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  // Relations (BE include theo ý — optional)
  project?: { id: string; name: string } | null;
  agency?: { id: string; code: string; name: string } | null;
  media?: PropertyMediaItem[];
}

export interface PropertyMediaItem {
  id: string;
  kind: string; // IMAGE | VIDEO | DOCUMENT | FLOORPLAN
  url: string;
  sortOrder: number;
}

export interface PropertyFilters {
  projectId: string;
  statusCode: string;
  propertyTypeCode: string;
  priceMin: string;
  priceMax: string;
  q: string;
  page: number;
  limit: number;
}

export interface PropertyStats {
  total: number;      // tổng theo bộ lọc (server)
  loaded: number;     // số bản ghi đang tải (page hiện tại)
  available: number;  // đang bán
  deposit: number;    // đã cọc
  avgPriceVnd: number | null; // giá TB
}

export interface CompareRow {
  key: string;
  label: string;
  values: (string | number | null)[];
}

export interface DryRunResult {
  total: number;
  valid: number;
  invalid: number;
  duplicate: number;
  tempKey?: string; // BE trả nếu có, để commit đúng batch
  rows?: unknown[];
  sample?: unknown[];
}

// ─────────────────────── Helpers dùng chung ─────────────────────────
export type PriceLike = string | number | bigint | null | undefined;

/** Bóc số nguyên từ chuỗi/số — an toàn với BigInt dạng string. */
export function toNumString(v: PriceLike): string {
  if (v === null || v === undefined) return '';
  const s = String(v).replace(/[^\d]/g, ''); // bỏ dấu phân cách / ký tự
  return s;
}

/** Định dạng tiền VND có dấu phân cách nghìn (dấu chấm, kiểu vi-VN). */
export function formatVnd(v: PriceLike, suffix = '₫'): string {
  const digits = toNumString(v);
  if (!digits) return '—';
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${grouped} ${suffix}`.trim();
}

/** Format tiền rút gọn: ≥ 1 tỷ → "1,5 tỷ", ≥ 1 triệu → "500 tr". */
export function formatVndCompact(v: PriceLike): string {
  const digits = toNumString(v);
  if (!digits) return '—';
  const n = Number(digits);
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toLocaleString('vi-VN', { maximumFractionDigits: 1 })} tỷ`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toLocaleString('vi-VN', { maximumFractionDigits: 0 })} tr`;
  if (n >= 1_000) return `${(n / 1_000).toLocaleString('vi-VN', { maximumFractionDigits: 0 })} k`;
  return digits;
}

/** Định dạng diện tích (m²) với 1 chữ số thập phân. */
export function formatArea(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return `${n.toLocaleString('vi-VN', { maximumFractionDigits: 1 })} m²`;
}

/** Chuyển số an toàn từ BigInt-string/string/number. */
export function toSafeNumber(v: PriceLike): number | null {
  const digits = toNumString(v);
  if (!digits) return null;
  const n = Number(digits);
  return Number.isFinite(n) ? n : null;
}

/** Đọc danh sách từ response có nhiều shape khả dĩ. */
export function pickList<T>(data: unknown, keys: string[]): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === 'object') {
    const rec = data as Record<string, unknown>;
    for (const k of keys) {
      if (Array.isArray(rec[k])) return rec[k] as T[];
    }
  }
  return [];
}

/** Lấy tổng số bản ghi từ response (total/count/…) nếu có. */
export function pickTotal(data: unknown): number {
  if (data && typeof data === 'object') {
    const rec = data as Record<string, unknown>;
    const v = rec.total ?? rec.count ?? rec.totalCount;
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

// ─────────────────── MasterData helper (P1, dùng chung) ──────────────
export interface MasterOption {
  id: string;
  categoryKey?: string;
  categoryId?: string;
  code: string;
  label: string;
  color: string | null;
  sortOrder: number;
  isActive: boolean;
}

/**
 * Lấy danh sách item của 1 category MasterData (P1).
 * DELEGATE sang composable chính use-master-data.ts (FE-A) — tránh 2 luồng
 * gọi cùng API, đúng contract `GET /api/v1/settings/master-data/items`.
 * Chỉ map sang MasterOption (subset) cho phần Bảng hàng / Chiến dịch.
 */
export async function fetchMasterItems(categoryKey: string, q = ''): Promise<MasterOption[]> {
  const { fetchItems } = useMasterData();
  const items = await fetchItems(categoryKey, q);
  return items.map((i) => ({
    id: i.id,
    categoryKey: i.categoryKey,
    categoryId: i.categoryId,
    code: i.code,
    label: i.label,
    color: i.color ?? null,
    sortOrder: i.sortOrder,
    isActive: i.isActive,
  }));
}

// ─────────────────────── Composable ─────────────────────────
export function useProperties() {
  const properties = ref<PropertyItem[]>([]);
  const total = ref(0);
  const loading = ref(false);

  const filters = ref<PropertyFilters>({
    projectId: '',
    statusCode: '',
    propertyTypeCode: '',
    priceMin: '',
    priceMax: '',
    q: '',
    page: 1,
    limit: 50,
  });

  // Stats band — tổng lấy từ server (đúng theo bộ lọc), các số đếm khác
  // tính trên dữ liệu ĐÃ TẢI (thật, không phải fake).
  const stats = computed<PropertyStats>(() => {
    const rows = properties.value;
    const available = rows.filter((r) => r.statusCode === 'AVAILABLE').length;
    const deposit = rows.filter((r) =>
      /deposit|coc|book|reserved|giữ chỗ/i.test(r.statusCode || ''),
    ).length;
    let sum = 0;
    let count = 0;
    for (const r of rows) {
      const p = toSafeNumber(r.priceVnd);
      if (p !== null && p > 0) { sum += p; count++; }
    }
    return {
      total: total.value,
      loaded: rows.length,
      available,
      deposit,
      avgPriceVnd: count > 0 ? Math.round(sum / count) : null,
    };
  });

  // ───────── List / filter ─────────
  async function fetchProperties() {
    loading.value = true;
    try {
      const res = await api.get('/properties', {
        params: {
          projectId: filters.value.projectId || undefined,
          statusCode: filters.value.statusCode || undefined,
          propertyTypeCode: filters.value.propertyTypeCode || undefined,
          priceMin: filters.value.priceMin || undefined,
          priceMax: filters.value.priceMax || undefined,
          q: filters.value.q || undefined,
          page: filters.value.page,
          limit: filters.value.limit,
        },
      });
      const data = res.data;
      properties.value = pickList<PropertyItem>(data, ['properties', 'items', 'list']);
      total.value = pickTotal(data);
    } catch (err) {
      console.error('[properties] fetchProperties failed:', err);
      properties.value = [];
      total.value = 0;
    } finally {
      loading.value = false;
    }
  }

  function applyFilter(patch: Partial<PropertyFilters>) {
    filters.value = { ...filters.value, ...patch, page: 1 };
    return fetchProperties();
  }

  function goPage(page: number) {
    if (page < 1) return;
    filters.value.page = page;
    return fetchProperties();
  }

  // ───────── Detail / CRUD ─────────
  async function fetchPropertyById(id: string): Promise<PropertyItem | null> {
    try {
      const res = await api.get(`/properties/${id}`);
      return res.data?.property ?? res.data ?? null;
    } catch (err) {
      console.error('[properties] fetchPropertyById failed:', err);
      return null;
    }
  }

  async function createProperty(payload: Record<string, unknown>): Promise<PropertyItem | null> {
    try {
      const res = await api.post('/properties', payload);
      return res.data?.property ?? res.data ?? null;
    } catch (err) {
      console.error('[properties] createProperty failed:', err);
      throw err;
    }
  }

  async function updateProperty(id: string, payload: Record<string, unknown>): Promise<PropertyItem | null> {
    try {
      const res = await api.put(`/properties/${id}`, payload);
      return res.data?.property ?? res.data ?? null;
    } catch (err) {
      console.error('[properties] updateProperty failed:', err);
      throw err;
    }
  }

  async function deleteProperty(id: string): Promise<void> {
    await api.delete(`/properties/${id}`);
  }

  // ───────── Compare ─────────
  async function fetchCompare(ids: string[]): Promise<PropertyItem[]> {
    if (!ids.length) return [];
    try {
      const res = await api.get('/properties/compare', { params: { ids: ids.join(',') } });
      return pickList<PropertyItem>(res.data, ['properties', 'items', 'list', 'rows']);
    } catch (err) {
      console.error('[properties] fetchCompare failed:', err);
      return [];
    }
  }

  // ───────── Import ─────────
  /** Dry-run: upload file Excel/CSV, BE trả preview + tempKey nếu có. */
  async function importDryRun(file: File): Promise<DryRunResult | null> {
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await api.post('/properties/import/dry-run', fd);
      const data = res.data ?? {};
      return {
        total: Number(data.total ?? data.rowCount ?? data.rows?.length ?? 0),
        valid: Number(data.valid ?? 0),
        invalid: Number(data.invalid ?? data.errorRows ?? 0),
        duplicate: Number(data.duplicate ?? data.duplicates ?? 0),
        tempKey: data.tempKey ?? data.previewId ?? data.key ?? undefined,
        rows: data.rows ?? data.preview ?? undefined,
        sample: data.sample ?? undefined,
      };
    } catch (err) {
      console.error('[properties] importDryRun failed:', err);
      throw err;
    }
  }

  /** Commit import. Nếu dry-run có tempKey → gửi JSON; ngược lại gửi lại file multipart. */
  async function importCommit(opts: { file?: File; tempKey?: string }): Promise<unknown> {
    try {
      if (opts.tempKey) {
        const res = await api.post('/properties/import', { tempKey: opts.tempKey });
        return res.data;
      }
      if (!opts.file) throw new Error('missing file');
      const fd = new FormData();
      fd.append('file', opts.file);
      const res = await api.post('/properties/import', fd);
      return res.data;
    } catch (err) {
      console.error('[properties] importCommit failed:', err);
      throw err;
    }
  }

  return {
    properties,
    total,
    loading,
    filters,
    stats,
    fetchProperties,
    applyFilter,
    goPage,
    fetchPropertyById,
    createProperty,
    updateProperty,
    deleteProperty,
    fetchCompare,
    importDryRun,
    importCommit,
  };
}