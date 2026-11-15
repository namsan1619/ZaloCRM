<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Nguyễn Tiến Lộc -->
<template>
  <div class="campaign-detail-view">
    <!-- Breadcrumb -->
    <div class="breadcrumb">
      <a @click="$router.push('/marketing/campaigns')">
        <v-icon size="14">mdi-bullhorn-outline</v-icon> Chiến dịch
      </a>
      <v-icon size="14" class="sep">mdi-chevron-right</v-icon>
      <span>{{ campaign?.name ?? '...' }}</span>
    </div>

    <div v-if="loadingDetail" class="load-row">
      <v-icon size="16" class="spin">mdi-loading</v-icon> Đang tải...
    </div>

    <template v-else-if="campaign">
      <!-- ════════ Hero ════════ -->
      <div class="detail-hero">
        <div class="hero-head">
          <div style="min-width:0; flex:1;">
            <h2>
              <span class="hero-ico"><v-icon size="20">mdi-bullhorn-outline</v-icon></span>
              <span class="title-text">{{ campaign.name }}</span>
              <span class="chip" :class="statusChip(campaign.status)">
                <span class="dot"></span>{{ statusLabel(campaign.status) }}
              </span>
            </h2>
            <div class="sub">
              <template v-if="campaign.channelCode">Kênh <b>{{ channelLabel }}</b> · </template>
              <template v-if="campaign.typeCode">Loại <b>{{ typeLabel }}</b> · </template>
              Thời gian
              <b>{{ fmtRange(campaign.startAt, campaign.endAt) }}</b>
            </div>
          </div>
          <div class="hero-actions">
            <button class="btn btn-ghost btn-sm" @click="openEdit">
              <v-icon size="15">mdi-pencil-outline</v-icon> Sửa
            </button>
            <v-menu>
              <template #activator="{ props: act }">
                <button v-bind="act" class="btn btn-ghost btn-sm">
                  <v-icon size="15">mdi-cog-outline</v-icon> Trạng thái
                  <v-icon size="13">mdi-chevron-down</v-icon>
                </button>
              </template>
              <v-list density="compact" min-width="180">
                <v-list-item
                  v-for="s in CAMPAIGN_STATUSES"
                  :key="s.value"
                  :disabled="s.value === campaign.status"
                  @click="onChangeStatus(s.value)"
                >
                  <v-list-item-title>{{ s.label }}</v-list-item-title>
                </v-list-item>
              </v-list>
            </v-menu>
            <button class="btn btn-primary btn-sm" :disabled="!canExport" @click="exportCsv">
              <v-icon size="15">mdi-download</v-icon> Export CSV
            </button>
          </div>
        </div>
      </div>

      <!-- ════════ KPI cards ════════ -->
      <div class="mkt-stats stats-5">
        <div class="mstat">
          <div class="mv num">{{ (campaignStats?.totalContacts ?? 0).toLocaleString('vi-VN') }}</div>
          <div class="ml">Tổng KH</div>
        </div>
        <div class="mstat">
          <div class="mv num blue">{{ (campaignStats?.friendRequestsSent ?? 0).toLocaleString('vi-VN') }}</div>
          <div class="ml">Đã gửi kết bạn</div>
        </div>
        <div class="mstat">
          <div class="mv num green">{{ (campaignStats?.repliedContacts ?? 0).toLocaleString('vi-VN') }}</div>
          <div class="ml">Đã reply</div>
        </div>
        <div class="mstat">
          <div class="mv num amber">{{ campaignStats?.conversionRate != null ? `${Math.round(campaignStats.conversionRate * 100) / 100}%` : '—' }}</div>
          <div class="ml">Tỷ lệ chuyển đổi</div>
        </div>
        <div class="mstat">
          <div class="mv num">{{ formatVndCompact(campaign.costVnd) }}</div>
          <div class="ml">Ngân sách</div>
        </div>
      </div>

      <!-- ════════ Tệp KH + Dự án (các thẻ) ════════ -->
      <div class="scope-row">
        <div class="card card-pad scope-card">
          <h3 class="h-sec">
            <v-icon size="16">mdi-account-group-outline</v-icon> Tệp khách hàng
          </h3>
          <div v-if="(campaign.customerLists ?? []).length === 0" class="muted">Chưa chọn tệp KH</div>
          <div v-else class="scope-chips">
            <span v-for="cl in campaign.customerLists" :key="cl.id" class="chip chip-blue">
              <v-icon size="12">mdi-folder-outline</v-icon>
              {{ cl.customerList?.name ?? cl.customerListId }}
            </span>
          </div>
        </div>

        <div class="card card-pad scope-card">
          <h3 class="h-sec">
            <v-icon size="16">mdi-domain</v-icon> Dự án
          </h3>
          <div v-if="(campaign.projects ?? []).length === 0" class="muted">Chưa chọn dự án</div>
          <div v-else class="scope-chips">
            <span v-for="p in campaign.projects" :key="p.id" class="chip chip-purple">
              <v-icon size="12">mdi-office-building-outline</v-icon>
              {{ p.project?.name ?? p.projectId }}
            </span>
          </div>
        </div>

        <div class="card card-pad scope-card">
          <h3 class="h-sec">
            <v-icon size="16">mdi-script-text-outline</v-icon> Kịch bản
          </h3>
          <p v-if="campaign.script" class="script-text">{{ campaign.script }}</p>
          <div v-else class="muted">Chưa có kịch bản</div>
        </div>
      </div>

      <!-- ════════ Bảng KH ════════ -->
      <div class="card table-card contacts-block">
        <div class="block-head">
          <h3 class="h-sec">
            <v-icon size="16">mdi-account-multiple-outline</v-icon> Khách hàng trong chiến dịch
            <span v-if="statsLoading" class="spin small-spin"><v-icon size="13">mdi-loading</v-icon></span>
          </h3>
          <span v-if="campaignStats?.contacts.length" class="t-cap">
            {{ campaignStats.contacts.length.toLocaleString('vi-VN') }} dòng hiển thị
          </span>
        </div>
        <table class="tbl contacts-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Mã KH</th>
              <th>Tên</th>
              <th>SĐT</th>
              <th>Kết bạn</th>
              <th>Reply</th>
              <th>Trạng thái</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!contactRows.length && !statsLoading">
              <td colspan="7" class="empty-cell">
                Chưa có dữ liệu KH — mở chiến dịch khi đã chạy để xem trạng thái kết bạn / reply.
              </td>
            </tr>
            <tr v-for="(r, i) in displayRows" :key="r.contactId ?? i">
              <td class="num">{{ i + 1 }}</td>
              <td><span class="key-chip">{{ r.customerCode || '—' }}</span></td>
              <td class="cell-strong">{{ r.name || '—' }}</td>
              <td class="num">{{ r.phone || '—' }}</td>
              <td>
                <span class="chip" :class="friendChip(r.friendStatus)">
                  {{ friendLabel(r.friendStatus) }}
                </span>
              </td>
              <td>
                <span class="chip" :class="replyChip(r.replyStatus)">
                  {{ replyLabel(r.replyStatus) }}
                </span>
              </td>
              <td class="t-cap">{{ r.source ?? '—' }}</td>
            </tr>
          </tbody>
        </table>
        <div v-if="contactRows.length > MAX_ROWS" class="block-foot t-cap">
          Hiển thị {{ MAX_ROWS }}/{{ contactRows.length.toLocaleString('vi-VN') }} dòng đầu — dùng Export CSV để lấy đầy đủ.
        </div>
      </div>
    </template>

    <div v-else class="empty">
      <v-icon size="40">mdi-bullhorn-off-outline</v-icon>
      <h3>Không tìm thấy chiến dịch</h3>
      <p>Chiến dịch có thể đã bị xoá hoặc bạn không có quyền xem.</p>
    </div>

    <CampaignFormDialog v-model="showEdit" :campaign="campaign" @saved="onEdited" />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import {
  useCampaigns,
  CAMPAIGN_STATUSES,
  type CampaignStatus,
  type CampaignContactRow,
} from '@/composables/use-campaigns';
import { fetchMasterItems, formatVndCompact, type MasterOption } from '@/composables/use-properties';
import { formatInOrgTz } from '@/composables/use-org-timezone';
import { useToast } from '@/composables/use-toast';
import { useConfirm } from '@/composables/use-confirm';
import CampaignFormDialog from '@/components/marketing/CampaignFormDialog.vue';

