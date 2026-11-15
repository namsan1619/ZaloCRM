// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyễn Tiến Lộc
/**
 * master-data-service.ts — Business logic cho MasterData (danh mục dùng chung).
 *
 * MasterData = taxonomy per-org dùng chung cho nhiều module:
 *   NGUON_KH (nguồn KH), TRANG_THAI_KH (xếp hạng KH), LOAI_CAN/HUONG/VIEW/
 *   BAN_GIAO/NOI_THAT/TRANG_THAI_CAN/PHAPLY/DAI_LY (cho bảng hàng).
 *
 * Quy tắc:
 *   - Mọi query đều scope theo orgId (multi-tenant).
 *   - `code` unique trong 1 category (unique constraint [categoryId, code]).
 *   - `parentCode` phải tồn tại trong cùng category (hierarchy 2 cấp).
 *   - Delete bị chặn khi `metadata.usedBy` khác null → mục danh mục đang được
 *     module khác dùng (agent khác set cờ này qua PUT /items/:id).
 *
 * Không dùng zod — validate tay, trả MasterDataError (status + code) để route
 * map sang HTTP response.
 */

import { prisma, tenantTransaction } from '../../shared/database/prisma-client.js';

/* ── Types ─────────────────────────────────────────────────────────────── */

export interface MasterDataCategoryRow {
  id: string;
  orgId: string;
  key: string;
  label: string;
  icon: string | null;
  sortOrder: number;
  isSystem: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface MasterDataItemRow {
  id: string;
  orgId: string;
  categoryId: string;
  code: string;
  label: string;
  parentCode: string | null;
  sortOrder: number;
  color: string | null;
  isActive: boolean;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateItemPayload {
  categoryId?: string;
  categoryKey?: string;
  code?: string;
  label?: string;
  parentCode?: string | null;
  sortOrder?: number;
  color?: string | null;
  isActive?: boolean;
  metadata?: Record<string, unknown> | null;
}

export interface UpdateItemPayload {
  code?: string;
  label?: string;
  parentCode?: string | null;
  sortOrder?: number;
  color?: string | null;
  isActive?: boolean;
  metadata?: Record<string, unknown> | null;
}

export interface ListItemsParams {
  categoryKey?: string;
  q?: string;
  activeOnly?: boolean;
}

/** Lỗi nghiệp vụ — route map `status` sang HTTP status code. */
export class MasterDataError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'MasterDataError';
  }
}

/* ── Constants ─────────────────────────────────────────────────────────── */

const MAX_CODE_LEN = 64;
const MAX_LABEL_LEN = 128;

/* ── Helpers ───────────────────────────────────────────────────────────── */

/**
 * Đọc cờ `usedBy` trong metadata JSON.
 * metadata: null | object → dùng cờ này để chặn xóa mục đang được dùng.
 */
export function readUsedBy(metadata: unknown): unknown {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const usedBy = (metadata as Record<string, unknown>).usedBy;
  return usedBy ?? null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeCode(code: unknown): string {
  if (typeof code !== 'string') {
    throw new MasterDataError(400, 'CODE_REQUIRED', 'code là bắt buộc');
  }
  const trimmed = code.trim();
  if (!trimmed) throw new MasterDataError(400, 'CODE_REQUIRED', 'code là bắt buộc');
  if (trimmed.length > MAX_CODE_LEN) {
    throw new MasterDataError(400, 'CODE_TOO_LONG', `code tối đa ${MAX_CODE_LEN} ký tự`);
  }
  return trimmed;
}

function normalizeLabel(label: unknown): string {
  if (typeof label !== 'string') {
    throw new MasterDataError(400, 'LABEL_REQUIRED', 'label là bắt buộc');
  }
  const trimmed = label.trim();
  if (!trimmed) throw new MasterDataError(400, 'LABEL_REQUIRED', 'label là bắt buộc');
  if (trimmed.length > MAX_LABEL_LEN) {
    throw new MasterDataError(400, 'LABEL_TOO_LONG', `label tối đa ${MAX_LABEL_LEN} ký tự`);
  }
  return trimmed;
}

function normalizeSortOrder(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) {
    throw new MasterDataError(400, 'INVALID_SORT_ORDER', 'sortOrder phải là số');
  }
  return Math.trunc(n);
}

/** Chuẩn hoá color: chỉ nhận hex #RGB/#RRGGBB, hỗ trợ mã màu của theme. */
function normalizeColor(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw new MasterDataError(400, 'INVALID_COLOR', 'color không hợp lệ');
  }
  const trimmed = value.trim();
  if (!/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(trimmed)) {
    throw new MasterDataError(400, 'INVALID_COLOR', 'color phải là mã hex (#RGB hoặc #RRGGBB)');
  }
  return trimmed.toUpperCase();
}

