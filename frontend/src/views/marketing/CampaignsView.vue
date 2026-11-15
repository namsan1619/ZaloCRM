<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Nguyễn Tiến Lộc -->
<template>
  <div class="campaigns-view">
    <!-- ════════ Topbar ════════ -->
    <div class="mkt-top">
      <div>
        <div class="mtt">Chiến dịch</div>
        <div class="mts">
          Tracker chiến dịch marketing — theo dõi ngân sách, nguồn đối tượng (tệp KH + dự án)
          và KPI kết bạn / nhắn tin.
        </div>
      </div>
      <div class="actions">
        <button class="btn btn-primary btn-sm" @click="openCreate">
          <v-icon size="16">mdi-plus-circle-outline</v-icon> Tạo chiến dịch
        </button>
      </div>
    </div>

    <div class="mkt-body">
      <!-- ════════ Stats band ════════ -->
      <div class="mkt-stats stats-4">
        <div class="mstat">
          <div class="mv num">{{ stats.total.toLocaleString('vi-VN') }}</div>
          <div class="ml">Tổng chiến dịch</div>
        </div>
        <div class="mstat" :title="`Trong ${stats.loaded} chiến dịch đang tải`">
          <div class="mv num green">{{ stats.running.toLocaleString('vi-VN') }}</div>
          <div class="ml">Đang chạy</div>
        </div>
        <div class="mstat" :title="`Trong ${stats.loaded} chiến dịch đang tải`">
          <div class="mv num amber">{{ stats.completed.toLocaleString('vi-VN') }}</div>
          <div class="ml">Hoàn tất</div>
        </div>
        <div class="mstat" :title="`Ngân sách của ${stats.loaded} chiến dịch đang tải`">
          <div class="mv num">{{ formatVndCompact(stats.budget) }}</div>
          <div class="ml">Tổng ngân sách</div>
        </div>
      </div>

      <!-- ════════ Status tabs + search ════════ -->
      <div class="status-tabs">
        <button
          v-for="tab in STATUS_TABS"
          :key="tab.value"
          class="status-tab"
          :class="{ active: statusFilter === tab.value }"
          @click="onSwitchStatus(tab.value)"
        >
          <v-icon size="15">{{ tab.icon }}</v-icon>
          {{ tab.label }}
          <span v-if="tab.value === ''" class="count num">{{ total.toLocaleString('vi-VN') }}</span>
        </button>
        <div class="spacer"></div>
        <div class="field sm search">
          <v-icon size="15">mdi-magnify</v-icon>
          <input
            v-model="searchText"
            placeholder="Tìm tên chiến dịch..."
            @input="debouncedSearch"
          />
        </div>
      </div>

      <!-- ════════ Empty ════════ -->
      <div v-if="!loading && campaigns.length === 0" class="empty">
        <v-icon size="40">mdi-bullhorn-outline</v-icon>
        <h3>Chưa có chiến dịch nào</h3>
        <p>Bấm "Tạo chiến dịch" để lập kế hoạch với tệp khách hàng + dự án + kịch bản.</p>
      </div>

      <!-- ════════ Table ════════ -->
      <div v-else class="card table-card">
        <table class="tbl campaigns-table">
          <thead>
            <tr>
              <th>Tên chiến dịch</th>
              <th>Kênh</th>
              <th>Thời gian</th>
              <th class="right">Ngân sách</th>
              <th>Trạng thái</th>
              <th class="right"></th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="loading">
              <td colspan="6" class="empty-cell">
                <v-icon size="16" class="spin">mdi-loading</v-icon> Đang tải...
              </td>
            </tr>
            <template v-else>
              <tr
                v-for="c in campaigns"
                :key="c.id"
                class="row-clickable"
                @click="goDetail(c.id)"
              >
                <td class="cell-strong">{{ c.name }}</td>
                <td>
                  <span v-if="c.channelCode" class="chip chip-blue">
                    <v-icon size="12">mdi-bullhorn</v-icon> {{ channelLabel(c.channelCode) }}
                  </span>
                  <span v-else class="muted">—</span>
                </td>
                <td class="t-cap">
                  {{ fmtRange(c.startAt, c.endAt) }}
                </td>
                <td class="right num cell-strong">{{ formatVnd(c.costVnd) }}</td>
                <td>
                  <span class="chip" :class="statusChip(c.status)">
                    <span class="dot"></span>{{ statusLabel(c.status) }}
                  </span>
                </td>
                <td class="row-actions" @click.stop>
                  <button class="btn btn-ghost btn-icon btn-sm" title="Sửa" @click="openEdit(c)">
                    <v-icon size="15">mdi-pencil-outline</v-icon>
                  </button>
                  <button class="btn btn-ghost btn-icon btn-sm" title="Xoá" @click="confirmDelete(c)">
                    <v-icon size="15">mdi-delete-outline</v-icon>
                  </button>
                  <button class="btn btn-icon btn-sm go-arrow" title="Mở chi tiết">
                    <v-icon size="15">mdi-arrow-right</v-icon>
                  </button>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>

      <!-- ════════ Pagination ════════ -->
      <div v-if="total > limit" class="pager">
        <span class="pager-info">
          Hiện {{ pageStart.toLocaleString('vi-VN') }}–{{ pageEnd.toLocaleString('vi-VN') }}
          / {{ total.toLocaleString('vi-VN') }} chiến dịch
        </span>
        <div class="pager-ctrls">
          <button class="btn btn-ghost btn-sm" :disabled="page <= 1" @click="goPage(page - 1)">
            <v-icon size="14">mdi-chevron-left</v-icon> Trước
          </button>
          <span class="pager-cur num">Trang {{ page }}</span>
          <button class="btn btn-ghost btn-sm" :disabled="page * limit >= total" @click="goPage(page + 1)">
            Sau <v-icon size="14">mdi-chevron-right</v-icon>
          </button>
        </div>
      </div>
    </div>

    <CampaignFormDialog v-model="showForm" :campaign="editingCampaign" @saved="onSaved" />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import {
  useCampaigns,
  CAMPAIGN_STATUSES,
  type CampaignItem,
} from '@/composables/use-campaigns';
import { fetchMasterItems, formatVnd, formatVndCompact, type MasterOption } from '@/composables/use-properties';
import { formatInOrgTz } from '@/composables/use-org-timezone';
import { useToast } from '@/composables/use-toast';
import { useConfirm } from '@/composables/use-confirm';
import CampaignFormDialog from '@/components/marketing/CampaignFormDialog.vue';

