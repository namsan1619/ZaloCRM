// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyễn Tiến Lộc
/**
 * master-data-seed-items.test.ts — seed item mặc định idempotent.
 *
 * Rủi ro chính: seed chạy mỗi lần GET /categories → phải KHÔNG tạo trùng item,
 * và phải tạo đủ item cho các nhóm mà UI dùng (rating A/B/C/D, trạng thái căn
 * AVAILABLE/ON_HOLD/..., kênh chiến dịch, cơ chế đặc biệt).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const masterDataCreate = vi.fn();
const masterDataFindFirst = vi.fn();
const masterDataFindMany = vi.fn();
const categoryFindMany = vi.fn();
const categoryCreate = vi.fn();
const categoryFindManySeed = vi.fn();

vi.mock('../src/shared/database/prisma-client.js', () => ({
  prisma: {
    masterData: {
      create: (...args: unknown[]) => masterDataCreate(...args),
      findFirst: (...args: unknown[]) => masterDataFindFirst(...args),
      findMany: (...args: unknown[]) => masterDataFindMany(...args),
    },
    masterDataCategory: {
      create: (...args: unknown[]) => categoryCreate(...args),
      findMany: (...args: unknown[]) => categoryFindManySeed(...args),
    },
  },
}));

import {
  DEFAULT_MASTER_DATA_CATEGORIES,
  DEFAULT_MASTER_DATA_ITEMS,
  seedMasterDataCategories,
  seedMasterDataItems,
} from '../src/modules/master-data/master-data-seed.js';

const ORG = 'org-1';

describe('seedMasterDataItems', () => {
  beforeEach(() => {
    masterDataCreate.mockReset();
    masterDataFindFirst.mockReset();
    categoryFindManySeed.mockReset();
    masterDataCreate.mockResolvedValue({});
    masterDataFindFirst.mockResolvedValue(null);
    categoryFindManySeed.mockResolvedValue([
      { id: 'cat-nguon', key: 'NGUON_KH' },
      { id: 'cat-trangthai', key: 'TRANG_THAI_KH' },
      { id: 'cat-can', key: 'TRANG_THAI_CAN' },
      { id: 'cat-ke', key: 'KEHOACH' },
      { id: 'cat-co-che', key: 'CO_CHE_DAC_BIET' },
    ]);
  });

  it('tạo item cho các nhóm có trong DB', async () => {
    const res = await seedMasterDataItems(ORG);
    const mockedKeys = ['NGUON_KH', 'TRANG_THAI_KH', 'TRANG_THAI_CAN', 'KEHOACH', 'CO_CHE_DAC_BIET'];
    const expected = DEFAULT_MASTER_DATA_ITEMS.filter((i) => mockedKeys.includes(i.categoryKey)).length;
    expect(res.created).toBe(expected);
    expect(res.existing).toBe(0);
    expect(masterDataCreate).toHaveBeenCalledTimes(expected);
  });

  it('bỏ qua nhóm không tồn tại trong org', async () => {
    categoryFindManySeed.mockResolvedValue([{ id: 'cat-trangthai', key: 'TRANG_THAI_KH' }]);
    const res = await seedMasterDataItems(ORG);
    const expected = DEFAULT_MASTER_DATA_ITEMS.filter((i) => i.categoryKey === 'TRANG_THAI_KH').length;
    expect(res.created).toBe(expected);
  });

  it('idempotent — không tạo lại item đã tồn tại', async () => {
    masterDataFindFirst.mockResolvedValue({ id: 'existing' });
    const res = await seedMasterDataItems(ORG);
    const mockedKeys = ['NGUON_KH', 'TRANG_THAI_KH', 'TRANG_THAI_CAN', 'KEHOACH', 'CO_CHE_DAC_BIET'];
    const expected = DEFAULT_MASTER_DATA_ITEMS.filter((i) => mockedKeys.includes(i.categoryKey)).length;
    expect(res.created).toBe(0);
    expect(res.existing).toBe(expected);
    expect(masterDataCreate).not.toHaveBeenCalled();
  });

  it('có item mức đánh giá A/B/C/D để validate ratingCode', () => {
    const codes = DEFAULT_MASTER_DATA_ITEMS
      .filter((i) => i.categoryKey === 'TRANG_THAI_KH')
      .map((i) => i.code);
    expect(codes).toEqual(['A', 'B', 'C', 'D']);
  });

  it('có item trạng thái căn khớp default Property.statusCode = AVAILABLE', () => {
    const codes = DEFAULT_MASTER_DATA_ITEMS
      .filter((i) => i.categoryKey === 'TRANG_THAI_CAN')
      .map((i) => i.code);
    expect(codes).toContain('AVAILABLE');
    expect(codes).toContain('ON_HOLD');
    expect(codes).toContain('SOLD');
  });

  it('có nhóm kênh chiến dịch + cơ chế đặc biệt (UI dùng)', () => {
    const catKeys = DEFAULT_MASTER_DATA_CATEGORIES.map((c) => c.key);
    expect(catKeys).toContain('KEHOACH');
    expect(catKeys).toContain('CO_CHE_DAC_BIET');
    const itemKeys = new Set(DEFAULT_MASTER_DATA_ITEMS.map((i) => i.categoryKey));
    expect(itemKeys.has('KEHOACH')).toBe(true);
    expect(itemKeys.has('CO_CHE_DAC_BIET')).toBe(true);
  });
});

describe('seedMasterDataCategories', () => {
  beforeEach(() => {
    categoryFindManySeed.mockReset();
    categoryCreate.mockReset();
    categoryFindManySeed.mockResolvedValue([]);
    categoryCreate.mockImplementation(async ({ data }: { data: { key: string } }) => ({
      id: `cat-${data.key}`,
      ...data,
    }));
  });

  it('tạo nhóm còn thiếu, không ghi đè nhóm đã có', async () => {
    categoryFindManySeed.mockResolvedValue([{ id: 'cat-1', key: 'NGUON_KH', label: 'Nguồn KH' }]);
    const res = await seedMasterDataCategories(ORG);
    expect(res.existing).toBe(1);
    expect(res.created).toBe(DEFAULT_MASTER_DATA_CATEGORIES.length - 1);
  });
});
