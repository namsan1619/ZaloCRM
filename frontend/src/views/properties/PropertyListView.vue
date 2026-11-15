<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Nguyễn Tiến Lộc -->
<template>
  <div class="property-list-view">
    <!-- ════════ Page head ════════ -->
    <div class="page-head">
      <div>
        <h1 class="h-page">
          <v-icon size="22" class="head-ico">mdi-office-building-outline</v-icon>
          Bảng hàng
        </h1>
        <div class="t-sub">
          Kho căn hộ / đất nền của đại lý — <b>{{ total.toLocaleString('vi-VN') }}</b> căn
        </div>
      </div>
      <div class="head-actions">
        <button class="btn btn-ghost btn-sm" @click="showImport = true">
          <v-icon size="16">mdi-tray-arrow-down</v-icon> Import bảng hàng
        </button>
        <button class="btn btn-primary btn-sm" @click="openCreate">
          <v-icon size="16">mdi-plus</v-icon> Thêm căn lẻ
        </button>
        <button class="btn btn-ghost btn-sm" @click="goProjects">
          <v-icon size="16">mdi-domain</v-icon> Dự án
        </button>
        <button class="btn btn-ghost btn-sm" @click="goAgencies">
          <v-icon size="16">mdi-account-tie-outline</v-icon> Đại lý
        </button>
      </div>
    </div>

    <!-- ════════ Stats band ════════ -->
    <div class="mkt-stats stats-4">
      <div class="mstat">
        <div class="mv num">{{ stats.total.toLocaleString('vi-VN') }}</div>
        <div class="ml">Tổng căn (theo bộ lọc)</div>
      </div>
      <div class="mstat" :title="`Trong ${stats.loaded} căn đang tải`">
        <div class="mv num green">{{ stats.available.toLocaleString('vi-VN') }}</div>
        <div class="ml">Đang bán</div>
      </div>
      <div class="mstat" :title="`Trong ${stats.loaded} căn đang tải`">
        <div class="mv num amber">{{ stats.deposit.toLocaleString('vi-VN') }}</div>
        <div class="ml">Đã cọc</div>
      </div>
      <div class="mstat" :title="`Giá TB của ${stats.loaded} căn đang tải`">
        <div class="mv num">{{ formatVndCompact(stats.avgPriceVnd) }}</div>
        <div class="ml">Giá TB</div>
      </div>
    </div>

    <!-- ════════ Filter strip ════════ -->
    <div class="filter-strip">
      <div class="field sm search">
        <v-icon size="15">mdi-magnify</v-icon>
        <input
          v-model="filters.q"
          placeholder="Tìm mã căn, tòa, phân khu..."
          @input="debouncedSearch"
        />
      </div>
      <div class="field sm">
        <v-icon size="15">mdi-domain</v-icon>
        <select v-model="filters.projectId" @change="applyFilter({ projectId: filters.projectId })">
          <option value="">Tất cả dự án</option>
          <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name }}</option>
        </select>
      </div>
      <div class="field sm">
        <v-icon size="15">mdi-home-city-outline</v-icon>
        <select v-model="filters.propertyTypeCode" @change="applyFilter({ propertyTypeCode: filters.propertyTypeCode })">
          <option value="">Tất cả loại</option>
          <option v-for="t in typeOptions" :key="t.code" :value="t.code">{{ t.label }}</option>
        </select>
      </div>
      <div class="field sm">
        <v-icon size="15">mdi-tag-outline</v-icon>
        <select v-model="filters.statusCode" @change="applyFilter({ statusCode: filters.statusCode })">
          <option value="">Tất cả trạng thái</option>
          <option v-for="s in statusOptions" :key="s.code" :value="s.code">{{ s.label }}</option>
        </select>
      </div>
      <div class="field sm price-filter">
        <v-icon size="15">mdi-currency-usd</v-icon>
        <input v-model="filters.priceMin" placeholder="Giá từ" @change="applyFilter({ priceMin: filters.priceMin })" />
        <span class="sep">–</span>
        <input v-model="filters.priceMax" placeholder="đến" @change="applyFilter({ priceMax: filters.priceMax })" />
      </div>
      <button v-if="hasFilter" class="btn btn-ghost btn-sm" @click="clearFilters">
        <v-icon size="15">mdi-close</v-icon> Xoá lọc
      </button>
    </div>

    <!-- ════════ Compare bar (chọn 2–4 căn) ════════ -->
    <div v-if="selectedIds.length > 0" class="compare-bar">
      <v-icon size="16">mdi-compare-horizontal</v-icon>
      <span>Đã chọn <b>{{ selectedIds.length }}</b>/4 căn</span>
      <button
        class="btn btn-primary btn-sm"
        :disabled="selectedIds.length < 2"
        @click="goCompare"
      >
        So sánh
      </button>
      <button class="btn btn-ghost btn-sm" @click="clearSelection">Bỏ chọn</button>
      <span v-if="selectedIds.length < 2" class="hint">Chọn tối thiểu 2 căn để so sánh</span>
    </div>

    <!-- ════════ Table ════════ -->
    <div class="card table-card">
      <table class="tbl props-table">
        <thead>
          <tr>
            <th class="col-chk"></th>
            <th>Mã căn</th>
            <th>Dự án</th>
            <th>Đại lý</th>
            <th>Loại</th>
            <th class="right">Diện tích</th>
            <th>Hướng</th>
            <th class="right">Giá</th>
            <th>Trạng thái</th>
            <th class="right"></th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="loading">
            <td colspan="10" class="empty-cell">
              <v-icon size="16" class="spin">mdi-loading</v-icon> Đang tải...
            </td>
          </tr>
          <tr v-else-if="properties.length === 0">
            <td colspan="10" class="empty-cell">
              Không có căn nào khớp bộ lọc. Bấm "Import bảng hàng" để nạp từ file Excel.
            </td>
          </tr>
          <tr
            v-for="p in properties"
            :key="p.id"
            class="row-clickable"
            :class="{ selected: isSelected(p.id) }"
            @click="goDetail(p.id)"
          >
            <td class="col-chk" @click.stop>
              <input
                type="checkbox"
                class="chk"
                :checked="isSelected(p.id)"
                :disabled="!isSelected(p.id) && selectedIds.length >= MAX_COMPARE"
                @change="toggleSelect(p.id)"
              />
            </td>
            <td>
              <span class="cell-strong">{{ p.unitCode }}</span>
              <div class="t-cap">{{ p.blockName || p.zoneName || '—' }}</div>
            </td>
            <td>{{ p.project?.name || '—' }}</td>
            <td>{{ p.agency?.name || '—' }}</td>
            <td>{{ typeLabel(p.propertyTypeCode) }}</td>
            <td class="right num">{{ formatArea(p.usableAreaM2 ?? p.landAreaM2) }}</td>
            <td>{{ directionLabel(p) }}</td>
            <td class="right num cell-strong">{{ formatVnd(p.priceVnd) }}</td>
            <td>
              <span class="chip" :class="statusChip(p.statusCode)">
                <span class="dot"></span>{{ statusLabel(p.statusCode) }}
              </span>
            </td>
            <td class="right row-actions" @click.stop>
              <button class="btn btn-ghost btn-sm" title="Sửa thông tin căn" @click="openEdit(p)">
                <v-icon size="14">mdi-pencil-outline</v-icon> Sửa
              </button>
              <button class="btn btn-ghost btn-icon btn-sm" title="Mở chi tiết">
                <v-icon size="15">mdi-arrow-right</v-icon>
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- ════════ Pagination ════════ -->
    <div v-if="total > filters.limit" class="pager">
      <span class="pager-info">
        Hiện {{ pageStart.toLocaleString('vi-VN') }}–{{ pageEnd.toLocaleString('vi-VN') }}
        / {{ total.toLocaleString('vi-VN') }} căn
      </span>
      <div class="pager-ctrls">
        <button class="btn btn-ghost btn-sm" :disabled="filters.page <= 1" @click="goPage(filters.page - 1)">
          <v-icon size="14">mdi-chevron-left</v-icon> Trước
        </button>
        <span class="pager-cur num">Trang {{ filters.page }}</span>
        <button
          class="btn btn-ghost btn-sm"
          :disabled="filters.page * filters.limit >= total"
          @click="goPage(filters.page + 1)"
        >
          Sau <v-icon size="14">mdi-chevron-right</v-icon>
        </button>
      </div>
    </div>

    <PropertyImportDialog v-model="showImport" @imported="onImported" />

    <!-- Form dùng chung: Thêm căn lẻ + Sửa nhanh từ dòng bảng -->
    <PropertyFormDialog
      v-model="showForm"
      :mode="formMode"
      :property="editingProperty"
      @saved="onPropertySaved"
    />
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref, computed } from 'vue';
import { useRouter } from 'vue-router';
import {
  useProperties,
  fetchMasterItems,
  formatVnd,
  formatVndCompact,
  formatArea,
  type MasterOption,
  type PropertyItem,
} from '@/composables/use-properties';
import { useProjects } from '@/composables/use-projects';
import { useToast } from '@/composables/use-toast';
import PropertyImportDialog from '@/components/properties/PropertyImportDialog.vue';
import PropertyFormDialog from '@/components/properties/PropertyFormDialog.vue';