const toast = useToast();
const { confirm } = useConfirm();
const router = useRouter();

const {
  campaigns,
  total,
  loading,
  page,
  limit,
  statusFilter,
  stats,
  fetchCampaigns,
  filterByStatus,
  search,
  goPage,
  deleteCampaign,
} = useCampaigns();

const showForm = ref(false);
const editingCampaign = ref<CampaignItem | null>(null);
const searchText = ref('');
const channelOptions = ref<MasterOption[]>([]);

const STATUS_TABS = [
  { value: '', label: 'Tất cả', icon: 'mdi-view-list' },
  { value: 'RUNNING', label: 'Đang chạy', icon: 'mdi-play-circle-outline' },
  { value: 'DRAFT', label: 'Nháp', icon: 'mdi-file-outline' },
  { value: 'COMPLETED', label: 'Hoàn tất', icon: 'mdi-check-circle-outline' },
];

const channelMap = computed(() => new Map(channelOptions.value.map((o) => [o.code, o.label])));
const pageStart = computed(() => (page.value - 1) * limit.value + 1);
const pageEnd = computed(() => Math.min(page.value * limit.value, total.value));

onMounted(async () => {
  await Promise.all([fetchCampaigns(), loadChannels()]);
});

async function loadChannels() {
  channelOptions.value = await fetchMasterItems('KEHOACH');
}

let searchTimer: ReturnType<typeof setTimeout> | null = null;
function debouncedSearch() {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => search(searchText.value), 300);
}

function onSwitchStatus(s: string) {
  filterByStatus(s);
}

function openCreate() {
  editingCampaign.value = null;
  showForm.value = true;
}

function openEdit(c: CampaignItem) {
  editingCampaign.value = c;
  showForm.value = true;
}

function onSaved() {
  fetchCampaigns();
}

function goDetail(id: string) {
  router.push(`/marketing/campaigns/${id}`);
}

