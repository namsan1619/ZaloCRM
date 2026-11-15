// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyễn Tiến Lộc
/**
 * property-service.ts — Service layer cho module Nguồn hàng (Căn / Property).
 *
 * Vận hành trên model Property (schema đã có):
 *   unique(orgId, projectId, unitCode) — mã căn duy nhất trong 1 dự án của org.
 *
 * LƯU Ý GIÁ (BigInt): priceVnd & các cột giá là BigInt trong Prisma. JSON.stringify
 * ném TypeError với BigInt — app.ts đã patch global BigInt.prototype.toJSON → string,
 * NHƯNG service này CHỦ ĐỘNG serialize giá sang string ở `serializeProperty()` để:
 *   - không phụ thuộc patch global (test tự build Fastify không có patch)
 *   - response contract ổn định: priceVnd luôn là string ("1200000000")
 *   - compare diff so sánh bằng BigInt nhưng trả value string.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../../shared/database/prisma-client.js';

/** Lỗi nghiệp vụ kèm statusCode — routes catch và map sang reply. */
export class CrmError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'CrmError';
  }
}

// ── Các trường giá BigInt cần serialize sang string ────────────────────────
const BIG_INT_PRICE_FIELDS = [
  'priceVnd',
  'priceRentVnd',
  'priceTtsVnd',
  'priceHtlsVnd',
  'unitPriceTtsVnd',
] as const;

/**
 * Serialize property (raw Prisma row) → plain object an toàn JSON.
 * BigInt price → string. Date → string (toJSON mặc định đã làm).
 */
export function serializeProperty<T extends Record<string, unknown>>(row: T): T {
  const out: Record<string, unknown> = { ...row };
  for (const f of BIG_INT_PRICE_FIELDS) {
    const v = out[f];
    if (typeof v === 'bigint') out[f] = v.toString();
  }
  return out as T;
}

/**
 * Parse price từ body (KIỂU JSON): cho phép string hoặc number.
 * - number → BigInt(Math.round(n))
 * - string → parsePriceText() (hỗ trợ "1.2 tỷ", "1.200.000.000", "850tr")
 * - null/undefined/' ' → null
 * Trả CrmError 400 nếu string không parse được.
 */
export function parsePriceInput(
  value: unknown,
  field = 'priceVnd',
  required = false,
): bigint | null {
  if (value === null || value === undefined || value === '') {
    if (required) throw new CrmError(400, `${field} required`);
    return null;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new CrmError(400, `${field} không hợp lệ`);
    return BigInt(Math.round(value));
  }
  if (typeof value === 'string') {
    const parsed = parsePriceText(value);
    if (parsed === null) throw new CrmError(400, `${field} không hợp lệ: "${value}"`);
    return parsed;
  }
  throw new CrmError(400, `${field} không hợp lệ`);
}

/**
 * Parse text giá tiền VN thực tế: "1.2 tỷ", "850tr", "1.200.000.000", "2,5 tỷ".
 * Trả BigInt (đơn vị VND) hoặc null nếu không thể parse.
 */