const MAX_COMPARE = 4;

const router = useRouter();
const toast = useToast();
const {
  properties,
  total,
  loading,
  filters,
  stats,
  fetchProperties,
  applyFilter,
  goPage,
} = useProperties();

const { projects, fetchProjects } = useProjects();

const showImport = ref(false);
const selectedIds = ref<string[]>([]);

// ───────── Form dùng chung (Thêm căn lẻ / Sửa nhanh) ─────────
const showForm = ref(false);
const formMode = ref<'create' | 'edit'>('create');
const editingProperty = ref<PropertyItem | null>(null);

function openCreate() {
  formMode.value = 'create';
  editingProperty.value = null;
  showForm.value = true;
}

function openEdit(p: PropertyItem) {
  formMode.value = 'edit';
  editingProperty.value = p;
  showForm.value = true;
}

async function onPropertySaved() {
  toast.success(formMode.value === 'edit' ? 'Đã cập nhật căn' : 'Đã thêm căn lẻ');
  // Căn mới sort theo createdAt desc → về trang 1 để thấy; sửa thì giữ nguyên trang.
  if (formMode.value === 'edit') await fetchProperties();
  else await applyFilter({});
}

const typeOptions = ref<MasterOption[]>([]);
const statusOptions = ref<MasterOption[]>([]);
const directionOptions = ref<MasterOption[]>([]);

