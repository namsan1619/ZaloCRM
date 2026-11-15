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
  // ── Nhóm bổ sung (UI/backend dùng) ──
  { key: 'CO_CHE_DAC_BIET', label: 'Cơ chế đặc biệt', icon: 'mdi-star-circle-outline', sortOrder: 110 },
  { key: 'KEHOACH', label: 'Kênh chiến dịch', icon: 'mdi-bullhorn-outline', sortOrder: 120 },
];

export interface SeedMasterDataCategoriesResult {
  created: number;
  existing: number;
  categories: Array<{ id: string; key: string; label: string }>;
}

/**
 * Item mặc định cho mỗi nhóm — để dropdown UI có sẵn lựa chọn ngay khi cài mới
 * (nếu không có item, mọi select MasterData sẽ rỗng và ratingCode mặc định
 * không validate được). Idempotent: chỉ tạo item chưa có trong nhóm.
 *
 * Mã (code) cố định để khớp với giá trị đang dùng trong schema/UI:
 *   TRANG_THAI_CAN.AVAILABLE/ON_HOLD/DEPOSITED/SOLD/RENTED/HIDDEN (mặc định Property.statusCode)
 */
export interface DefaultItemSeed {
  categoryKey: string;
  code: string;
  label: string;
  sortOrder: number;
  color?: string;
}