export function parsePriceText(text: string): bigint | null {
  let s = String(text).trim().toLowerCase();
  if (!s) return null;

  // Bỏ ký hiệu tiền tệ.
  s = s.replace(/đ|₫|vnđ|vnd|đồng/g, ' ');

  // Nhân tử đơn vị — unit đứng CUỐI chuỗi (có thể gắn liền số: "850tr", "2.5 tỷ").
  // Thứ tự alternation: unit dài trước để "trieu" không bị bắt thành "tr".
  const unitMatch = s.match(
    /(tỷ|triệu|trieu|billion|thousand|million|nghìn|nghin|ngan|tr|ty|k|m)\s*$/u,
  );
  let multiplier = 1n;
  if (unitMatch) {
    const unit = unitMatch[1];
    const unitBillion = ['tỷ', 'ty', 'billion'];
    const unitMillion = ['triệu', 'trieu', 'tr', 'million', 'm'];
    const unitThousand = ['nghìn', 'nghin', 'ngan', 'thousand', 'k'];
    if (unitBillion.includes(unit)) multiplier = 1_000_000_000n;
    else if (unitMillion.includes(unit)) multiplier = 1_000_000n;
    else if (unitThousand.includes(unit)) multiplier = 1_000n;
    s = s.replace(unitMatch[0], ' ');
  }

  // Strip khoảng trắng / ký tự lạ
  s = s.replace(/\s/g, '');

  // Số thập phân VN: dấu '.' hoặc ',' đều có thể là phân cách thập phân.
  // Quy ước: separator đứng SAI với 3 chữ số → nghìn-phân-cách ("1.000" = 1000);
  // separator đứng sai với 1-2 chữ số → dấu thập phân ("2.5 tỷ" = 2,5 tỷ).
  const hasDot = s.includes('.');
  const hasComma = s.includes(',');
  let decimalStr: string;
  if (hasDot && hasComma) {
    // Lẫn lộn: separator CUỐI là dấu thập phân, separator còn lại là nghìn-phân-cách.
    const lastDot = s.lastIndexOf('.');
    const lastComma = s.lastIndexOf(',');
    if (lastComma > lastDot) decimalStr = s.replace(/\./g, '').replace(/,/g, '.');
    else decimalStr = s.replace(/,/g, '').replace(/\./g, '.');
  } else {
    const sep = hasComma ? ',' : '.';
    const count = s.split(sep).length - 1;
    if (count > 1) {
      // Nhiều separator → tất cả là nghìn-phân-cách.
      decimalStr = s.split(sep).join('');
    } else {
      const idx = s.indexOf(sep);
      const digitsAfter = s.length - idx - 1;
      decimalStr = digitsAfter === 3 ? s.split(sep).join('') : s.replace(sep, '.');
    }
  }

  if (!/^\d+(\.\d+)?$/.test(decimalStr.trim())) return null;
  const num = parseFloat(decimalStr);
  if (!Number.isFinite(num)) return null;
  return BigInt(Math.round(num * Number(multiplier)));
}

/** Parse số nguyên từ body (floorNo/tầng, bedrooms...). Trả null nếu không hợp lệ. */
export function parseIntInput(
  value: unknown,
  field: string,
  opts: { min?: number; max?: number } = {},
): number | null {
  if (value === null || value === undefined || value === '') return null;
  let n: number;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    n = Number(value);
  } else {
    throw new CrmError(400, `${field} không hợp lệ`);
  }
  if (!Number.isInteger(n)) throw new CrmError(400, `${field} phải là số nguyên`);
  if (opts.min !== undefined && n < opts.min) throw new CrmError(400, `${field} phải >= ${opts.min}`);
  if (opts.max !== undefined && n > opts.max) throw new CrmError(400, `${field} phải <= ${opts.max}`);
  return n;
}

/** Parse số thực (diện tích m2, mặt tiền...) từ body. Trả null nếu không hợp lệ. */
export function parseFloatInput(value: unknown, field: string, min = 0): number | null {
  if (value === null || value === undefined || value === '') return null;
  let n: number;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    n = Number(value);
  } else {
    throw new CrmError(400, `${field} không hợp lệ`);
  }
  if (!Number.isFinite(n) || n < min) throw new CrmError(400, `${field} không hợp lệ`);
  return n;
}

/**
 * Chuẩn hoá unitCode: trim + uppercase để unique(orgId, projectId, unitCode)
 * nhất quán (không phân biệt hoa thường khi nhập "a1-101" vs "A1-101").
 */
export function normalizeUnitCode(value: string): string {
  return value.trim().toUpperCase();
}