/** MasterData có thể trả key khác case — dựng map label theo code (fallback code). */
const typeMap = computed(() => new Map(typeOptions.value.map((o) => [o.code, o.label])));
const statusMap = computed(() => new Map(statusOptions.value.map((o) => [o.code, o.label])));
const directionMap = computed(() => new Map(directionOptions.value.map((o) => [o.code, o.label])));

const hasFilter = computed(
  () => !!(filters.value.q || filters.value.projectId || filters.value.statusCode
    || filters.value.propertyTypeCode || filters.value.priceMin || filters.value.priceMax),
);

const pageStart = computed(() => (filters.value.page - 1) * filters.value.limit + 1);
const pageEnd = computed(() => Math.min(filters.value.page * filters.value.limit, total.value));

onMounted(async () => {
  await Promise.all([
    fetchProperties(),
    fetchProjects(),
    loadMasterOptions(),
  ]);
});

async function loadMasterOptions() {
  const [types, statuses, directions] = await Promise.all([
    fetchMasterItems('LOAI_CAN'),
    fetchMasterItems('TRANG_THAI_CAN'),
    fetchMasterItems('HUONG'),
  ]);
  typeOptions.value = types;
  statusOptions.value = statuses;
  directionOptions.value = directions;
}

let searchTimer: ReturnType<typeof setTimeout> | null = null;
function debouncedSearch() {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => applyFilter({ q: filters.value.q }), 300);
}

function clearFilters() {
  filters.value.q = '';
  filters.value.projectId = '';
  filters.value.statusCode = '';
  filters.value.propertyTypeCode = '';
  filters.value.priceMin = '';
  filters.value.priceMax = '';
  applyFilter({});
}

// ───────── Selection + compare ─────────
function isSelected(id: string): boolean {
  return selectedIds.value.includes(id);
}

function toggleSelect(id: string) {
  if (isSelected(id)) {
    selectedIds.value = selectedIds.value.filter((x) => x !== id);
  } else if (selectedIds.value.length < MAX_COMPARE) {
    selectedIds.value = [...selectedIds.value, id];
  }
}

function clearSelection() {
  selectedIds.value = [];
}

