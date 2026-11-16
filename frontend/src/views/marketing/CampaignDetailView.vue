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

      <!-- ════════ Đợt chạy (Run) ════════ -->
      <div class="card card-pad runs-block">
        <div class="block-head runs-head">
          <h3 class="h-sec">
            <v-icon size="16">mdi-play-circle-outline</v-icon> Đợt chạy (Run)
            <span v-if="runsLoading && !polling" class="spin small-spin"><v-icon size="13">mdi-loading</v-icon></span>
            <span v-if="polling" class="poll-badge"><v-icon size="12">mdi-radar</v-icon> Đang theo dõi (5s)</span>
          </h3>
          <button class="btn btn-primary btn-sm" @click="openCreateRun">
            <v-icon size="15">mdi-plus-circle-outline</v-icon> Tạo đợt chạy
          </button>
        </div>

        <div v-if="!runsLoading && runs.length === 0" class="muted runs-empty">
          Chưa có đợt chạy nào — bấm "Tạo đợt chạy" để triển khai gửi kết bạn / chăm sóc KH trong chiến dịch.
        </div>

        <div v-else class="run-cards">
          <div v-for="run in runs" :key="run.id" class="run-card" @click="openRunDetail(run)">
            <div class="run-head">
              <span class="run-name">{{ run.name }}</span>
              <span class="chip" :class="modeChip(run.mode)">
                <v-icon size="12">{{ modeIcon(run.mode) }}</v-icon> {{ modeLabel(run.mode) }}
              </span>
              <span class="chip" :class="runStatusChip(run.status)">
                <span class="dot"></span>{{ runStatusLabel(run.status) }}
              </span>
            </div>
            <div class="run-progress">
              <div class="run-progress-bar">
                <div class="run-progress-fill" :style="{ width: runningProgress(run).pct + '%' }"></div>
              </div>
              <span class="run-progress-num num">
                {{ runningProgress(run).completed.toLocaleString('vi-VN') }} / {{ runningProgress(run).total.toLocaleString('vi-VN') }}
                ({{ runningProgress(run).pct }}%)
              </span>
            </div>
            <div class="run-meta t-cap">
              <span v-if="run.dailyFriendRequestLimit != null">Trần KB/ngày: <b class="num">{{ run.dailyFriendRequestLimit }}</b> · </span>
              <span>Nick: <b class="num">{{ (run.zaloAccountIds ?? []).length }}</b> · </span>
              <span>Tạo lúc {{ fmtDateTime(run.createdAt) }}</span>
            </div>
            <div class="run-actions" @click.stop>
              <button
                v-if="canRunAction(run, 'start')"
                class="btn btn-soft btn-sm"
                :disabled="busyRunId === run.id"
                @click="onRunAction(run, 'start')"
              >
                <v-icon size="14">mdi-play</v-icon> Start
              </button>
              <button
                v-if="canRunAction(run, 'pause')"
                class="btn btn-ghost btn-sm"
                :disabled="busyRunId === run.id"
                @click="onRunAction(run, 'pause')"
              >
                <v-icon size="14">mdi-pause</v-icon> Pause
              </button>
              <button
                v-if="canRunAction(run, 'resume')"
                class="btn btn-soft btn-sm"
                :disabled="busyRunId === run.id"
                @click="onRunAction(run, 'resume')"
              >
                <v-icon size="14">mdi-play</v-icon> Resume
              </button>
              <button
                v-if="canRunAction(run, 'cancel')"
                class="btn btn-danger-soft btn-sm"
                :disabled="busyRunId === run.id"
                @click="onRunAction(run, 'cancel')"
              >
                <v-icon size="14">mdi-stop</v-icon> Cancel
              </button>
            </div>
          </div>
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

    <!-- ════════ Dialog: Tạo đợt chạy ════════ -->
    <v-dialog v-model="showCreateRun" max-width="640">
      <v-card>
        <v-card-title>
          <v-icon size="18">mdi-play-circle-outline</v-icon> Tạo đợt chạy
        </v-card-title>
        <v-card-text>
          <v-text-field
            v-model="runForm.name"
            label="Tên đợt chạy *"
            placeholder="VD: Kết bạn nhóm khách hàng tháng 11"
          />

          <div class="mode-seg">
            <label class="mode-seg-label">Chế độ chạy</label>
            <v-btn-toggle v-model="runForm.mode" mandatory density="compact" color="primary" divided>
              <v-btn value="friend_request" size="small">
                <v-icon size="15" class="mr-1">mdi-account-plus-outline</v-icon> Kết bạn
              </v-btn>
              <v-btn value="care" size="small">
                <v-icon size="15" class="mr-1">mdi-hand-heart-outline</v-icon> Chăm sóc
              </v-btn>
            </v-btn-toggle>
          </div>

          <v-select
            v-model="runForm.zaloAccountIds"
            label="Nick Zalo tham gia *"
            :items="zaloAccounts"
            item-title="label"
            item-value="id"
            multiple
            chips
            closable-chips
            :loading="zaloLoading"
            hint="Chọn ít nhất 1 nick — đợt chạy sẽ chia việc gửi cho các nick này"
            persistent-hint
          />

          <v-text-field
            v-model="runForm.dailyFriendRequestLimit"
            label="Trần kết bạn / ngày (pacing)"
            type="number"
            min="1"
            hint="Để trống = theo cài đặt SDK / trần an toàn của nick"
            persistent-hint
          />

          <v-select
            v-if="runForm.mode === 'friend_request'"
            v-model="runForm.greetingScriptId"
            label="Kịch bản kết bạn"
            :items="kbScripts"
            item-title="name"
            item-value="id"
            clearable
            hint="Lời chào gửi cho KH sau khi kết bạn thành công"
            persistent-hint
          />

          <template v-if="runForm.mode === 'care'">
            <v-select
              v-model="runForm.careScriptIds"
              label="Kịch bản chăm sóc"
              :items="careScripts"
              item-title="name"
              item-value="id"
              multiple
              chips
              closable-chips
              hint="Chuỗi nội dung chăm sóc theo vòng"
              persistent-hint
            />
            <v-text-field
              v-model="runForm.careIntervalDays"
              label="Số ngày giữa các vòng chăm sóc"
              type="number"
              min="1"
              hint="VD: 3 = mỗi 3 ngày gửi 1 vòng chăm sóc"
              persistent-hint
            />
          </template>

          <v-alert v-if="runFormError" type="error" density="compact" class="mt-3">
            {{ runFormError }}
          </v-alert>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="showCreateRun = false">Huỷ</v-btn>
          <v-btn color="primary" :loading="savingRun" @click="submitCreateRun">Tạo</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- ════════ Dialog: Chi tiết đợt chạy ════════ -->
    <v-dialog v-model="showRunDetail" max-width="900" scrollable>
      <v-card>
        <v-card-title class="rd-head">
          <div class="rd-title-wrap">
            <span class="rd-name">{{ detailRun?.name }}</span>
            <span class="chip" :class="modeChip(detailRun?.mode)">
              <v-icon size="12">{{ modeIcon(detailRun?.mode) }}</v-icon> {{ modeLabel(detailRun?.mode) }}
            </span>
            <span class="chip" :class="runStatusChip(detailRun?.status)">
              <span class="dot"></span>{{ runStatusLabel(detailRun?.status) }}
            </span>
          </div>
          <v-btn icon size="small" variant="text" @click="showRunDetail = false">
            <v-icon size="18">mdi-close</v-icon>
          </v-btn>
        </v-card-title>

        <v-card-text>
          <div v-if="detailLoading" class="load-row">
            <v-icon size="16" class="spin">mdi-loading</v-icon> Đang tải chi tiết...
          </div>

          <template v-else>
            <!-- Số liệu theo trạng thái -->
            <div class="rd-stats">
              <div v-for="f in stateFilters" :key="f.value" class="rd-stat">
                <span class="chip" :class="f.chip">{{ f.label }}</span>
                <span class="num rd-stat-num">{{ (countsByState[f.value] ?? 0).toLocaleString('vi-VN') }}</span>
              </div>
            </div>

            <!-- Hạn mức nick -->
            <h4 class="rd-sub">
              <v-icon size="14">mdi-cellphone-link</v-icon> Hạn mức nick trong đợt chạy
            </h4>
            <table v-if="runDetail?.nickBudget?.length" class="tbl rd-tbl">
              <thead>
                <tr><th>Nick</th><th class="right">Đã dùng hôm nay</th><th class="right">Trần</th></tr>
              </thead>
              <tbody>
                <tr v-for="n in runDetail.nickBudget" :key="n.zaloAccountId">
                  <td class="cell-strong">{{ n.displayName || n.zaloAccountId }}</td>
                  <td class="right num">{{ Number(n.usedToday ?? 0).toLocaleString('vi-VN') }}</td>
                  <td class="right num">{{ n.dailyLimit != null ? Number(n.dailyLimit).toLocaleString('vi-VN') : '—' }}</td>
                </tr>
              </tbody>
            </table>
            <div v-else class="muted">Chưa có dữ liệu hạn mức nick cho đợt chạy này.</div>

            <!-- KH theo trạng thái -->
            <h4 class="rd-sub">
              <v-icon size="14">mdi-account-multiple-outline</v-icon> Khách hàng trong đợt chạy
              <span class="t-cap">({{ runContactRows.length.toLocaleString('vi-VN') }}/{{ contactTotal.toLocaleString('vi-VN') }})</span>
            </h4>
            <div class="rd-filters">
              <button
                v-for="f in stateFilters"
                :key="f.value"
                class="filter-chip"
                :class="[{ active: stateFilter === f.value }, f.chip]"
                @click="switchStateFilter(f.value)"
              >
                {{ f.label }}
                <span class="num">{{ f.value ? (countsByState[f.value] ?? 0).toLocaleString('vi-VN') : contactTotal.toLocaleString('vi-VN') }}</span>
              </button>
            </div>

            <table class="tbl rd-tbl">
              <thead>
                <tr>
                  <th>KH</th>
                  <th>SĐT</th>
                  <th>Trạng thái</th>
                  <th>Nick</th>
                  <th>Gửi lúc</th>
                  <th>Chi tiết lỗi</th>
                </tr>
              </thead>
              <tbody>
                <tr v-if="!runContactRows.length && !contactsLoading">
                  <td colspan="6" class="empty-cell">Chưa có khách hàng nào ở trạng thái này.</td>
                </tr>
                <tr v-if="contactsLoading && !runContactRows.length">
                  <td colspan="6" class="empty-cell">
                    <v-icon size="15" class="spin">mdi-loading</v-icon> Đang tải...
                  </td>
                </tr>
                <tr v-for="c in runContactRows" :key="c.id">
                  <td class="cell-strong">{{ c.fullName || c.contactId }}</td>
                  <td class="num">{{ c.phone || '—' }}</td>
                  <td><span class="chip" :class="runStateChip(c.state)">{{ runStateLabel(c.state) }}</span></td>
                  <td class="t-cap">{{ nickName(c.zaloAccountId) }}</td>
                  <td class="t-cap">{{ c.sentAt ? fmtDateTime(c.sentAt) : '—' }}</td>
                  <td class="t-cap">{{ c.errorDetail || '—' }}</td>
                </tr>
              </tbody>
            </table>

            <div v-if="runContactRows.length < contactTotal" class="rd-foot">
              <button class="btn btn-ghost btn-sm" :disabled="contactsLoading" @click="loadMoreContacts">
                <v-icon size="14">mdi-chevron-double-down</v-icon> Tải thêm
              </button>
            </div>
          </template>
        </v-card-text>
      </v-card>
    </v-dialog>

    <CampaignFormDialog v-model="showEdit" :campaign="campaign" @saved="onEdited" />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
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
import { api } from '@/api/index';
import {
  useCampaignRuns,
  RUN_MODES,
  RUN_STATUSES,
  RUN_STATE_FILTERS,
  runActions,
  runProgress,
  runStateChip,
  runStateLabel,
  stateCounts,
  type CampaignRunItem,
  type CampaignScriptItem,
  type CreateRunPayload,
  type RunContactRow,
  type RunDetail,
} from '@/composables/use-campaign-runs';

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
  await Promise.all([fetchCampaignStats(id), loadRuns()]);
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

