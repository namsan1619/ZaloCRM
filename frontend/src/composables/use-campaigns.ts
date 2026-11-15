// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyễn Tiến Lộc
/**
 * Composable cho Chiến dịch (Campaign / P4) — tracker, KHÔNG gửi thật.
 * Contract:
 *  - GET/POST /api/v1/campaigns
 *    create body: { name, channelCode, startAt, endAt, costVnd,
 *                   customerListIds[], projectIds[], script, note }
 *  - GET/PUT/DELETE /api/v1/campaigns/:id
 *  - PATCH /api/v1/campaigns/:id/status  body { status }
 *  - GET /api/v1/campaigns/:id/stats
 *    → { totalContacts, friendRequestsSent, repliedContacts, conversionRate, ... }
 */
import { ref, computed } from 'vue';
import { api } from '@/api/index';
import { pickList, pickTotal, toSafeNumber } from '@/composables/use-properties';

/** Status theo schema Campaign.status. */
export type CampaignStatus = 'DRAFT' | 'SCHEDULED' | 'RUNNING' | 'PAUSED' | 'COMPLETED';

export const CAMPAIGN_STATUSES: { value: CampaignStatus; label: string; chip: string }[] = [
  { value: 'DRAFT', label: 'Nháp', chip: 'chip-grey' },
  { value: 'SCHEDULED', label: 'Đã lên lịch', chip: 'chip-blue' },
  { value: 'RUNNING', label: 'Đang chạy', chip: 'chip-green' },
  { value: 'PAUSED', label: 'Tạm dừng', chip: 'chip-amber' },
  { value: 'COMPLETED', label: 'Hoàn tất', chip: 'chip-purple' },
];

export interface CampaignCustomerList {
  id: string;
  customerListId: string;
  customerList?: { id: string; name: string; totalEntries?: number } | null;
}

export interface CampaignProjectLink {
  id: string;
  projectId: string;
  project?: { id: string; name: string } | null;
}

export interface CampaignItem {
  id: string;
  name: string;
  channelCode: string | null;
  typeCode: string | null;
  startAt: string | null;
  endAt: string | null;
  costVnd: string | number | null;
  status: CampaignStatus | string;
  script: string | null;
  note: string | null;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
  customerLists?: CampaignCustomerList[];
  projects?: CampaignProjectLink[];
}

/** 1 dòng KH của chiến dịch (BE trả kèm trong stats nếu có). */
export interface CampaignContactRow {
  contactId: string;
  name: string | null;
  phone: string | null;
  customerCode: string | null;
  friendStatus: string | null;   // sent | accepted | pending | none
  replyStatus: string | null;    // replied | no_reply | needs_call
  source: string | null;
}

export interface CampaignStats {
  totalContacts: number;
  friendRequestsSent: number;
  repliedContacts: number;
  conversionRate: number;
  contacts: CampaignContactRow[];
}

export interface CampaignPayload {
  name: string;
  channelCode?: string | null;
  typeCode?: string | null;
  startAt?: string | null;
  endAt?: string | null;
  costVnd?: string | number | null;
  customerListIds?: string[];
  projectIds?: string[];
  script?: string | null;
  note?: string | null;
}

/** Tệp KH dùng làm nguồn đối tượng cho chiến dịch (options cho form). */
export interface CustomerListOption {
  id: string;
  name: string;
  totalEntries?: number;
}

/** Dự án liên quan tới chiến dịch (options cho form). */
export interface ProjectOption {
  id: string;
  name: string;
}

