// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyễn Tiến Lộc
/**
 * Composable cho Đại lý (Agency / P3).
 * CRUD + list có phân trang + tìm kiếm. Contract:
 *  - GET/POST /api/v1/agencies
 *  - PUT/DELETE /api/v1/agencies/:id
 */
import { ref } from 'vue';
import { api } from '@/api/index';
import { pickList, pickTotal } from '@/composables/use-properties';

export interface AgencyItem {
  id: string;
  orgId: string;
  code: string;
  name: string;
  phone: string | null;
  contactName: string | null;
  note: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AgencyPayload {
  code: string;
  name: string;
  phone?: string | null;
  contactName?: string | null;
  note?: string | null;
  isActive?: boolean;
}

export function useAgencies() {
  const agencies = ref<AgencyItem[]>([]);
  const total = ref(0);
  const loading = ref(false);
  const q = ref('');
  const page = ref(1);
  const limit = ref(50);

  async function fetchAgencies() {
    loading.value = true;
    try {
      const res = await api.get('/agencies', {
        params: { q: q.value || undefined, page: page.value, limit: limit.value },
      });
      const data = res.data;
      agencies.value = pickList<AgencyItem>(data, ['agencies', 'items', 'list']);
      total.value = pickTotal(data);
    } catch (err) {
      console.error('[agencies] fetchAgencies failed:', err);
      agencies.value = [];
      total.value = 0;
    } finally {
      loading.value = false;
    }
  }

  function search(text: string) {
    q.value = text;
    page.value = 1;
    return fetchAgencies();
  }

  function goPage(p: number) {
    page.value = p;
    return fetchAgencies();
  }

  async function createAgency(payload: AgencyPayload): Promise<AgencyItem | null> {
    try {
      const res = await api.post('/agencies', payload);
      return res.data?.agency ?? res.data ?? null;
    } catch (err) {
      console.error('[agencies] createAgency failed:', err);
      throw err;
    }
  }

  async function updateAgency(id: string, payload: AgencyPayload): Promise<AgencyItem | null> {
    try {
      const res = await api.put(`/agencies/${id}`, payload);
      return res.data?.agency ?? res.data ?? null;
    } catch (err) {
      console.error('[agencies] updateAgency failed:', err);
      throw err;
    }
  }

  async function deleteAgency(id: string): Promise<void> {
    await api.delete(`/agencies/${id}`);
  }

  return {
    agencies,
    total,
    loading,
    q,
    page,
    limit,
    fetchAgencies,
    search,
    goPage,
    createAgency,
    updateAgency,
    deleteAgency,
  };
}