// ── Filters typings ────────────────────────────────────────────────────────
export interface PropertyListFilters {
  projectId?: string;
  statusCode?: string;
  agencyId?: string;
  category?: string;
  transactionType?: string;
  priceMin?: bigint;
  priceMax?: bigint;
  q?: string;
  includeInactive?: boolean;
  page?: number;
  pageSize?: number;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

export function buildWhereOrg(
  orgId: string,
  f: PropertyListFilters,
): Prisma.PropertyWhereInput {
  const where: Prisma.PropertyWhereInput = {
    orgId,
    ...(f.projectId ? { projectId: f.projectId } : {}),
    ...(f.statusCode ? { statusCode: f.statusCode } : {}),
    ...(f.agencyId ? { agencyId: f.agencyId } : {}),
    ...(f.category ? { category: f.category } : {}),
    ...(f.transactionType ? { transactionType: f.transactionType } : {}),
  };
  // Lọc theo khoảng giá — priceVnd là BigInt nên so sánh kiểu BigInt.
  if (f.priceMin !== undefined && f.priceMin !== null && f.priceMax !== undefined && f.priceMax !== null) {
    where.priceVnd = { gte: f.priceMin, lte: f.priceMax };
  } else if (f.priceMin !== undefined && f.priceMin !== null) {
    where.priceVnd = { gte: f.priceMin };
  } else if (f.priceMax !== undefined && f.priceMax !== null) {
    where.priceVnd = { lte: f.priceMax };
  }
  if (f.q && f.q.trim()) {
    const q = f.q.trim();
    where.OR = [
      { unitCode: { contains: q, mode: 'insensitive' } },
      { zoneName: { contains: q, mode: 'insensitive' } },
      { blockName: { contains: q, mode: 'insensitive' } },
      { note: { contains: q, mode: 'insensitive' } },
    ];
  }
  if (!f.includeInactive) where.isActive = true;
  return where;
}

export interface PropertyInput {
  projectId: string;
  agencyId?: string | null;
  unitCode: string;
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
  priceTtsVnd?: bigint | null;
  priceHtlsVnd?: bigint | null;
  unitPriceTtsVnd?: bigint | null;
  specialMechanismCode?: string | null;
  usableAreaM2?: number | null;
  timTuongAreaM2?: number | null;
  landAreaM2?: number | null;
  constructionAreaM2?: number | null;
  frontageM?: number | null;
  depthM?: number | null;
  roadWidthM?: number | null;
  balconyDirectionCode?: string | null;
  viewCode?: string | null;
  directionCode?: string | null;
  landDirectionCode?: string | null;
  legalCode?: string | null;
  legalNote?: string | null;
  handoverCode?: string | null;
  furnitureCode?: string | null;
  handoverYear?: number | null;
  assignedUserId?: string | null;
  note?: string | null;
  attributes?: Record<string, unknown> | null;
}

/** Validate agency (nếu có) thuộc org. Trả agencyId hoặc null. */
async function resolveAgencyId(orgId: string, agencyId?: string | null): Promise<string | null> {
  if (!agencyId) return null;
  const agency = await prisma.agency.findFirst({ where: { id: agencyId, orgId } });
  if (!agency) throw new CrmError(400, 'Đại lý không thuộc tổ chức này');
  return agency.id;
}

/** Validate project thuộc org. Trả project id. */
async function resolveProjectId(orgId: string, projectId: string): Promise<string> {
  const project = await prisma.project.findFirst({ where: { id: projectId, orgId } });
  if (!project) throw new CrmError(400, 'Dự án không thuộc tổ chức này');
  return project.id;
}

export async function listProperties(
  orgId: string,
  f: PropertyListFilters,
): Promise<{ items: unknown[]; total: number; page: number; pageSize: number }> {
  const page = f.page && f.page > 0 ? f.page : 1;
  const pageSize = f.pageSize ? Math.min(Math.max(1, f.pageSize), MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE;
  const where = buildWhereOrg(orgId, f);
  const [items, total] = await Promise.all([
    prisma.property.findMany({
      where,
      include: {
        project: { select: { id: true, name: true } },
        agency: { select: { id: true, code: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.property.count({ where }),
  ]);
  return {
    items: (items as unknown[]).map((row) => serializeProperty(row as Record<string, unknown>)),
    total,
    page,
    pageSize,
  };
}

export async function getProperty(orgId: string, id: string): Promise<unknown> {
  const item = await prisma.property.findFirst({
    where: { id, orgId },
    include: {
      project: { select: { id: true, name: true } },
      agency: { select: { id: true, code: true, name: true } },
      media: { orderBy: { sortOrder: 'asc' } },
    },
  });
  if (!item) throw new CrmError(404, 'Căn không tồn tại');
  return serializeProperty(item as unknown as Record<string, unknown>);
}

export async function createProperty(
  orgId: string,
  input: PropertyInput,
): Promise<unknown> {
  if (!input.unitCode?.trim()) throw new CrmError(400, 'unitCode (mã căn) required');
  if (!input.projectId) throw new CrmError(400, 'projectId required');
  await resolveProjectId(orgId, input.projectId);
  const agencyId = await resolveAgencyId(orgId, input.agencyId);
  const data: Prisma.PropertyCreateInput = {
    org: { connect: { id: orgId } },
    project: { connect: { id: input.projectId } },
    unitCode: normalizeUnitCode(input.unitCode),
    ...(agencyId ? { agency: { connect: { id: agencyId } } } : {}),
    ...(input.zoneName !== undefined ? { zoneName: input.zoneName } : {}),
    ...(input.blockName !== undefined ? { blockName: input.blockName } : {}),
    ...(input.propertyTypeCode !== undefined ? { propertyTypeCode: input.propertyTypeCode } : {}),
    ...(input.category !== undefined ? { category: input.category } : {}),
    ...(input.transactionType !== undefined ? { transactionType: input.transactionType } : {}),
    ...(input.statusCode !== null && input.statusCode !== undefined ? { statusCode: input.statusCode } : { statusCode: 'AVAILABLE' }),
    ...(input.statusNote !== undefined ? { statusNote: input.statusNote } : {}),
    ...(input.floorNo !== undefined ? { floorNo: input.floorNo } : {}),
    ...(input.totalFloors !== undefined ? { totalFloors: input.totalFloors } : {}),
    ...(input.bedrooms !== undefined ? { bedrooms: input.bedrooms } : {}),
    ...(input.bathrooms !== undefined ? { bathrooms: input.bathrooms } : {}),
    ...(input.priceVnd !== undefined ? { priceVnd: input.priceVnd } : {}),
    ...(input.priceRentVnd !== undefined ? { priceRentVnd: input.priceRentVnd } : {}),
    ...(input.priceBasisCode !== undefined ? { priceBasisCode: input.priceBasisCode } : {}),
    ...(input.priceNote !== undefined ? { priceNote: input.priceNote } : {}),
    ...(input.priceTtsVnd !== undefined ? { priceTtsVnd: input.priceTtsVnd } : {}),
    ...(input.priceHtlsVnd !== undefined ? { priceHtlsVnd: input.priceHtlsVnd } : {}),
    ...(input.unitPriceTtsVnd !== undefined ? { unitPriceTtsVnd: input.unitPriceTtsVnd } : {}),
    ...(input.specialMechanismCode !== undefined ? { specialMechanismCode: input.specialMechanismCode } : {}),
    ...(input.usableAreaM2 !== null && input.usableAreaM2 !== undefined ? { usableAreaM2: input.usableAreaM2 } : {}),
    ...(input.timTuongAreaM2 !== null && input.timTuongAreaM2 !== undefined ? { timTuongAreaM2: input.timTuongAreaM2 } : {}),
    ...(input.landAreaM2 !== null && input.landAreaM2 !== undefined ? { landAreaM2: input.landAreaM2 } : {}),
    ...(input.constructionAreaM2 !== null && input.constructionAreaM2 !== undefined ? { constructionAreaM2: input.constructionAreaM2 } : {}),
    ...(input.frontageM !== undefined ? { frontageM: input.frontageM } : {}),
    ...(input.depthM !== undefined ? { depthM: input.depthM } : {}),
    ...(input.roadWidthM !== undefined ? { roadWidthM: input.roadWidthM } : {}),
    ...(input.balconyDirectionCode !== undefined ? { balconyDirectionCode: input.balconyDirectionCode } : {}),
    ...(input.viewCode !== undefined ? { viewCode: input.viewCode } : {}),
    ...(input.directionCode !== undefined ? { directionCode: input.directionCode } : {}),
    ...(input.landDirectionCode !== undefined ? { landDirectionCode: input.landDirectionCode } : {}),
    ...(input.legalCode !== undefined ? { legalCode: input.legalCode } : {}),
    ...(input.legalNote !== undefined ? { legalNote: input.legalNote } : {}),
    ...(input.handoverCode !== undefined ? { handoverCode: input.handoverCode } : {}),
    ...(input.furnitureCode !== undefined ? { furnitureCode: input.furnitureCode } : {}),
    ...(input.handoverYear !== undefined ? { handoverYear: input.handoverYear } : {}),
    ...(input.assignedUserId !== undefined ? { assignedUserId: input.assignedUserId } : {}),
    ...(input.note !== undefined ? { note: input.note } : {}),
    ...(input.attributes !== undefined ? { attributes: input.attributes as Prisma.InputJsonValue } : {}),
  };
  try {
    const created = await prisma.property.create({ data });
    return serializeProperty(created as unknown as Record<string, unknown>);
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') {
      throw new CrmError(409, 'Mã căn đã tồn tại trong dự án này', { code: 'PROPERTY_DUPLICATE' });
    }
    throw err;
  }
}

export async function updateProperty(
  orgId: string,
  id: string,
  input: Partial<PropertyInput>,
): Promise<unknown> {
  const existing = await prisma.property.findFirst({ where: { id, orgId } });
  if (!existing) throw new CrmError(404, 'Căn không tồn tại');
  if (input.projectId && input.projectId !== existing.projectId) {
    await resolveProjectId(orgId, input.projectId);
  }
  const agencyId = await resolveAgencyId(orgId, input.agencyId);
  const data: Prisma.PropertyUpdateInput = {
    ...(input.projectId ? { project: { connect: { id: input.projectId } } } : {}),
    ...(input.agencyId !== undefined
      ? agencyId
        ? { agency: { connect: { id: agencyId } } }
        : { agency: { disconnect: true } }
      : {}),
    ...(input.unitCode !== null && input.unitCode !== undefined ? { unitCode: normalizeUnitCode(input.unitCode) } : {}),
    ...(input.zoneName !== undefined ? { zoneName: input.zoneName } : {}),
    ...(input.blockName !== undefined ? { blockName: input.blockName } : {}),
    ...(input.propertyTypeCode !== undefined ? { propertyTypeCode: input.propertyTypeCode } : {}),
    ...(input.category !== undefined ? { category: input.category } : {}),
    ...(input.transactionType !== undefined ? { transactionType: input.transactionType } : {}),
    ...(input.statusCode !== null && input.statusCode !== undefined ? { statusCode: input.statusCode } : {}),
    ...(input.statusNote !== undefined ? { statusNote: input.statusNote } : {}),
    ...(input.floorNo !== undefined ? { floorNo: input.floorNo } : {}),
    ...(input.totalFloors !== undefined ? { totalFloors: input.totalFloors } : {}),
    ...(input.bedrooms !== undefined ? { bedrooms: input.bedrooms } : {}),
    ...(input.bathrooms !== undefined ? { bathrooms: input.bathrooms } : {}),
    ...(input.priceVnd !== undefined ? { priceVnd: input.priceVnd } : {}),
    ...(input.priceRentVnd !== undefined ? { priceRentVnd: input.priceRentVnd } : {}),
    ...(input.priceBasisCode !== undefined ? { priceBasisCode: input.priceBasisCode } : {}),
    ...(input.priceNote !== undefined ? { priceNote: input.priceNote } : {}),
    ...(input.priceTtsVnd !== undefined ? { priceTtsVnd: input.priceTtsVnd } : {}),
    ...(input.priceHtlsVnd !== undefined ? { priceHtlsVnd: input.priceHtlsVnd } : {}),
    ...(input.unitPriceTtsVnd !== undefined ? { unitPriceTtsVnd: input.unitPriceTtsVnd } : {}),
    ...(input.specialMechanismCode !== undefined ? { specialMechanismCode: input.specialMechanismCode } : {}),
    ...(input.usableAreaM2 !== null && input.usableAreaM2 !== undefined ? { usableAreaM2: input.usableAreaM2 } : {}),
    ...(input.timTuongAreaM2 !== null && input.timTuongAreaM2 !== undefined ? { timTuongAreaM2: input.timTuongAreaM2 } : {}),
    ...(input.landAreaM2 !== null && input.landAreaM2 !== undefined ? { landAreaM2: input.landAreaM2 } : {}),
    ...(input.constructionAreaM2 !== null && input.constructionAreaM2 !== undefined ? { constructionAreaM2: input.constructionAreaM2 } : {}),
    ...(input.frontageM !== undefined ? { frontageM: input.frontageM } : {}),
    ...(input.depthM !== undefined ? { depthM: input.depthM } : {}),
    ...(input.roadWidthM !== undefined ? { roadWidthM: input.roadWidthM } : {}),
    ...(input.balconyDirectionCode !== undefined ? { balconyDirectionCode: input.balconyDirectionCode } : {}),
    ...(input.viewCode !== undefined ? { viewCode: input.viewCode } : {}),
    ...(input.directionCode !== undefined ? { directionCode: input.directionCode } : {}),
    ...(input.landDirectionCode !== undefined ? { landDirectionCode: input.landDirectionCode } : {}),
    ...(input.legalCode !== undefined ? { legalCode: input.legalCode } : {}),
    ...(input.legalNote !== undefined ? { legalNote: input.legalNote } : {}),
    ...(input.handoverCode !== undefined ? { handoverCode: input.handoverCode } : {}),
    ...(input.furnitureCode !== undefined ? { furnitureCode: input.furnitureCode } : {}),
    ...(input.handoverYear !== undefined ? { handoverYear: input.handoverYear } : {}),
    ...(input.assignedUserId !== undefined ? { assignedUserId: input.assignedUserId } : {}),
    ...(input.note !== undefined ? { note: input.note } : {}),
    ...(input.attributes !== undefined ? { attributes: input.attributes as Prisma.InputJsonValue } : {}),
  };
  try {
    const updated = await prisma.property.update({ where: { id }, data });
    return serializeProperty(updated as unknown as Record<string, unknown>);
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') {
      throw new CrmError(409, 'Mã căn đã tồn tại trong dự án này', { code: 'PROPERTY_DUPLICATE' });
    }
    throw err;
  }
}

// Soft delete: isActive = false. Property vẫn giữ để trace history + FK an toàn
// (media, campaign đang trỏ). List mặc định chỉ hiện isActive=true.
export async function deleteProperty(orgId: string, id: string): Promise<{ deleted: boolean; id: string }> {
  const existing = await prisma.property.findFirst({ where: { id, orgId } });
  if (!existing) throw new CrmError(404, 'Căn không tồn tại');
  await prisma.property.update({ where: { id }, data: { isActive: false } });
  return { deleted: true, id };
}

// ── Compare ────────────────────────────────────────────────────────────────
/** Các trường so sánh khi user chọn 2+ căn để đối chiếu bảng hàng. */
export const COMPARE_FIELDS = [
  'unitCode',
  'statusCode',
  'transactionType',
  'priceVnd',
  'priceRentVnd',
  'priceBasisCode',
  'usableAreaM2',
  'bedrooms',
  'bathrooms',
  'floorNo',
  'blockName',
  'zoneName',
  'directionCode',
  'category',
] as const;

export interface CompareDiffEntry {
  field: string;
  /** Map propertyId → value (BigInt đã serialize string; null nếu trống). */
  values: Record<string, string | number | boolean | null>;
}

export async function compareProperties(
  orgId: string,
  ids: string[],
): Promise<{ items: unknown[]; diff: CompareDiffEntry[]; ids: string[] }> {
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length < 2) {
    throw new CrmError(400, 'Cần ít nhất 2 căn để so sánh (ids=a,b)');
  }
  if (uniqueIds.length > 10) {
    throw new CrmError(400, 'Tối đa 10 căn trong 1 lần so sánh');
  }
  const rows = await prisma.property.findMany({
    where: { id: { in: uniqueIds }, orgId },
    include: {
      project: { select: { id: true, name: true } },
      agency: { select: { id: true, code: true, name: true } },
    },
  });
  if (rows.length < 2) throw new CrmError(404, 'Không đủ căn hợp lệ để so sánh');

  const diff: CompareDiffEntry[] = [];
  for (const field of COMPARE_FIELDS) {
    const values: Record<string, string | number | boolean | null> = {};
    let firstVal: unknown;
    let allSame = true;
    for (const row of rows) {
      const raw = (row as Record<string, unknown>)[field];
      const v = typeof raw === 'bigint' ? raw.toString() : ((raw as string | number | boolean | null) ?? null);
      values[row.id] = v;
      if (firstVal === undefined) firstVal = v;
      else if (v !== firstVal) allSame = false;
    }
    if (!allSame) diff.push({ field, values });
  }
  return {
    items: rows.map((r) => serializeProperty(r as unknown as Record<string, unknown>)),
    diff,
    ids: rows.map((r) => r.id),
  };
}