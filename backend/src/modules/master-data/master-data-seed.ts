// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyễn Tiến Lộc
/**
 * master-data-seed.ts — Seed các nhóm danh mục (MasterDataCategory) mặc định.
 *
 * Idempotent: chạy nhiều lần được, chỉ tạo khi nhóm chưa tồn tại trong org
 * (so theo unique [orgId, key]).
 *
 * 10 nhóm chuẩn cho CRM bất động sản:
 *   - Nhóm KH:  NGUON_KH (nguồn KH), TRANG_THAI_KH (xếp hạng/trạng thái KH)
 *   - Nhóm bảng hàng: LOAI_CAN, HUONG, VIEW, BAN_GIAO, NOI_THAT, DAI_LY,
 *     TRANG_THAI_CAN, PHAPLY
 *
 * Gọi từ:
 *   - Route GET /categories (lazy-ensure khi org mới)
 *   - Controller có thể gọi seedMasterDataCategories(orgId) lúc tạo org.
 */

import { prisma } from '../../shared/database/prisma-client.js';
import type { MasterDataCategoryRow } from './master-data-service.js';

export interface DefaultCategorySeed {
  key: string;
  label: string;
  icon: string;
  sortOrder: number;
}

export const DEFAULT_MASTER_DATA_CATEGORIES: DefaultCategorySeed[] = [
  // ── Nhóm khách hàng ──
  { key: 'NGUON_KH', label: 'Nguồn KH', icon: 'mdi-account-network-outline', sortOrder: 10 },
  { key: 'TRANG_THAI_KH', label: 'Trạng thái KH', icon: 'mdi-account-star-outline', sortOrder: 20 },
  // ── Nhóm bảng hàng ──
  { key: 'LOAI_CAN', label: 'Loại căn', icon: 'mdi-home-city-outline', sortOrder: 30 },
  { key: 'HUONG', label: 'Hướng', icon: 'mdi-compass-outline', sortOrder: 40 },
  { key: 'VIEW', label: 'View', icon: 'mdi-city-outline', sortOrder: 50 },
  { key: 'BAN_GIAO', label: 'Bàn giao', icon: 'mdi-keyboard-return-outline', sortOrder: 60 },
  { key: 'NOI_THAT', label: 'Nội thất', icon: 'mdi-sofa-outline', sortOrder: 70 },
  { key: 'DAI_LY', label: 'Đại lý', icon: 'mdi-storefront-outline', sortOrder: 80 },
  { key: 'TRANG_THAI_CAN', label: 'Trạng thái căn', icon: 'mdi-clipboard-check-outline', sortOrder: 90 },
  { key: 'PHAPLY', label: 'Pháp lý', icon: 'mdi-scale-balance', sortOrder: 100 },
];

export interface SeedMasterDataCategoriesResult {
  created: number;
  existing: number;
  categories: Array<{ id: string; key: string; label: string }>;
}

/**
 * Seed 10 nhóm danh mục mặc định cho org — idempotent.
 * Chỉ tạo nhóm chưa tồn tại; không ghi đè nhóm đã có (kể cả customize).
 */
export async function seedMasterDataCategories(
  orgId: string,
): Promise<SeedMasterDataCategoriesResult> {
  const existing = await prisma.masterDataCategory.findMany({
    where: { orgId },
    select: { id: true, key: true, label: true },
  });
  const existingByKey = new Map(existing.map((c) => [c.key, c.id]));

  const result: SeedMasterDataCategoriesResult = { created: 0, existing: 0, categories: [] };
  result.existing = existing.length;
  result.categories.push(...existing.map((c) => ({ id: c.id, key: c.key, label: c.label })));

  const missing = DEFAULT_MASTER_DATA_CATEGORIES.filter((d) => !existingByKey.has(d.key));
  for (const def of missing) {
    const created = await prisma.masterDataCategory.create({
      data: {
        orgId,
        key: def.key,
        label: def.label,
        icon: def.icon,
        sortOrder: def.sortOrder,
        isSystem: true,
      },
      select: { id: true, key: true, label: true },
    });
    result.created += 1;
    result.categories.push(created);
  }

  return result;
}

export type { MasterDataCategoryRow };