const route = useRoute();
const toast = useToast();
const { confirm } = useConfirm();

const {
  currentCampaign: campaign,
  campaignStats,
  loadingDetail,
  loadingStats: statsLoading,
  fetchCampaignById,
  fetchCampaignStats,
  updateCampaignStatus,
} = useCampaigns();

const showEdit = ref(false);
const channelOptions = ref<MasterOption[]>([]);

const id = String(route.params.id ?? '');

const CAMPAIGN_STATUSES_TYPE = [
  { value: 'marketing', label: 'Marketing' },
  { value: 'care', label: 'Chăm sóc' },
  { value: 'friend_request', label: 'Kết bạn' },
  { value: 'message', label: 'Tin nhắn' },
];

const channelLabel = computed(() => {
  if (!campaign.value?.channelCode) return '—';
  const hit = channelOptions.value.find((o) => o.code === campaign.value?.channelCode);
  return hit?.label ?? campaign.value.channelCode;
});

const typeLabel = computed(() => {
  const t = campaign.value?.typeCode;
  if (!t) return '—';
  const hit = CAMPAIGN_STATUSES_TYPE.find((x) => x.value === t);
  return hit?.label ?? t;
});

/** Bảng KH — data thật từ stats.contacts (BE trả) + counters từ campaignStats. */
const contactRows = computed<CampaignContactRow[]>(() => campaignStats.value?.contacts ?? []);