export function useCampaigns() {
  const campaigns = ref<CampaignItem[]>([]);
  const total = ref(0);
  const loading = ref(false);
  const page = ref(1);
  const limit = ref(50);
  const q = ref('');
  const statusFilter = ref<string>('');

  const currentCampaign = ref<CampaignItem | null>(null);
  const campaignStats = ref<CampaignStats | null>(null);
  const loadingDetail = ref(false);
  const loadingStats = ref(false);

  /**
   * Stats band — total lấy từ server (đúng theo bộ lọc), các số đếm khác
   * tính trên danh sách ĐÃ TẢI (thật, không phải fake).
   */
  const stats = computed(() => {
    const rows = campaigns.value;
    let budget = 0;
    let running = 0;
    let completed = 0;
    for (const c of rows) {
      const cost = toSafeNumber(c.costVnd);
      if (cost !== null) budget += cost;
      if (c.status === 'RUNNING') running++;
      if (c.status === 'COMPLETED') completed++;
    }
    return { total: total.value, loaded: rows.length, running, completed, budget };
  });

  // ───────── List ─────────
  async function fetchCampaigns() {
    loading.value = true;
    try {
      const res = await api.get('/campaigns', {
        params: {
          q: q.value || undefined,
          status: statusFilter.value || undefined,
          page: page.value,
          limit: limit.value,
        },
      });
      const data = res.data;
      campaigns.value = pickList<CampaignItem>(data, ['campaigns', 'items', 'list']);
      total.value = pickTotal(data);
    } catch (err) {
      console.error('[campaigns] fetchCampaigns failed:', err);
      campaigns.value = [];
      total.value = 0;
    } finally {
      loading.value = false;
    }
  }

  function search(text: string) {
    q.value = text;
    page.value = 1;
    return fetchCampaigns();
  }

  function filterByStatus(status: string) {
    statusFilter.value = status;
    page.value = 1;
    return fetchCampaigns();
  }

  function goPage(p: number) {
    page.value = p;
    return fetchCampaigns();
  }

  // ───────── Detail ─────────
  async function fetchCampaignById(id: string): Promise<CampaignItem | null> {
    loadingDetail.value = true;
    try {
      const res = await api.get(`/campaigns/${id}`);
      const data = res.data ?? {};
      currentCampaign.value = data.campaign ?? data;
      return currentCampaign.value;
    } catch (err) {
      console.error('[campaigns] fetchCampaignById failed:', err);
      currentCampaign.value = null;
      return null;
    } finally {
      loadingDetail.value = false;
    }
  }

  async function fetchCampaignStats(id: string): Promise<CampaignStats | null> {
    loadingStats.value = true;
    try {
      const res = await api.get(`/campaigns/${id}/stats`);
      const data = res.data ?? {};
      const contacts = pickList<CampaignContactRow>(data, ['contacts', 'rows', 'items']);
      campaignStats.value = {
        totalContacts: Number(data.totalContacts ?? contacts.length ?? 0),
        friendRequestsSent: Number(data.friendRequestsSent ?? 0),
        repliedContacts: Number(data.repliedContacts ?? 0),
        conversionRate: Number(data.conversionRate ?? 0),
        contacts,
      };
      return campaignStats.value;
    } catch (err) {
      console.error('[campaigns] fetchCampaignStats failed:', err);
      campaignStats.value = null;
      return null;
    } finally {
      loadingStats.value = false;
    }
  }

  // ───────── Mutations ─────────
  async function createCampaign(payload: CampaignPayload): Promise<CampaignItem | null> {
    try {
      const res = await api.post('/campaigns', payload);
      return res.data?.campaign ?? res.data ?? null;
    } catch (err) {
      console.error('[campaigns] createCampaign failed:', err);
      throw err;
    }
  }

  async function updateCampaign(id: string, payload: CampaignPayload): Promise<CampaignItem | null> {
    try {
      const res = await api.put(`/campaigns/${id}`, payload);
      return res.data?.campaign ?? res.data ?? null;
    } catch (err) {
      console.error('[campaigns] updateCampaign failed:', err);
      throw err;
    }
  }

  async function deleteCampaign(id: string): Promise<void> {
    await api.delete(`/campaigns/${id}`);
  }

  async function updateCampaignStatus(id: string, status: CampaignStatus): Promise<void> {
    await api.patch(`/campaigns/${id}/status`, { status });
  }

  // ───────── Options cho form ─────────
  const customerListOptions = ref<CustomerListOption[]>([]);
  const projectOptions = ref<ProjectOption[]>([]);

  /** Tải tệp KH (đang dùng) làm nguồn đối tượng. */
  async function fetchCustomerListOptions() {
    try {
      const res = await api.get('/customer-lists', {
        params: { status: 'active', limit: 200 },
      });
      customerListOptions.value = pickList<CustomerListOption>(res.data, ['lists', 'items', 'list']);
    } catch (err) {
      console.error('[campaigns] fetchCustomerListOptions failed:', err);
      customerListOptions.value = [];
    }
  }

  /** Tải dự án (đang hoạt động) làm options. */
  async function fetchProjectOptions() {
    try {
      const res = await api.get('/projects', { params: { limit: 200 } });
      projectOptions.value = pickList<ProjectOption>(res.data, ['projects', 'items', 'list']);
    } catch (err) {
      console.error('[campaigns] fetchProjectOptions failed:', err);
      projectOptions.value = [];
    }
  }

  return {
    campaigns,
    total,
    loading,
    page,
    limit,
    q,
    statusFilter,
    stats,
    currentCampaign,
    campaignStats,
    loadingDetail,
    loadingStats,
    customerListOptions,
    projectOptions,
    fetchCampaigns,
    search,
    filterByStatus,
    goPage,
    fetchCampaignById,
    fetchCampaignStats,
    createCampaign,
    updateCampaign,
    deleteCampaign,
    updateCampaignStatus,
    fetchCustomerListOptions,
    fetchProjectOptions,
  };
}