// ────────────────────── Đợt chạy (Run) ──────────────────────
const {
  loadingRuns: runsLoading,
  fetchRuns,
  createRun,
  runAction,
  fetchRunDetail,
  fetchRunContacts,
  fetchScripts,
} = useCampaignRuns();

const runs = ref<CampaignRunItem[]>([]);
const busyRunId = ref<string | null>(null);
const stateFilters = RUN_STATE_FILTERS;

/** chỉ bấm nút được phép theo trạng thái run (backend vẫn enforce 409). */
function canRunAction(run: CampaignRunItem, action: 'start' | 'pause' | 'resume' | 'cancel'): boolean {
  return runActions(run)[action];
}

function runningProgress(run: CampaignRunItem) {
  return runProgress(run);
}

function modeLabel(mode: string | null | undefined): string {
  if (!mode) return '—';
  return RUN_MODES.find((m) => m.value === mode)?.label ?? mode;
}

function modeChip(mode: string | null | undefined): string {
  if (!mode) return 'chip-grey';
  return RUN_MODES.find((m) => m.value === mode)?.chip ?? 'chip-grey';
}

function modeIcon(mode: string | null | undefined): string {
  if (!mode) return 'mdi-play-circle-outline';
  return RUN_MODES.find((m) => m.value === mode)?.icon ?? 'mdi-play-circle-outline';
}