/** Chỉ render 200 dòng đầu — dùng Export CSV để lấy đầy đủ. */
const MAX_ROWS = 200;
const displayRows = computed(() => contactRows.value.slice(0, MAX_ROWS));

const canExport = computed(() => contactRows.value.length > 0);

onMounted(async () => {
  await Promise.all([loadAll(), loadChannels()]);
});

async function loadAll() {
  await fetchCampaignById(id);
  await fetchCampaignStats(id);
}

async function loadChannels() {
  channelOptions.value = await fetchMasterItems('KEHOACH');
}

function openEdit() {
  showEdit.value = true;
}

function onEdited() {
  showEdit.value = false;
  loadAll();
}

async function onChangeStatus(status: CampaignStatus) {
  if (!campaign.value || status === campaign.value.status) return;
  if (!(await confirm({
    title: `Chuyển sang "${statusLabel(status)}"?`,
    message: 'Trạng thái chiến dịch sẽ được cập nhật.',
    confirmText: 'Cập nhật',
    cancelText: 'Huỷ',
  }))) return;
  try {
    await updateCampaignStatus(campaign.value.id, status);
    toast.success('Đã cập nhật trạng thái');
    await loadAll();
  } catch (err) {
    const msg = (err as { response?: { data?: { error?: string } } }).response?.data?.error ?? 'Cập nhật thất bại';
    toast.error(msg, 5000);
  }
}