export const DEFAULT_MASTER_DATA_ITEMS: DefaultItemSeed[] = [
  // ── Nguồn KH ──
  { categoryKey: 'NGUON_KH', code: 'facebook', label: 'Facebook', sortOrder: 10 },
  { categoryKey: 'NGUON_KH', code: 'tiktok', label: 'TikTok', sortOrder: 20 },
  { categoryKey: 'NGUON_KH', code: 'gioi_thieu', label: 'Giới thiệu', sortOrder: 30 },
  { categoryKey: 'NGUON_KH', code: 'tep_kh_cu', label: 'Tệp KH cũ', sortOrder: 40 },
  { categoryKey: 'NGUON_KH', code: 'dai_ly', label: 'Đại lý', sortOrder: 50 },
  { categoryKey: 'NGUON_KH', code: 'zalo', label: 'Zalo quét', sortOrder: 60 },
  { categoryKey: 'NGUON_KH', code: 'khac', label: 'Khác', sortOrder: 70 },

  // ── Mức đánh giá KH ──
  { categoryKey: 'TRANG_THAI_KH', code: 'A', label: 'A — Rất quan tâm', sortOrder: 10, color: '#16a34a' },
  { categoryKey: 'TRANG_THAI_KH', code: 'B', label: 'B — Quan tâm', sortOrder: 20, color: '#f59e0b' },
  { categoryKey: 'TRANG_THAI_KH', code: 'C', label: 'C — Cần nuôi dưỡng', sortOrder: 30, color: '#3b82f6' },
  { categoryKey: 'TRANG_THAI_KH', code: 'D', label: 'D — Chưa rõ nhu cầu', sortOrder: 40, color: '#64748b' },

  // ── Loại căn ──
  { categoryKey: 'LOAI_CAN', code: 'CHUC', label: 'Chung cư', sortOrder: 10 },
  { categoryKey: 'LOAI_CAN', code: 'CAN_HO', label: 'Căn hộ', sortOrder: 20 },
  { categoryKey: 'LOAI_CAN', code: 'DAT_NEN', label: 'Đất nền', sortOrder: 30 },
  { categoryKey: 'LOAI_CAN', code: 'NHA_PHO', label: 'Nhà phố', sortOrder: 40 },
  { categoryKey: 'LOAI_CAN', code: 'SHOPHOUSE', label: 'Shophouse', sortOrder: 50 },
  { categoryKey: 'LOAI_CAN', code: 'KHO_XUAT', label: 'Kho xuất', sortOrder: 60 },

  // ── Hướng ──
  { categoryKey: 'HUONG', code: 'DONG', label: 'Đông', sortOrder: 10 },
  { categoryKey: 'HUONG', code: 'TAY', label: 'Tây', sortOrder: 20 },
  { categoryKey: 'HUONG', code: 'NAM', label: 'Nam', sortOrder: 30 },
  { categoryKey: 'HUONG', code: 'BAC', label: 'Bắc', sortOrder: 40 },
  { categoryKey: 'HUONG', code: 'DONG_BAC', label: 'Đông Bắc', sortOrder: 50 },
  { categoryKey: 'HUONG', code: 'DONG_NAM', label: 'Đông Nam', sortOrder: 60 },
  { categoryKey: 'HUONG', code: 'TAY_BAC', label: 'Tây Bắc', sortOrder: 70 },
  { categoryKey: 'HUONG', code: 'TAY_NAM', label: 'Tây Nam', sortOrder: 80 },

  // ── View ──
  { categoryKey: 'VIEW', code: 'HO_GIOI', label: 'Hồ Gươm', sortOrder: 10 },
  { categoryKey: 'VIEW', code: 'NOI_KHU', label: 'Nội khu', sortOrder: 20 },
  { categoryKey: 'VIEW', code: 'TRUC_DUONG', label: 'Trực đường', sortOrder: 30 },
  { categoryKey: 'VIEW', code: 'CONG_VIEN', label: 'Công viên', sortOrder: 40 },
  { categoryKey: 'VIEW', code: 'TRUONG_HOC', label: 'Trường học', sortOrder: 50 },

  // ── Bàn giao ──
  { categoryKey: 'BAN_GIAO', code: 'THO', label: 'Bàn giao thô', sortOrder: 10 },
  { categoryKey: 'BAN_GIAO', code: 'CO_BAN', label: 'Hoàn thiện cơ bản', sortOrder: 20 },
  { categoryKey: 'BAN_GIAO', code: 'DEP', label: 'Hoàn thiện đẹp', sortOrder: 30 },
  { categoryKey: 'BAN_GIAO', code: 'NOI_THAT', label: 'Nhận nội thất', sortOrder: 40 },

  // ── Nội thất ──
  { categoryKey: 'NOI_THAT', code: 'TRONG', label: 'Không nội thất', sortOrder: 10 },
  { categoryKey: 'NOI_THAT', code: 'CO_BAN', label: 'Nội thất cơ bản', sortOrder: 20 },
  { categoryKey: 'NOI_THAT', code: 'CAO_CAP', label: 'Nội thất cao cấp', sortOrder: 30 },

  // ── Trạng thái căn (mã khớp default Property.statusCode = AVAILABLE) ──
  { categoryKey: 'TRANG_THAI_CAN', code: 'AVAILABLE', label: 'Còn bán', sortOrder: 10, color: '#16a34a' },
  { categoryKey: 'TRANG_THAI_CAN', code: 'ON_HOLD', label: 'Tạm giữ', sortOrder: 20, color: '#f59e0b' },
  { categoryKey: 'TRANG_THAI_CAN', code: 'DEPOSITED', label: 'Đã cọc', sortOrder: 30, color: '#8b5cf6' },
  { categoryKey: 'TRANG_THAI_CAN', code: 'SOLD', label: 'Đã bán', sortOrder: 40, color: '#64748b' },
  { categoryKey: 'TRANG_THAI_CAN', code: 'RENTED', label: 'Cho thuê', sortOrder: 50, color: '#0ea5e9' },
  { categoryKey: 'TRANG_THAI_CAN', code: 'HIDDEN', label: 'Ẩn khỏi bảng', sortOrder: 60, color: '#64748b' },

  // ── Pháp lý ──
  { categoryKey: 'PHAPLY', code: 'SO_DO', label: 'Sổ đỏ', sortOrder: 10 },
  { categoryKey: 'PHAPLY', code: 'HDB', label: 'Hợp đồng mua bán', sortOrder: 20 },
  { categoryKey: 'PHAPLY', code: 'CHUYEN_NHUONG', label: 'Chuyển nhượng', sortOrder: 30 },
  { categoryKey: 'PHAPLY', code: 'THE_CHAP', label: 'Đang thế chấp', sortOrder: 40 },

  // ── Cơ chế đặc biệt ──
  { categoryKey: 'CO_CHE_DAC_BIET', code: 'CHIET_KHAU', label: 'Chiết khấu', sortOrder: 10 },
  { categoryKey: 'CO_CHE_DAC_BIET', code: 'CK_TIEN_MAT', label: 'Chiết khấu tiền mặt', sortOrder: 20 },
  { categoryKey: 'CO_CHE_DAC_BIET', code: 'CK_HT', label: 'Chiết khấu thanh khoản', sortOrder: 30 },
  { categoryKey: 'CO_CHE_DAC_BIET', code: 'AM_HAN_LAI', label: 'Ân hạn lãi', sortOrder: 40 },
  { categoryKey: 'CO_CHE_DAC_BIET', code: 'TT_SOM', label: 'Thanh toán sớm', sortOrder: 50 },

  // ── Kênh chiến dịch ──
  { categoryKey: 'KEHOACH', code: 'zalo', label: 'Zalo', sortOrder: 10 },
  { categoryKey: 'KEHOACH', code: 'facebook', label: 'Facebook', sortOrder: 20 },
  { categoryKey: 'KEHOACH', code: 'tiktok', label: 'TikTok', sortOrder: 30 },
  { categoryKey: 'KEHOACH', code: 'sms', label: 'SMS', sortOrder: 40 },
  { categoryKey: 'KEHOACH', code: 'call', label: 'Gọi điện', sortOrder: 50 },
];

/**
 * Seed item mặc định cho các nhóm đã tồn tại — idempotent.
 * Không ghi đè item user đã tự thêm/sửa (chỉ tạo khi code chưa có trong nhóm).
 */
export async function seedMasterDataItems(
  orgId: string,
): Promise<{ created: number; existing: number }> {
  const categories = await prisma.masterDataCategory.findMany({
    where: { orgId },
    select: { id: true, key: true },
  });
  const byKey = new Map(categories.map((c) => [c.key, c.id]));
  let created = 0;
  let existing = 0;

  for (const def of DEFAULT_MASTER_DATA_ITEMS) {
    const categoryId = byKey.get(def.categoryKey);
    if (!categoryId) continue;
    const found = await prisma.masterData.findFirst({
      where: { categoryId, code: def.code },
      select: { id: true },
    });
    if (found) {
      existing += 1;
      continue;
    }
    await prisma.masterData.create({
      data: {
        orgId,
        categoryId,
        code: def.code,
        label: def.label,
        sortOrder: def.sortOrder,
        color: def.color ?? null,
        isActive: true,
      },
    });
    created += 1;
  }

  return { created, existing };
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