async function loadRuns() {
  if (!campaign.value) return;
  runs.value = await fetchRuns(campaign.value.id);
}

// ── Polling: khi có ANY run RUNNING → refresh list mỗi 5s; dừng khi hết RUNNING ──
let pollTimer: ReturnType<typeof setInterval> | null = null;
const polling = ref(false);

const anyRunning = computed(() => runs.value.some((r) => r.status === 'RUNNING'));

watch(anyRunning, (on) => {
  if (on) startPolling();
  else stopPolling();
});

function startPolling() {
  if (pollTimer) return;
  polling.value = true;
  pollTimer = setInterval(async () => {
    await refreshPollData();
  }, 5000);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  polling.value = false;
}

async function refreshPollData() {
  if (!campaign.value) return;
  const fresh = await fetchRuns(campaign.value.id);
  if (fresh.length) runs.value = fresh;
  // Nếu đang mở chi tiết của run RUNNING → refresh luôn chi tiết + KH trang hiện tại.
  if (showRunDetail.value && detailRun.value?.status === 'RUNNING' && detailRun.value.id) {
    await refreshRunDetail(true);
  }
}

onUnmounted(stopPolling);

// ── Dialog tạo đợt chạy ──
const showCreateRun = ref(false);
const savingRun = ref(false);
const runFormError = ref('');
const zaloAccounts = ref<{ id: string; label: string }[]>([]);
const zaloLoading = ref(false);
const kbScripts = ref<CampaignScriptItem[]>([]);
const careScripts = ref<CampaignScriptItem[]>([]);