function normalizeMetadata(value: unknown): Record<string, unknown> | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!isPlainObject(value)) {
    throw new MasterDataError(400, 'INVALID_METADATA', 'metadata phải là object hoặc null');
  }
  return value;
}

function isPrismaError(err: unknown): err is { code?: string; meta?: unknown } {
  return !!err && typeof err === 'object' && 'code' in (err as Record<string, unknown>);
}

/* ── Queries ──────────────────────────────────────────────────────────── */

/** Danh sách nhóm danh mục của org, sort theo sortOrder rồi key. */
export async function listCategories(orgId: string): Promise<MasterDataCategoryRow[]> {
  return prisma.masterDataCategory.findMany({
    where: { orgId },
    orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }],
  }) as Promise<MasterDataCategoryRow[]>;
}

/**
 * Danh sách mục danh mục.
 * - categoryKey: lọc theo key nhóm (không tồn tại → trả mảng rỗng).
 * - q: tìm theo code hoặc label (không phân biệt hoa thường).
 * - activeOnly: chỉ lấy mục còn active.
 */
export async function listItems(
  orgId: string,
  params: ListItemsParams = {},
): Promise<MasterDataItemRow[]> {
  const where: Record<string, unknown> = { orgId };

  if (params.categoryKey?.trim()) {
    const category = await prisma.masterDataCategory.findFirst({
      where: { orgId, key: params.categoryKey.trim() },
      select: { id: true },
    });
    if (!category) return [];
    where.categoryId = category.id;
  }

  if (params.q?.trim()) {
    const q = params.q.trim();
    where.OR = [
      { code: { contains: q, mode: 'insensitive' } },
      { label: { contains: q, mode: 'insensitive' } },
    ];
  }

  if (params.activeOnly) where.isActive = true;

  return prisma.masterData.findMany({
    where,
    orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
  }) as Promise<MasterDataItemRow[]>;
}

/* ── Mutations ────────────────────────────────────────────────────────── */

async function resolveCategoryId(
  orgId: string,
  payload: CreateItemPayload,
): Promise<string> {
  const categoryId = payload.categoryId?.trim();
  const categoryKey = payload.categoryKey?.trim();

  if (categoryId) {
    const category = await prisma.masterDataCategory.findFirst({
      where: { id: categoryId, orgId },
      select: { id: true },
    });
    if (!category) {
      throw new MasterDataError(404, 'CATEGORY_NOT_FOUND', 'Không tìm thấy nhóm danh mục');
    }
    return category.id;
  }

  if (categoryKey) {
    const category = await prisma.masterDataCategory.findFirst({
      where: { orgId, key: categoryKey },
      select: { id: true },
    });
    if (!category) {
      throw new MasterDataError(404, 'CATEGORY_NOT_FOUND', `Không tìm thấy nhóm danh mục "${categoryKey}"`);
    }
    return category.id;
  }

  throw new MasterDataError(400, 'CATEGORY_REQUIRED', 'categoryId hoặc categoryKey là bắt buộc');
}

/** parentCode phải tồn tại trong cùng category và không tự trỏ chính nó. */
async function assertParentExists(
  orgId: string,
  categoryId: string,
  parentCode: string | null | undefined,
  selfCode?: string,
): Promise<void> {
  if (parentCode === undefined || parentCode === null) return;
  const trimmed = parentCode.trim();
  if (!trimmed) return;
  if (selfCode && trimmed === selfCode) {
    throw new MasterDataError(400, 'INVALID_PARENT', 'parentCode không được trỏ về chính nó');
  }
  const parent = await prisma.masterData.findFirst({
    where: { orgId, categoryId, code: trimmed },
    select: { id: true },
  });
  if (!parent) {
    throw new MasterDataError(400, 'PARENT_NOT_FOUND', `parentCode "${trimmed}" không tồn tại trong nhóm danh mục`);
  }
}

/** Tạo mục danh mục mới. */
export async function createItem(
  orgId: string,
  payload: CreateItemPayload,
): Promise<MasterDataItemRow> {
  const categoryId = await resolveCategoryId(orgId, payload);
  const code = normalizeCode(payload.code);
  const label = normalizeLabel(payload.label);
  const parentCode =
    payload.parentCode === undefined || payload.parentCode === null
      ? null
      : payload.parentCode.trim() || null;
  const sortOrder = normalizeSortOrder(payload.sortOrder) ?? 0;
  const color = normalizeColor(payload.color) ?? null;
  const isActive = payload.isActive ?? true;
  const metadata = normalizeMetadata(payload.metadata) ?? { usedBy: null };

  await assertParentExists(orgId, categoryId, parentCode, code);

  const duplicate = await prisma.masterData.findFirst({
    where: { categoryId, code },
    select: { id: true },
  });
  if (duplicate) {
    throw new MasterDataError(409, 'DUPLICATE_CODE', `code "${code}" đã tồn tại trong nhóm danh mục`);
  }

  try {
    return (await prisma.masterData.create({
      data: {
        orgId,
        categoryId,
        code,
        label,
        parentCode,
        sortOrder,
        color,
        isActive,
        metadata: metadata as object,
      },
    })) as MasterDataItemRow;
  } catch (err) {
    if (isPrismaError(err) && err.code === 'P2002') {
      throw new MasterDataError(409, 'DUPLICATE_CODE', `code "${code}" đã tồn tại trong nhóm danh mục`);
    }
    throw err;
  }
}