/** Export CSV (client-side) từ dòng KH đang có — không gọi API thêm. */
function exportCsv() {
  const rows = contactRows.value;
  const header = ['Mã KH', 'Tên', 'SĐT', 'Kết bạn', 'Reply', 'Nguồn'];
  const lines = rows.map((r) => [
    r.customerCode ?? '',
    r.name ?? '',
    r.phone ?? '',
    friendLabel(r.friendStatus),
    replyLabel(r.replyStatus),
    r.source ?? '',
  ]);
  const esc = (s: string) => `"${String(s).replace(/"/g, '""')}"`;
  const csv = [header, ...lines].map((row) => row.map(esc).join(',')).join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `campaign-${campaign.value?.name ?? id}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  toast.success('Đã export CSV');
}

// ───────── Helpers ─────────
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

function friendLabel(s: string | null): string {
  if (!s) return '—';
  if (s === 'sent') return 'Đã gửi';
  if (s === 'accepted') return 'Đã kết bạn';
  if (s === 'pending') return 'Chờ';
  return s;
}

function friendChip(s: string | null): string {
  if (s === 'accepted') return 'chip-green';
  if (s === 'sent') return 'chip-blue';
  if (s === 'pending') return 'chip-amber';
  return 'chip-grey';
}

function replyLabel(s: string | null): string {
  if (!s) return '—';
  if (s === 'replied') return 'Đã reply';
  if (s === 'no_reply') return 'Chưa reply';
  if (s === 'needs_call') return 'Cần gọi';
  return s;
}

function replyChip(s: string | null): string {
  if (s === 'replied') return 'chip-green';
  if (s === 'needs_call') return 'chip-amber';
  if (s === 'no_reply') return 'chip-grey';
  return 'chip-grey';
}
</script>

<style scoped>
.campaign-detail-view { padding: 22px 24px; max-width: 100%; background: var(--surface-2); min-height: 100%; }
.breadcrumb { display: flex; align-items: center; gap: 6px; margin-bottom: 14px; font-size: 12px; color: var(--ink-3); }
.breadcrumb a { color: var(--brand); text-decoration: none; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; }
.breadcrumb a:hover { text-decoration: underline; }
.breadcrumb .sep { color: var(--ink-4); }

.load-row { display: flex; align-items: center; gap: 8px; color: var(--ink-3); padding: 24px; }

.detail-hero { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-lg); box-shadow: var(--sh-sm); padding: 18px 20px; margin-bottom: 16px; }
.hero-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 14px; flex-wrap: wrap; }
.hero-head h2 { margin: 0 0 4px; font-size: 18px; font-weight: 700; color: var(--ink); display: flex; align-items: center; gap: 8px; }
.hero-ico { width: 32px; height: 32px; border-radius: var(--r-sm); background: var(--brand-soft); color: var(--brand); display: inline-flex; align-items: center; justify-content: center; flex: none; }
.hero-head .sub { color: var(--ink-3); font-size: 12.5px; }
.hero-head .sub b { color: var(--ink); font-weight: 600; }
.hero-actions { display: flex; gap: 8px; flex-wrap: wrap; }

.mkt-stats.stats-5 { grid-template-columns: repeat(5, 1fr); margin-bottom: 16px; }
.mstat .mv.blue { color: var(--brand-700); }
.mstat .mv.green { color: #157f3c; }
.mstat .mv.amber { color: #b45309; }

.scope-row { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 14px; margin-bottom: 16px; }
@media (max-width: 1100px) { .scope-row { grid-template-columns: 1fr; } }
.scope-card h3 { display: flex; align-items: center; gap: 7px; margin: 0 0 10px; }
.scope-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.script-text { margin: 0; font-size: 12.5px; color: var(--ink-2); line-height: 1.6; white-space: pre-wrap; }
.muted { color: var(--ink-4); font-size: 12px; }

.table-card { overflow: auto; padding: 0; }
.block-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 14px 18px 0; }
.block-head h3 { display: flex; align-items: center; gap: 7px; margin: 0; }
.small-spin { display: inline-flex; }
.contacts-table { margin-top: 8px; }
.contacts-table .empty-cell { text-align: center; color: var(--ink-4); padding: 28px; }
.block-foot { padding: 10px 18px 12px; text-align: right; }

.key-chip {
  display: inline-block; padding: 2px 8px; font-family: var(--mono); font-weight: 600;
  font-size: 11px; background: var(--surface-3); color: var(--ink);
  border-radius: var(--r-xs); letter-spacing: .5px;
}

.empty { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-lg); padding: 56px 24px; margin-top: 4px; display: flex; flex-direction: column; align-items: center; text-align: center; }
.empty .v-icon { color: var(--ink-4); }
.empty h3 { margin: 12px 0 6px; color: var(--ink); font-size: 16px; font-weight: 700; }
.empty p { margin: 0; font-size: 13px; color: var(--ink-3); }
</style>