interface RunFormState {
  name: string;
  /** string để tránh xung kiểu với v-btn-toggle (runtime: friend_request | care). */
  mode: string;
  zaloAccountIds: string[];
  /** Raw string từ input number — '' = theo cài đặt SDK. */
  dailyFriendRequestLimit: string;
  greetingScriptId: string | null;
  careScriptIds: string[];
  careIntervalDays: string;
}

const runForm = ref<RunFormState>(emptyRunForm());

function emptyRunForm(): RunFormState {
  return {
    name: '',
    mode: 'friend_request',
    zaloAccountIds: [],
    dailyFriendRequestLimit: '',
    greetingScriptId: null,
    careScriptIds: [],
    careIntervalDays: '',
  };
}

async function openCreateRun() {
  runFormError.value = '';
  runForm.value = emptyRunForm();
  showCreateRun.value = true;
  await Promise.all([loadZaloAccounts(), loadRunScripts()]);
}

/** GET /api/v1/zalo-accounts — nick user được scope cho xem (multiselect). */
async function loadZaloAccounts() {
  zaloLoading.value = true;
  try {
    const res = await api.get('/zalo-accounts');
    const list = Array.isArray(res.data) ? res.data : ((res.data as Record<string, unknown>)?.accounts ?? []);
    zaloAccounts.value = (list as { id: string; displayName?: string | null; phone?: string | null; zaloUid?: string | null }[])
      .map((a) => ({
        id: a.id,
        label: a.displayName || a.phone || a.zaloUid || a.id,
      }));
  } catch (err) {
    console.error('[campaign-runs] loadZaloAccounts failed:', err);
    zaloAccounts.value = [];
  } finally {
    zaloLoading.value = false;
  }
}

