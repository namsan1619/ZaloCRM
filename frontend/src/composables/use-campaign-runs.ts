// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyen Tien Loc
/**
 * Composable Đợt chạy (CampaignRun) + Kịch bản (CampaignScript) — P0 CRM 2026-11-16.
 *
 * Contract (backend song song):
 *  - GET    /api/v1/campaign-scripts?kind=&activeOnly=1 → { scripts: [...] }
 *  - POST   /api/v1/campaign-scripts                       {name,kind,content,mediaUrls?} → {script}
 *  - PUT    /api/v1/campaign-scripts/:id                   → {script}
 *  - DELETE /api/v1/campaign-scripts/:id                   → {deleted:true} (409 IN_USE)
 *  - GET    /api/v1/campaigns/:campaignId/runs             → { runs: [...] }
 *  - POST   /api/v1/campaigns/:campaignId/runs             {name,mode?,zaloAccountIds[],dailyFriendRequestLimit?,greetingScriptId?,careScriptIds?,careIntervalDays?} → {run}
 *  - POST   /api/v1/campaign-runs/:id/start|pause|resume|cancel → {run} (409 sai trạng thái)
 *  - GET    /api/v1/campaign-runs/:id                      → {run, counts:{byState:{}}, nickBudget:[...]}
 *  - GET    /api/v1/campaign-runs/:id/contacts?state=&page=&pageSize=50 → {contacts, total}
 *
 * Field name theo schema.prisma (CampaignScript / CampaignRun / CampaignContact) —
 * chỉ ĐỌC schema, không sửa. Helper thuần (runProgress/runActions/…) tách riêng để test.
 */
import { ref } from 'vue';
import { api } from '@/api/index';
import { pickList, pickTotal } from '@/composables/use-properties';

// ───────────────────────── Types ─────────────────────────
export type RunMode = 'friend_request' | 'care';
export type RunStatus = 'DRAFT' | 'RUNNING' | 'PAUSED' | 'DONE' | 'CANCELLED' | 'FAILED';

/** CampaignScript.kind trong schema: friend_request | greeting | care */
export type ScriptKind = 'friend_request' | 'greeting' | 'care';