function goCompare() {
  if (selectedIds.value.length < 2) return;
  router.push({ path: '/properties/compare', query: { ids: selectedIds.value.join(',') } });
}

function goDetail(id: string) {
  router.push(`/properties/${id}`);
}

function goProjects() {
  router.push('/projects');
}

function goAgencies() {
  router.push('/agencies');
}

function onImported() {
  applyFilter({});
}

// ───────── Helpers ─────────
function typeLabel(code: string | null): string {
  if (!code) return '—';
  return typeMap.value.get(code) ?? code;
}

function statusLabel(code: string | null): string {
  if (!code) return '—';
  return statusMap.value.get(code) ?? code;
}

function statusChip(code: string | null): string {
  const c = (code || '').toUpperCase();
  if (c === 'AVAILABLE') return 'chip-green';
  if (/DEPOSIT|COC|RESERVED/i.test(c)) return 'chip-amber';
  if (/SOLD|SOLD_OUT/i.test(c)) return 'chip-grey';
  if (/HOLD|BLOCK/i.test(c)) return 'chip-red';
  return 'chip-blue';
}

function directionLabel(p: { directionCode: string | null; balconyDirectionCode: string | null }): string {
  const code = p.balconyDirectionCode || p.directionCode;
  if (!code) return '—';
  return directionMap.value.get(code) ?? code;
}
</script>

<style scoped>
/* ════════════════════════════════════════════════════════════════════════
   Bảng hàng (PropertyListView) — HS theme (.card/.tbl/.chip/.btn/.field/.mkt-*)
   ════════════════════════════════════════════════════════════════════════ */
.property-list-view {
  padding: 20px 24px;
  background: var(--surface-2);
  min-height: 100%;
}

.page-head {
  display: flex; align-items: flex-start; justify-content: space-between;
  gap: 16px; margin-bottom: 16px; flex-wrap: wrap;
}
.page-head .h-page { display: flex; align-items: center; gap: 8px; margin: 0; }
.head-ico { color: var(--brand); }
.head-actions { display: flex; gap: 8px; flex-wrap: wrap; }

.mstat .mv.green { color: #157f3c; }
.mstat .mv.amber { color: #b45309; }

/* ───── Filter strip ───── */
.filter-strip {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  background: var(--surface); border: 1px solid var(--line);
  border-radius: var(--r-md); padding: 10px 12px; margin-bottom: 12px;
}
.filter-strip .field { min-width: 160px; }
.filter-strip .field select,
.filter-strip .field input {
  border: none; background: transparent; outline: none;
  font-size: 12.5px; color: var(--ink); width: 100%;
}
.filter-strip .field select { cursor: pointer; }
.filter-strip .search { min-width: 220px; }
.price-filter { display: flex; align-items: center; gap: 6px; min-width: 200px !important; }
.price-filter .sep { color: var(--ink-4); font-size: 12px; }

/* ───── Compare bar ───── */
.compare-bar {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  background: var(--brand-softer); border: 1px solid var(--brand-soft);
  border-radius: var(--r-md); padding: 9px 14px; margin-bottom: 12px;
  font-size: 13px; color: var(--ink-2);
}
.compare-bar .hint { color: var(--ink-4); font-size: 12px; }

/* ───── Table ───── */
.table-card { overflow: auto; padding: 0; }
.props-table th.right, .props-table td.right { text-align: right; }
.props-table .col-chk { width: 36px; }
.row-actions { text-align: right; white-space: nowrap; }
.row-actions .btn { margin-left: 4px; }
.props-table tbody tr.selected { background: var(--brand-softer); }
.props-table .empty-cell { text-align: center; color: var(--ink-4); padding: 28px; }
.chk { width: 15px; height: 15px; accent-color: var(--brand); cursor: pointer; }
.chk:disabled { cursor: not-allowed; opacity: .5; }

/* ───── Pagination ───── */
.pager {
  display: flex; align-items: center; justify-content: space-between;
  gap: 12px; margin-top: 12px;
}
.pager-info { font-size: 12.5px; color: var(--ink-3); }
.pager-ctrls { display: flex; align-items: center; gap: 8px; }
.pager-cur { font-size: 12px; font-weight: 600; color: var(--ink-2); }
.btn[disabled] { opacity: .45; cursor: not-allowed; }
</style>