async function confirmDelete(c: CampaignItem) {
  if (!(await confirm({
    title: `Xoá chiến dịch "${c.name}"?`,
    message: 'Thao tác không thể hoàn tác.',
    tone: 'danger',
    confirmText: 'Xoá',
    cancelText: 'Huỷ',
  }))) return;
  try {
    await deleteCampaign(c.id);
    toast.success('Đã xoá chiến dịch');
    fetchCampaigns();
  } catch (err) {
    const msg = (err as { response?: { data?: { error?: string } } }).response?.data?.error ?? 'Xoá thất bại';
    toast.error(msg, 5000);
  }
}

// ───────── Helpers ─────────
function channelLabel(code: string | null): string {
  if (!code) return '—';
  return channelMap.value.get(code) ?? code;
}

function statusLabel(status: string | null): string {
  const hit = CAMPAIGN_STATUSES.find((s) => s.value === status);
  return hit?.label ?? status ?? '—';
}

function statusChip(status: string | null): string {
  const hit = CAMPAIGN_STATUSES.find((s) => s.value === status);
  return hit?.chip ?? 'chip-grey';
}

function fmtRange(startAt: string | null, endAt: string | null): string {
  if (!startAt && !endAt) return '—';
  const s = startAt ? formatInOrgTz(startAt, undefined, { dateOnly: true }) : '…';
  const e = endAt ? formatInOrgTz(endAt, undefined, { dateOnly: true }) : '…';
  return s === e ? s : `${s} → ${e}`;
}
</script>

<style scoped>
/* Chiến dịch (CampaignsView) — scaffold .mkt-top/.mkt-body/.mkt-stats từ theme. */
.campaigns-view { background: var(--surface-2); min-height: 100%; }
.mkt-stats.stats-4 { grid-template-columns: repeat(4, 1fr); }
.mstat .mv.green { color: #157f3c; }
.mstat .mv.amber { color: #b45309; }

/* ───── Status tabs (copy ListsView) ───── */
.status-tabs {
  display: flex; align-items: center; gap: 4px; flex-wrap: wrap;
  background: var(--surface); border: 1px solid var(--line);
  border-radius: var(--r-md); padding: 6px; margin-bottom: 14px;
}
.status-tab {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 7px 12px; border-radius: var(--r-xs);
  background: transparent; border: none; cursor: pointer;
  font-size: 12.5px; font-weight: 500; color: var(--ink-2);
}
.status-tab:hover { background: var(--surface-3); color: var(--ink); }
.status-tab.active { background: var(--ink); color: #fff; }
.status-tab .count {
  background: var(--surface-3); color: var(--ink-2);
  padding: 0 6px; border-radius: var(--r-pill);
  font-size: 10.5px; font-weight: 700;
}
.status-tab.active .count { background: rgba(255,255,255,.18); color: #fff; }
.spacer { flex: 1; }
.search { min-width: 220px; }
.search select, .search input { border: none; background: transparent; outline: none; font-size: 12.5px; color: var(--ink); width: 100%; }

/* ───── Table ───── */
.table-card { overflow: auto; padding: 0; }
.campaigns-table th.right, .campaigns-table td.right { text-align: right; }
.campaigns-table .empty-cell { text-align: center; color: var(--ink-4); padding: 28px; }
.muted { color: var(--ink-4); font-size: 12px; }
.row-actions { text-align: right; white-space: nowrap; }
.row-actions .btn { margin-left: 2px; }
.go-arrow { background: var(--brand-soft); color: var(--brand-700); }

/* ───── Empty ───── */
.empty {
  background: var(--surface); border: 1px solid var(--line);
  border-radius: var(--r-lg); padding: 56px 24px; margin-top: 4px;
  display: flex; flex-direction: column; align-items: center; text-align: center;
}
.empty .v-icon { color: var(--ink-4); }
.empty h3 { margin: 12px 0 6px; color: var(--ink); font-size: 16px; font-weight: 700; }
.empty p { margin: 0; font-size: 13px; color: var(--ink-3); }

/* ───── Pagination ───── */
.pager { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 12px; }
.pager-info { font-size: 12.5px; color: var(--ink-3); }
.pager-ctrls { display: flex; align-items: center; gap: 8px; }
.pager-cur { font-size: 12px; font-weight: 600; color: var(--ink-2); }
.btn[disabled] { opacity: .45; cursor: not-allowed; }
</style>