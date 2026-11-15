// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyễn Tiến Lộc
/**
 * use-master-data.ts — Danh mục dùng chung (MasterData) cho CRM.
 *
 * Nền tảng P1: thay enum cứng / string tự do bằng nhóm (category) + mã (code)
 * ổn định + nhãn tiếng Việt. Dùng chung cho Khách hàng (NGUON_KH, TRANG_THAI_KH)
 * và Bảng hàng (LOAI_CAN, HUONG, VIEW, DAI_LY…).
 *
 * API (xem phase-01-master-data-tuy-chon.md):
 *   GET    /settings/master-data/categories
 *   GET    /settings/master-data/items?categoryKey=&q=
 *   POST   /settings/master-data/items
 *   PUT    /settings/master-data/items/:id
 *   DELETE /settings/master-data/items/:id
 *   POST   /settings/master-data/reorder
 *
 * State đặt ở composable (không tạo Pinia store mới — quy ước repo).
 */
import { ref } from 'vue';
import { api } from '@/api/index';

export interface MasterDataCategory {
  id: string;
  key: string;
  label: string;
  icon?: string | null;
  sortOrder: number;
  isSystem: boolean;
}

export interface MasterDataItem {
  id: string;
  categoryId: string;
  categoryKey?: string;
  code: string;
  label: string;
  parentCode?: string | null;
  sortOrder: number;
  color?: string | null;
  isActive: boolean;
  metadata?: Record<string, unknown> | null;
}

/** Payload tạo/sửa item. `categoryKey` bắt buộc khi tạo. */
export interface MasterDataItemPayload {
  categoryKey?: string;
  code: string;
  label: string;
  parentCode?: string | null;
  sortOrder?: number;
  color?: string | null;
  isActive?: boolean;
  metadata?: Record<string, unknown> | null;
}

export function useMasterData() {
  const categories = ref<MasterDataCategory[]>([]);
  /** items theo categoryKey — dùng để lookup nhanh (vd TRANG_THAI_KH). */
  const itemsByCategory = ref<Record<string, MasterDataItem[]>>({});
  const loading = ref(false);
  const saving = ref(false);
  const error = ref('');

  /** Nhóm đang chọn (dùng cho form tạo mới). */
  const activeCategoryKey = ref('');

  async function fetchCategories(): Promise<MasterDataCategory[]> {
    loading.value = true;
    error.value = '';
    try {
      const res = await api.get('/settings/master-data/categories');
      categories.value = (res.data?.categories ?? res.data ?? []) as MasterDataCategory[];
      return categories.value;
    } catch (err) {
      console.error('[master-data] fetchCategories failed:', err);
      error.value = 'Không tải được nhóm danh mục';
      return [];
    } finally {
      loading.value = false;
    }
  }

  /**
   * Lấy items của 1 nhóm.
   * @param categoryKey rỗng → lấy tất cả items (backend hỗ trợ bỏ filter).
   * @param q từ khoá tìm trong code/label.
   */
  async function fetchItems(categoryKey: string, q = ''): Promise<MasterDataItem[]> {
    loading.value = true;
    error.value = '';
    if (categoryKey) activeCategoryKey.value = categoryKey;
    try {
      const res = await api.get('/settings/master-data/items', {
        params: { categoryKey: categoryKey || undefined, q: q || undefined },
      });
      const items = (res.data?.items ?? res.data ?? []) as MasterDataItem[];
      if (categoryKey) itemsByCategory.value = { ...itemsByCategory.value, [categoryKey]: items };
      return items;
    } catch (err) {
      console.error('[master-data] fetchItems failed:', err);
      error.value = 'Không tải được danh mục';
      return [];
    } finally {
      loading.value = false;
    }
  }

  /** Items đã cache của 1 nhóm (không gọi API). */
  function itemsOf(categoryKey: string): MasterDataItem[] {
    return itemsByCategory.value[categoryKey] ?? [];
  }

  async function createItem(payload: MasterDataItemPayload): Promise<MasterDataItem | null> {
    saving.value = true;
    error.value = '';
    try {
      const res = await api.post('/settings/master-data/items', payload);
      const item = (res.data?.item ?? res.data) as MasterDataItem;
      if (payload.categoryKey) await fetchItems(payload.categoryKey);
      return item;
    } catch (err) {
      console.error('[master-data] createItem failed:', err);
      error.value = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
        || 'Tạo danh mục thất bại';
      return null;
    } finally {
      saving.value = false;
    }
  }

  async function updateItem(id: string, payload: Partial<MasterDataItemPayload>, categoryKey?: string): Promise<MasterDataItem | null> {
    saving.value = true;
    error.value = '';
    try {
      const res = await api.put(`/settings/master-data/items/${id}`, payload);
      const item = (res.data?.item ?? res.data) as MasterDataItem;
      const refreshKey = categoryKey
        ?? payload.categoryKey
        ?? itemsOf(activeCategoryKey.value).find((i) => i.id === id)?.categoryKey
        ?? activeCategoryKey.value;
      if (refreshKey) await fetchItems(refreshKey);
      return item;
    } catch (err) {
      console.error('[master-data] updateItem failed:', err);
      error.value = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
        || 'Cập nhật danh mục thất bại';
      return null;
    } finally {
      saving.value = false;
    }
  }

  async function deleteItem(id: string, categoryKey?: string): Promise<boolean> {
    saving.value = true;
    error.value = '';
    try {
      await api.delete(`/settings/master-data/items/${id}`);
      const key = categoryKey ?? itemsOf(activeCategoryKey.value).find((i) => i.id === id)?.categoryKey ?? activeCategoryKey.value;
      if (key) await fetchItems(key);
      return true;
    } catch (err) {
      console.error('[master-data] deleteItem failed:', err);
      error.value = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
        || 'Xóa danh mục thất bại';
      return false;
    } finally {
      saving.value = false;
    }
  }

  /**
   * Đổi thứ tự items của 1 nhóm.
   * Body theo contract backend (POST /settings/master-data/reorder):
   *   { items: [{ id, sortOrder }] } — BE validate sortOrder là number.
   */
  async function reorderItems(categoryKey: string, orderedIds: string[]): Promise<boolean> {
    saving.value = true;
    error.value = '';
    try {
      await api.post('/settings/master-data/reorder', {
        items: orderedIds.map((id, index) => ({ id, sortOrder: index + 1 })),
      });
      await fetchItems(categoryKey);
      return true;
    } catch (err) {
      console.error('[master-data] reorderItems failed:', err);
      error.value = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
        || 'Đổi thứ tự thất bại';
      return false;
    } finally {
      saving.value = false;
    }
  }

  return {
    categories,
    itemsByCategory,
    activeCategoryKey,
    loading,
    saving,
    error,
    fetchCategories,
    fetchItems,
    itemsOf,
    createItem,
    updateItem,
    deleteItem,
    reorderItems,
  };
}