/** Cập nhật mục danh mục. Chỉ set field được truyền vào. */
export async function updateItem(
  orgId: string,
  id: string,
  payload: UpdateItemPayload,
): Promise<MasterDataItemRow> {
  const existing = await prisma.masterData.findFirst({
    where: { id, orgId },
    select: { id: true, categoryId: true, code: true, parentCode: true },
  });
  if (!existing) {
    throw new MasterDataError(404, 'ITEM_NOT_FOUND', 'Không tìm thấy mục danh mục');
  }

  const data: Record<string, unknown> = {};

  if (payload.code !== undefined) {
    const code = normalizeCode(payload.code);
    if (code !== existing.code) {
      const duplicate = await prisma.masterData.findFirst({
        where: { categoryId: existing.categoryId, code, id: { not: id } },
        select: { id: true },
      });
      if (duplicate) {
        throw new MasterDataError(409, 'DUPLICATE_CODE', `code "${code}" đã tồn tại trong nhóm danh mục`);
      }
    }
    data.code = code;
  }

  if (payload.label !== undefined) data.label = normalizeLabel(payload.label);

  if (payload.parentCode !== undefined) {
    const parentCode = payload.parentCode === null ? null : payload.parentCode.trim() || null;
    const nextCode = (data.code as string | undefined) ?? existing.code;
    await assertParentExists(orgId, existing.categoryId, parentCode, nextCode);
    data.parentCode = parentCode;
  }

  const sortOrder = normalizeSortOrder(payload.sortOrder);
  if (sortOrder !== undefined) data.sortOrder = sortOrder;

  const color = normalizeColor(payload.color);
  if (color !== undefined) data.color = color;

  if (payload.isActive !== undefined) data.isActive = payload.isActive;

  const metadata = normalizeMetadata(payload.metadata);
  if (metadata !== undefined) data.metadata = metadata as object;

  try {
    return (await prisma.masterData.update({
      where: { id },
      data,
    })) as MasterDataItemRow;
  } catch (err) {
    if (isPrismaError(err) && err.code === 'P2002') {
      throw new MasterDataError(409, 'DUPLICATE_CODE', 'code đã tồn tại trong nhóm danh mục');
    }
    throw err;
  }
}

/**
 * Xóa mục danh mục.
 * Chặn khi: metadata.usedBy khác null (đang được dùng) hoặc còn mục con
 * trỏ parentCode về mục này.
 */
export async function deleteItem(orgId: string, id: string): Promise<{ id: string }> {
  const existing = await prisma.masterData.findFirst({
    where: { id, orgId },
    select: { id: true, categoryId: true, code: true, metadata: true },
  });
  if (!existing) {
    throw new MasterDataError(404, 'ITEM_NOT_FOUND', 'Không tìm thấy mục danh mục');
  }

  const usedBy = readUsedBy(existing.metadata);
  if (usedBy !== null) {
    throw new MasterDataError(
      400,
      'ITEM_IN_USE',
      `Mục danh mục đang được sử dụng (${String(usedBy)}), không thể xóa`,
    );
  }

  const childCount = await prisma.masterData.count({
    where: { orgId, categoryId: existing.categoryId, parentCode: existing.code },
  });
  if (childCount > 0) {
    throw new MasterDataError(
      400,
      'HAS_CHILDREN',
      `Còn ${childCount} mục con trỏ về mục này, không thể xóa`,
    );
  }

  try {
    await prisma.masterData.delete({ where: { id } });
  } catch (err) {
    if (isPrismaError(err) && err.code === 'P2003') {
      throw new MasterDataError(400, 'ITEM_IN_USE', 'Mục danh mục đang được sử dụng, không thể xóa');
    }
    throw err;
  }

  return { id };
}

/** Đổi thứ tự hiển thị (sortOrder) cho nhiều mục — bulk update. */
export async function reorderItems(
  orgId: string,
  items: Array<{ id: string; sortOrder: number }>,
): Promise<number> {
  let updated = 0;
  await tenantTransaction(async (tx) => {
    for (const it of items) {
      const res = await tx.masterData.updateMany({
        where: { id: it.id, orgId },
        data: { sortOrder: it.sortOrder },
      });
      updated += res.count;
    }
  });
  return updated;
}