export interface CampaignScriptItem {
  id: string;
  orgId?: string;
  name: string;
  kind: string;
  content: string;
  mediaUrls?: unknown;
  isActive: boolean;
  createdById?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CampaignRunItem {
  id: string;
  orgId?: string;
  campaignId: string;
  name: string;
  mode: string; // friend_request | care
  status: string; // DRAFT | RUNNING | PAUSED | DONE | CANCELLED | FAILED
  zaloAccountIds: string[] | null;
  dailyFriendRequestLimit: number | null;
  greetingScriptId: string | null;
  greetingScriptText: string | null;
  careScriptIds: string[] | null;
  careIntervalDays: number | null;
  configuredTotal: number;
  queuedCount: number;
  sentCount: number;
  acceptedCount: number;
  repliedCount: number;
  noZaloCount: number;
  failedCount: number;
  skippedCount: number;
  startedAt: string | null;
  pausedAt: string | null;
  finishedAt: string | null;
  createdById?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RunNickBudget {
  zaloAccountId: string;
  displayName: string | null;
  usedToday: number;
  dailyLimit: number | null;
}

export interface RunDetail {
  run?: CampaignRunItem | null;
  counts?: { byState?: Record<string, number> } | null;
  nickBudget?: RunNickBudget[] | null;
}

/** CampaignContact.state trong schema (chỉ lọc những trạng thái có ý nghĩa hiển thị). */
export interface RunContactRow {
  id: string;
  contactId: string;
  fullName: string | null;
  phone: string | null;
  state: string;
  errorDetail: string | null;
  sentAt: string | null;
  acceptedAt: string | null;
  repliedAt: string | null;
  zaloAccountId: string | null;
}

export interface CreateRunPayload {
  name: string;
  mode?: RunMode;
  zaloAccountIds: string[];
  dailyFriendRequestLimit?: number | null;
  greetingScriptId?: string | null;
  careScriptIds?: string[];
  careIntervalDays?: number | null;
}

export interface ScriptPayload {
  name: string;
  kind: string;
  content: string;
  mediaUrls?: unknown;
  isActive?: boolean;
}

// ────────────────────── Const nhãn / chip ──────────────────────
export const RUN_STATUSES: { value: string; label: string; chip: string }[] = [
  { value: 'DRAFT', label: 'Nháp', chip: 'chip-grey' },
  { value: 'RUNNING', label: 'Đang chạy', chip: 'chip-green' },
  { value: 'PAUSED', label: 'Tạm dừng', chip: 'chip-amber' },
  { value: 'DONE', label: 'Hoàn tất', chip: 'chip-purple' },
  { value: 'CANCELLED', label: 'Đã huỷ', chip: 'chip-red' },
  { value: 'FAILED', label: 'Lỗi', chip: 'chip-red' },
];

export const RUN_MODES: { value: string; label: string; chip: string; icon: string }[] = [
  { value: 'friend_request', label: 'Kết bạn', chip: 'chip-blue', icon: 'mdi-account-plus-outline' },
  { value: 'care', label: 'Chăm sóc', chip: 'chip-purple', icon: 'mdi-hand-heart-outline' },
];

/** Chip lọc theo trạng thái KH trong đợt chạy (giá trị = CampaignContact.state). */
export const RUN_STATE_FILTERS: { value: string; label: string; chip: string }[] = [
  { value: '', label: 'Tất cả', chip: 'chip-grey' },
  { value: 'queued', label: 'Chờ gửi', chip: 'chip-grey' },
  { value: 'friend_request_sent', label: 'Đã gửi KB', chip: 'chip-blue' },
  { value: 'friend_request_accepted', label: 'Kết bạn', chip: 'chip-green' },
  { value: 'replied', label: 'Đã reply', chip: 'chip-purple' },
  { value: 'failed', label: 'Lỗi', chip: 'chip-red' },
  { value: 'no_zalo', label: 'Không có Zalo', chip: 'chip-amber' },
  { value: 'skipped', label: 'Bỏ qua', chip: 'chip-orange' },
];

export const SCRIPT_KINDS: { value: string; label: string; chip: string }[] = [
  { value: 'friend_request', label: 'Kết bạn', chip: 'chip-blue' },
  { value: 'greeting', label: 'Chào (greeting)', chip: 'chip-green' },
  { value: 'care', label: 'Chăm sóc', chip: 'chip-purple' },
];

// ─────────────────── Helper thuần (test được) ───────────────────
interface RunCountLike {
  queuedCount?: number;
  sentCount?: number;
  acceptedCount?: number;
  repliedCount?: number;
  failedCount?: number;
  noZaloCount?: number;
  skippedCount?: number;
  configuredTotal?: number;
}

/**
 * Tiến độ đợt chạy — theo spec: tổng 7 counters trên configuredTotal.
 * configuredTotal = 0 (chưa start) → pct 0, không chia cho 0.
 */
export function runProgress(run: RunCountLike): { completed: number; total: number; pct: number } {
  const completed =
    Number(run.queuedCount ?? 0) +
    Number(run.sentCount ?? 0) +
    Number(run.acceptedCount ?? 0) +
    Number(run.repliedCount ?? 0) +
    Number(run.failedCount ?? 0) +
    Number(run.noZaloCount ?? 0) +
    Number(run.skippedCount ?? 0);
  const total = Number(run.configuredTotal ?? 0);
  const pct = total > 0 ? Math.min(100, Math.max(0, Math.round((completed / total) * 100))) : 0;
  return { completed, total, pct };
}

/** Nút nào được phép bấm theo trạng thái đợt chạy (backend vẫn enforce 409). */
export function runActions(run: { status?: string | null }): {
  start: boolean;
  pause: boolean;
  resume: boolean;
  cancel: boolean;
} {
  const s = run.status ?? 'DRAFT';
  return {
    start: s === 'DRAFT' || s === 'FAILED',
    pause: s === 'RUNNING',
    resume: s === 'PAUSED',
    cancel: s === 'DRAFT' || s === 'RUNNING' || s === 'PAUSED',
  };
}

/** Map state → label (đã biết) hoặc giữ nguyên raw. */
export function runStateLabel(state: string): string {
  const hit = RUN_STATE_FILTERS.find((f) => f.value === state);
  if (hit) return hit.label;
  if (state === 'greeting_sent') return 'Đã gửi chào';
  if (state === 'care_sent') return 'Đã chăm sóc';
  return state;
}

/** Map state → chip class; state lạ → chip-grey. */
export function runStateChip(state: string): string {
  const hit = RUN_STATE_FILTERS.find((f) => f.value === state);
  return hit?.chip ?? 'chip-grey';
}

/**
 * Số lượng theo từng state của run: ưu tiên counts.byState (BE tính live), nếu
 * thiếu thì fallback sang 7 counters trên chính run row.
 */
export function stateCounts(
  run: RunCountLike,
  byState?: Record<string, number> | null,
): Record<string, number> {
  const fallback: Record<string, number> = {
    queued: Number(run.queuedCount ?? 0),
    friend_request_sent: Number(run.sentCount ?? 0),
    friend_request_accepted: Number(run.acceptedCount ?? 0),
    replied: Number(run.repliedCount ?? 0),
    failed: Number(run.failedCount ?? 0),
    no_zalo: Number(run.noZaloCount ?? 0),
    skipped: Number(run.skippedCount ?? 0),
  };
  if (!byState || typeof byState !== 'object') return fallback;
  return { ...fallback, ...byState };
}

// ─────────────────────── Composable ───────────────────────
export function useCampaignRuns() {
  const loadingRuns = ref(false);

  // ───────── Runs ─────────
  async function fetchRuns(campaignId: string): Promise<CampaignRunItem[]> {
    loadingRuns.value = true;
    try {
      const res = await api.get(`/campaigns/${campaignId}/runs`);
      return pickList<CampaignRunItem>(res.data, ['runs', 'items', 'list']);
    } catch (err) {
      console.error('[campaign-runs] fetchRuns failed:', err);
      return [];
    } finally {
      loadingRuns.value = false;
    }
  }

  async function createRun(campaignId: string, payload: CreateRunPayload): Promise<CampaignRunItem> {
    const res = await api.post(`/campaigns/${campaignId}/runs`, payload);
    return res.data?.run ?? res.data;
  }

  /** start | pause | resume | cancel — throw để view bắt lỗi (409 sai trạng thái...). */
  async function runAction(id: string, action: 'start' | 'pause' | 'resume' | 'cancel'): Promise<CampaignRunItem> {
    const res = await api.post(`/campaign-runs/${id}/${action}`);
    return res.data?.run ?? res.data;
  }

  async function fetchRunDetail(id: string): Promise<RunDetail | null> {
    try {
      const res = await api.get(`/campaign-runs/${id}`);
      return res.data ?? null;
    } catch (err) {
      console.error('[campaign-runs] fetchRunDetail failed:', err);
      return null;
    }
  }

  async function fetchRunContacts(
    id: string,
    params: { state?: string; page?: number; pageSize?: number } = {},
  ): Promise<{ contacts: RunContactRow[]; total: number }> {
    const res = await api.get(`/campaign-runs/${id}/contacts`, {
      params: {
        state: params.state || undefined,
        page: params.page ?? 1,
        pageSize: params.pageSize ?? 50,
      },
    });
    const data = res.data ?? {};
    return {
      contacts: pickList<RunContactRow>(data, ['contacts', 'rows', 'items']),
      total: pickTotal(data),
    };
  }

  // ───────── CampaignScript CRUD ─────────
  async function fetchScripts(opts?: { kind?: string; activeOnly?: boolean }): Promise<CampaignScriptItem[]> {
    try {
      const res = await api.get('/campaign-scripts', {
        params: {
          kind: opts?.kind || undefined,
          activeOnly: opts?.activeOnly ? '1' : undefined,
        },
      });
      return pickList<CampaignScriptItem>(res.data, ['scripts', 'items', 'list']);
    } catch (err) {
      console.error('[campaign-scripts] fetchScripts failed:', err);
      return [];
    }
  }

  async function createScript(payload: ScriptPayload): Promise<CampaignScriptItem> {
    const res = await api.post('/campaign-scripts', payload);
    return res.data?.script ?? res.data;
  }

  async function updateScript(id: string, payload: Partial<ScriptPayload>): Promise<CampaignScriptItem> {
    const res = await api.put(`/campaign-scripts/${id}`, payload);
    return res.data?.script ?? res.data;
  }

  async function deleteScript(id: string): Promise<void> {
    await api.delete(`/campaign-scripts/${id}`);
  }

  return {
    loadingRuns,
    fetchRuns,
    createRun,
    runAction,
    fetchRunDetail,
    fetchRunContacts,
    fetchScripts,
    createScript,
    updateScript,
    deleteScript,
  };
}