async function loadRunScripts() {
  const [kb, care] = await Promise.all([
    fetchScripts({ kind: 'friend_request', activeOnly: true }),
    fetchScripts({ kind: 'care', activeOnly: true }),
  ]);
  kbScripts.value = kb;
  careScripts.value = care;
}

async function submitCreateRun() {
  if (!campaign.value) return;
  const f = runForm.value;
  if (!f.name.trim()) { runFormError.value = 'Tên đợt chạy không được trống'; return; }
  if (!f.zaloAccountIds.length) { runFormError.value = 'Chọn ít nhất 1 nick Zalo tham gia'; return; }
  const limit = parseInt(f.dailyFriendRequestLimit, 10);
  if (f.dailyFriendRequestLimit.trim() && (!Number.isFinite(limit) || limit < 1)) {
    runFormError.value = 'Trần kết bạn/ngày phải là số >= 1 (hoặc để trống)'; return;
  }
  const interval = parseInt(f.careIntervalDays, 10);
  if (f.mode === 'care' && f.careIntervalDays.trim() && (!Number.isFinite(interval) || interval < 1)) {
    runFormError.value = 'Số ngày giữa các vòng chăm sóc phải >= 1'; return;
  }

  savingRun.value = true;
  runFormError.value = '';
  try {
    const payload: CreateRunPayload = {
      name: f.name.trim(),
      mode: f.mode as CreateRunPayload['mode'],
      zaloAccountIds: f.zaloAccountIds,
      dailyFriendRequestLimit: limit > 0 ? limit : null,
      ...(f.mode === 'friend_request' ? { greetingScriptId: f.greetingScriptId || null } : {}),
      ...(f.mode === 'care'
        ? {
            careScriptIds: f.careScriptIds,
            careIntervalDays: interval > 0 ? interval : null,
          }
        : {}),
    };
    await createRun(campaign.value.id, payload);
    toast.success('Đã tạo đợt chạy');
    showCreateRun.value = false;
    await loadRuns();
  } catch (err) {
    runFormError.value = (err as { response?: { data?: { error?: string } } }).response?.data?.error
      ?? 'Tạo đợt chạy thất bại — thử lại';
  } finally {
    savingRun.value = false;
  }
}

// ── Hành động trên run (start/pause/resume/cancel) ──
async function onRunAction(run: CampaignRunItem, action: 'start' | 'pause' | 'resume' | 'cancel') {
  const labels: Record<string, string> = { start: 'start', pause: 'tạm dừng', resume: 'tiếp tục', cancel: 'huỷ' };
  if (action === 'cancel') {
    const ok = await confirm({
      title: `Huỷ đợt chạy "${run.name}"?`,
      message: 'Các KH chưa xử lý sẽ được bỏ qua. Không thể hoàn tác sau khi huỷ.',
      tone: 'danger',
      confirmText: 'Huỷ đợt chạy',
      cancelText: 'Quay lại',
    });
    if (!ok) return;
  }
  busyRunId.value = run.id;
  try {
    await runAction(run.id, action);
    toast.success(`Đã ${labels[action]} đợt chạy "${run.name}"`);
    await loadRuns();
    if (showRunDetail.value && detailRun.value?.id === run.id) {
      await refreshRunDetail(true);
    }
  } catch (err) {
    const msg = (err as { response?: { data?: { error?: string } } }).response?.data?.error
      ?? `Không ${labels[action]} được đợt chạy (trạng thái không hợp lệ?)`;
    toast.error(msg, 5000);
  } finally {
    busyRunId.value = null;
  }
}

