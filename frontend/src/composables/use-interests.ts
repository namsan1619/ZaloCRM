// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyễn Tiến Lộc
/**
 * use-interests.ts — "Sản phẩm quan tâm" của KH (ContactInterest) + tìm căn bảng hàng.
 *
 * Dùng cho widget "Sản phẩm quan tâm" (tab CRM, cột 4 chat) — sale gom các căn
 * KH quan tâm rồi gửi bảng hàng qua Zalo.
 *
 * API contract (BE CRM complete core):
 *   GET    /api/v1/contacts/:cid/interests                        → { interests: ContactInterest[] }
 *   POST   /api/v1/contacts/:cid/interests {propertyId?, ...}     → { interest }
 *   PUT    /api/v1/interests/:id {interestCode?, note?}            → { interest }
 *   DELETE /api/v1/interests/:id                                  → { deleted: true }
 *   GET    /api/v1/contacts/:cid/interests/suggestions?limit=5    → { suggestions: PropertyItem[] }
 *   GET    /api/v1/properties?q=<kw>&pageSize=<n>                 → { items: PropertyItem[] }
 *
 * Mọi hàm đọc response theo kiểu phòng thủ (nhiều shape khả dĩ) — cùng pattern
 * `pickList` của use-properties.ts.
 */
import { ref } from 'vue';
import { api } from '@/api/index';

export interface InterestProject {
  id: string;
  name: string;
  developer?: string | null;
  province?: string | null;
}

/**
 * Căn (property) trả kèm trong contract interest — chỉ 1 phần field của bảng hàng
 * (BE chỉ select các cột cần cho UI cột 4).
 */
export interface InterestProperty {
  id: string;
  unitCode: string;
  blockName?: string | null;
  floorNo?: number | null;
  bedrooms?: number | null;
  propertyTypeCode?: string | null;
  statusCode?: string | null;
  priceVnd?: string | number | null;
  priceBasisCode?: string | null;
  project?: { id: string; name: string } | null;
}

export interface ContactInterest {
  id: string;
  contactId: string;
  propertyId: string | null;
  projectId: string | null;
  interestCode: string;
  note: string | null;
  source: string | null;
  createdAt: string;
  property?: InterestProperty | null;
  project?: InterestProject | null;
}

export interface InterestPayload {
  propertyId?: string | null;
  projectId?: string | null;
  interestCode?: string;
  note?: string | null;
  source?: string;
}

/** Đọc danh sách từ response có nhiều shape khả dĩ (items/list/interests/...). */
function pickList<T>(data: unknown, keys: string[]): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === 'object') {
    const rec = data as Record<string, unknown>;
    for (const k of keys) {
      if (Array.isArray(rec[k])) return rec[k] as T[];
    }
  }
  return [];
}

function errorMessage(e: unknown, fallback: string): string {
  const err = e as { response?: { data?: { error?: string } }; message?: string };
  return err?.response?.data?.error || err?.message || fallback;
}

export function useInterests() {
  const interests = ref<ContactInterest[]>([]);
  const suggestions = ref<InterestProperty[]>([]);
  const loading = ref(false);
  const saving = ref(false);
  const error = ref<string | null>(null);

  /** Danh sách sản phẩm quan tâm của 1 KH. */
  async function fetchInterests(contactId: string): Promise<ContactInterest[]> {
    if (!contactId) {
      interests.value = [];
      return [];
    }
    loading.value = true;
    error.value = null;
    try {
      const res = await api.get(`/contacts/${contactId}/interests`);
      interests.value = pickList<ContactInterest>(res.data, ['interests', 'items', 'list']);
    } catch (e) {
      console.error('[interests] fetchInterests failed:', e);
      error.value = errorMessage(e, 'Không tải được sản phẩm quan tâm');
      interests.value = [];
    } finally {
      loading.value = false;
    }
    return interests.value;
  }

  /** Thêm 1 sản phẩm quan tâm. Sau khi tạo → refetch để list đúng thứ tự BE trả. */
  async function createInterest(contactId: string, payload: InterestPayload): Promise<ContactInterest | null> {
    saving.value = true;
    error.value = null;
    try {
      const res = await api.post(`/contacts/${contactId}/interests`, payload);
      const created = (res.data?.interest ?? res.data) as ContactInterest | undefined;
      if (contactId) await fetchInterests(contactId);
      return created ?? null;
    } catch (e) {
      console.error('[interests] createInterest failed:', e);
      error.value = errorMessage(e, 'Không thêm được sản phẩm quan tâm');
      return null;
    } finally {
      saving.value = false;
    }
  }

  /** Cập nhật trạng thái quan tâm / ghi chú của 1 dòng. */
  async function updateInterest(id: string, payload: Partial<InterestPayload>): Promise<ContactInterest | null> {
    saving.value = true;
    error.value = null;
    try {
      const res = await api.put(`/interests/${id}`, payload);
      const updated = (res.data?.interest ?? res.data) as ContactInterest | undefined;
      if (updated) {
        const idx = interests.value.findIndex((i) => i.id === id);
        if (idx !== -1) interests.value.splice(idx, 1, { ...interests.value[idx], ...updated });
      }
      return updated ?? null;
    } catch (e) {
      console.error('[interests] updateInterest failed:', e);
      error.value = errorMessage(e, 'Không cập nhật được sản phẩm quan tâm');
      return null;
    } finally {
      saving.value = false;
    }
  }

  /** Xoá 1 dòng quan tâm. */
  async function deleteInterest(id: string): Promise<boolean> {
    saving.value = true;
    error.value = null;
    try {
      await api.delete(`/interests/${id}`);
      interests.value = interests.value.filter((i) => i.id !== id);
      return true;
    } catch (e) {
      console.error('[interests] deleteInterest failed:', e);
      error.value = errorMessage(e, 'Không xoá được sản phẩm quan tâm');
      return false;
    } finally {
      saving.value = false;
    }
  }

  /** BE gợi ý các căn nên giới thiệu cho KH (theo lịch sử + giá + dự án). */
  async function fetchSuggestions(contactId: string, limit = 5): Promise<InterestProperty[]> {
    if (!contactId) {
      suggestions.value = [];
      return [];
    }
    try {
      const res = await api.get(`/contacts/${contactId}/interests/suggestions`, { params: { limit } });
      suggestions.value = pickList<InterestProperty>(res.data, ['suggestions', 'items', 'list']);
    } catch (e) {
      console.error('[interests] fetchSuggestions failed:', e);
      suggestions.value = [];
    }
    return suggestions.value;
  }

  /** Tìm căn trong bảng hàng (GET /properties?q=). */
  async function searchProperties(q: string, pageSize = 8): Promise<InterestProperty[]> {
    const keyword = (q || '').trim();
    if (!keyword) return [];
    try {
      const res = await api.get('/properties', { params: { q: keyword, pageSize } });
      return pickList<InterestProperty>(res.data, ['items', 'properties', 'list']);
    } catch (e) {
      console.error('[interests] searchProperties failed:', e);
      return [];
    }
  }

  return {
    interests,
    suggestions,
    loading,
    saving,
    error,
    fetchInterests,
    createInterest,
    updateInterest,
    deleteInterest,
    fetchSuggestions,
    searchProperties,
  };
}