// ── Dialog chi tiết run ──
const showRunDetail = ref(false);
const detailLoading = ref(false);
const detailRun = ref<CampaignRunItem | null>(null);
const runDetail = ref<RunDetail | null>(null);
const stateFilter = ref('');
const runContactRows = ref<RunContactRow[]>([]);
const contactTotal = ref(0);
const contactPage = ref(1);
const contactsLoading = ref(false);

/** Số liệu theo state: ưu tiên counts.byState (BE), fallback counters trên run row. */
const countsByState = computed<Record<string, number>>(() =>
  stateCounts(detailRun.value ?? {}, runDetail.value?.counts?.byState),
);

async function openRunDetail(run: CampaignRunItem) {
  detailRun.value = run;
  runDetail.value = null;
  runContactRows.value = [];
  contactTotal.value = 0;
  contactPage.value = 1;
  stateFilter.value = '';
  showRunDetail.value = true;
  detailLoading.value = true;
  try {
    const rd = await fetchRunDetail(run.id);
    runDetail.value = rd;
    if (rd?.run) detailRun.value = rd.run;
    await loadContactsPage(run.id, '', 1, true);
  } finally {
    detailLoading.value = false;
  }
}

/** keepContacts=true → giữ filter/phân trang, thay dữ liệu trang hiện tại (dùng khi polling). */
async function refreshRunDetail(keepContacts = false) {
  if (!detailRun.value) return;
  const id = detailRun.value.id;
  const rd = await fetchRunDetail(id);
  if (!rd) return;
  runDetail.value = rd;
  if (rd.run) detailRun.value = rd.run;
  if (!keepContacts) {
    contactPage.value = 1;
    runContactRows.value = [];
    contactTotal.value = 0;
    await loadContactsPage(id, stateFilter.value, 1, true);
    return;
  }
  // Đang xem nhiều trang → refresh lại TẤT CẢ trang đã tải, không chỉ trang cuối.
  await reloadLoadedPages(id, stateFilter.value);
}

/** Tải lại các trang 1..contactPage (dùng khi polling refresh) — giữ đúng số dòng đang xem. */
async function reloadLoadedPages(id: string, state: string) {
  const pages = Math.max(1, contactPage.value);
  try {
    const results = await Promise.all(
      Array.from({ length: pages }, (_, i) =>
        fetchRunContacts(id, { state: state || undefined, page: i + 1, pageSize: 50 }),
      ),
    );
    runContactRows.value = results.flatMap((r) => r.contacts);
    contactTotal.value = results[0]?.total ?? contactTotal.value;
  } catch (err) {
    console.error('[campaign-runs] reloadLoadedPages failed:', err);
  }
}

async function loadContactsPage(id: string, state: string, page: number, replace: boolean) {
  contactsLoading.value = true;
  try {
    const { contacts, total } = await fetchRunContacts(id, { state: state || undefined, page, pageSize: 50 });
    contactTotal.value = total;
    if (replace) {
      runContactRows.value = contacts;
    } else {
      const seen = new Set(runContactRows.value.map((r) => r.id));
      runContactRows.value.push(...contacts.filter((c) => !seen.has(c.id)));
    }
  } catch (err) {
    console.error('[campaign-runs] loadContactsPage failed:', err);
    toast.error('Không tải được khách hàng của đợt chạy');
  } finally {
    contactsLoading.value = false;
  }
}

async function switchStateFilter(value: string) {
  if (stateFilter.value === value || !detailRun.value) return;
  stateFilter.value = value;
  contactPage.value = 1;
  await loadContactsPage(detailRun.value.id, value, 1, true);
}

async function loadMoreContacts() {
  if (!detailRun.value) return;
  const next = contactPage.value + 1;
  await loadContactsPage(detailRun.value.id, stateFilter.value, next, false);
  contactPage.value = next;
}

function nickName(accountId: string | null): string {
  if (!accountId) return '—';
  const fromBudget = runDetail.value?.nickBudget?.find((n) => n.zaloAccountId === accountId);
  if (fromBudget?.displayName) return fromBudget.displayName;
  const hit = zaloAccounts.value.find((a) => a.id === accountId);
  return hit?.label ?? accountId;
}

function fmtDateTime(v: string | null | undefined): string {
  return formatInOrgTz(v);
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
function runStatusLabel(status: string | null | undefined): string {
  if (!status) return '—';
  const hit = RUN_STATUSES.find((s) => s.value === status);
  return hit?.label ?? status;
}

function runStatusChip(status: string | null | undefined): string {
  if (!status) return 'chip-grey';
  const hit = RUN_STATUSES.find((s) => s.value === status);
  return hit?.chip ?? 'chip-grey';
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

/* ───── Đợt chạy (Run) ───── */
.runs-block { margin-bottom: 16px; }
.runs-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 0; }
.runs-head h3 { display: flex; align-items: center; gap: 7px; margin: 0; }
.runs-empty { padding: 14px 2px; }
.poll-badge {
  display: inline-flex; align-items: center; gap: 4px; font-size: 11px; font-weight: 600;
  color: var(--brand-700); background: var(--brand-soft); padding: 2px 8px; border-radius: var(--r-pill);
}

.run-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px; margin-top: 12px; }
.run-card {
  border: 1px solid var(--line); border-radius: var(--r-md); padding: 12px 14px;
  background: var(--surface-2); cursor: pointer; transition: border-color .12s, background .12s;
}
.run-card:hover { border-color: var(--brand); background: var(--brand-softer); }
.run-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 9px; }
.run-name { font-weight: 700; color: var(--ink); font-size: 13.5px; margin-right: auto; }
.run-progress { display: flex; align-items: center; gap: 9px; }
.run-progress-bar { flex: 1; height: 6px; border-radius: var(--r-pill); background: var(--surface-3); overflow: hidden; }
.run-progress-fill { height: 100%; background: var(--brand); border-radius: var(--r-pill); transition: width .3s; }
.run-progress-num { font-size: 11.5px; color: var(--ink-3); white-space: nowrap; }
.run-meta { margin-top: 7px; display: flex; flex-wrap: wrap; gap: 2px; }
.run-actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; }
.run-actions .btn[disabled] { opacity: .5; cursor: not-allowed; }

/* ───── Dialog chi tiết run ───── */
.rd-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.rd-title-wrap { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.rd-name { font-weight: 700; font-size: 16px; color: var(--ink); }
.rd-stats { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 14px; }
.rd-stat { display: flex; align-items: center; gap: 6px; }
.rd-stat-num { font-size: 13px; font-weight: 700; color: var(--ink); }
.rd-sub {
  display: flex; align-items: center; gap: 6px; margin: 16px 0 8px;
  font-size: 13px; font-weight: 700; color: var(--ink);
}
.rd-tbl { border: 1px solid var(--line); border-radius: var(--r-sm); }
.rd-tbl .empty-cell { text-align: center; color: var(--ink-4); padding: 22px; }
.rd-filters { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
.filter-chip {
  display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: var(--r-pill);
  border: 1px solid var(--line); background: var(--surface); cursor: pointer;
  font-size: 12px; font-weight: 600; color: var(--ink-2); font-family: inherit;
}
.filter-chip:hover { border-color: var(--brand); color: var(--ink); }
.filter-chip.active { border-color: var(--brand); background: var(--brand-soft); color: var(--brand-700); }
.rd-foot { display: flex; justify-content: center; padding-top: 12px; }
.mode-seg { margin-bottom: 14px; }
.mode-seg-label { display: block; font-size: 12px; color: var(--ink-3); margin-bottom: 5px; }

.empty { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-lg); padding: 56px 24px; margin-top: 4px; display: flex; flex-direction: column; align-items: center; text-align: center; }
.empty .v-icon { color: var(--ink-4); }
.empty h3 { margin: 12px 0 6px; color: var(--ink); font-size: 16px; font-weight: 700; }
.empty p { margin: 0; font-size: 13px; color: var(--ink-3); }
</style>