<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Nguyễn Tiến Lộc -->
<template>
  <div class="property-compare-view">
    <!-- Breadcrumb -->
    <div class="breadcrumb">
      <a @click="$router.push('/properties')">
        <v-icon size="14">mdi-office-building-outline</v-icon> Bảng hàng
      </a>
      <v-icon size="14" class="sep">mdi-chevron-right</v-icon>
      <span>So sánh {{ items.length }} căn</span>
    </div>

    <div class="page-head">
      <div>
        <h1 class="h-page">So sánh căn hộ</h1>
        <div class="t-sub">Hàng = thuộc tính, cột = từng căn</div>
      </div>
      <button class="btn btn-ghost btn-sm" @click="$router.push('/properties')">
        <v-icon size="16">mdi-arrow-left</v-icon> Về bảng hàng
      </button>
    </div>

    <div v-if="loading" class="load-row">
      <v-icon size="16" class="spin">mdi-loading</v-icon> Đang so sánh...
    </div>

    <div v-else-if="items.length === 0" class="empty">
      <v-icon size="40">mdi-compare-remove</v-icon>
      <h3>Chưa có căn nào để so sánh</h3>
      <p>Quay lại Bảng hàng, tick 2–4 căn rồi bấm "So sánh".</p>
    </div>

    <div v-else class="card table-card">
      <table class="tbl compare-table">
        <thead>
          <tr>
            <th class="attr-col">Thuộc tính</th>
            <th v-for="p in items" :key="p.id">
              <div class="unit-head">
                <div class="cell-strong">{{ p.unitCode }}</div>
                <div class="t-cap">{{ p.project?.name || '—' }}</div>
              </div>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.label">
            <td class="attr-cell">{{ row.label }}</td>
            <td
              v-for="(v, i) in row.values"
              :key="i"
              class="val-cell"
              :class="{ 'num': isNumeric(v) }"
            >{{ v === null || v === undefined || v === '' ? '—' : v }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="items.length >= 2" class="best-hint">
      <v-icon size="14">mdi-lightbulb-on-outline</v-icon>
      Hướng dẫn: cột "Diện tích" và "Giá" dùng font số để dễ so sánh; giá là giá niêm yết, chưa trừ chiết khấu.
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import {
  useProperties,
  formatVnd,
  formatArea,
  type PropertyItem,
} from '@/composables/use-properties';

const route = useRoute();
const { fetchCompare } = useProperties();

const items = ref<PropertyItem[]>([]);
const loading = ref(true);

type CellValue = string | number | null;

interface CompareRowDef {
  label: string;
  get: (p: PropertyItem) => CellValue;
  numeric?: boolean;
}

const ROW_DEFS: CompareRowDef[] = [
  { label: 'Mã căn', get: (p) => p.unitCode },
  { label: 'Dự án', get: (p) => p.project?.name ?? null },
  { label: 'Đại lý', get: (p) => p.agency?.name ?? null },
  { label: 'Phân khu', get: (p) => p.zoneName ?? null },
  { label: 'Tòa / block', get: (p) => p.blockName ?? null },
  { label: 'Loại', get: (p) => p.propertyTypeCode ?? null },
  { label: 'Loại giao dịch', get: (p) => p.transactionType === 'RENT' ? 'Cho thuê' : (p.transactionType === 'SALE' ? 'Bán' : (p.transactionType ?? null)) },
  { label: 'Tầng', get: (p) => p.floorNo ?? (p.totalFloors ? `/${p.totalFloors}` : null) },
  { label: 'Phòng ngủ', get: (p) => p.bedrooms ?? null },
  { label: 'Phòng tắm', get: (p) => p.bathrooms ?? null },
  { label: 'Diện tích tim tường', get: (p) => formatArea(p.timTuongAreaM2) },
  { label: 'Diện tích thông thuỷ', get: (p) => formatArea(p.usableAreaM2) },
  { label: 'Diện tích đất', get: (p) => formatArea(p.landAreaM2) },
  { label: 'Diện tích xây dựng', get: (p) => formatArea(p.constructionAreaM2) },
  { label: 'Mặt tiền (m)', get: (p) => p.frontageM ?? null, numeric: true },
  { label: 'Chiều sâu (m)', get: (p) => p.depthM ?? null, numeric: true },
  { label: 'Đường trước nhà (m)', get: (p) => p.roadWidthM ?? null, numeric: true },
  { label: 'Hướng ban công', get: (p) => p.balconyDirectionCode ?? null },
  { label: 'Hướng nhà', get: (p) => p.directionCode ?? null },
  { label: 'View', get: (p) => p.viewCode ?? null },
  { label: 'Pháp lý', get: (p) => p.legalCode ?? null },
  { label: 'Bàn giao', get: (p) => p.handoverCode ?? null },
  { label: 'Năm bàn giao', get: (p) => p.handoverYear ?? null, numeric: true },
  { label: 'Nội thất', get: (p) => p.furnitureCode ?? null },
  { label: 'Cơ chế đặc biệt', get: (p) => p.specialMechanismCode ?? null },
  { label: 'Giá bán', get: (p) => formatVnd(p.priceVnd) },
  { label: 'Giá TTS', get: (p) => formatVnd(p.priceTtsVnd) },
  { label: 'Giá HTLS', get: (p) => formatVnd(p.priceHtlsVnd) },
  { label: 'Đơn giá TTS/m²', get: (p) => formatVnd(p.unitPriceTtsVnd) },
  { label: 'Giá thuê', get: (p) => formatVnd(p.priceRentVnd) },
  { label: 'Trạng thái', get: (p) => p.statusCode ?? null },
  { label: 'Ghi chú', get: (p) => p.note ?? null },
];

const rows = computed(() =>
  ROW_DEFS.map((def) => ({
    label: def.label,
    numeric: !!def.numeric,
    values: items.value.map((p) => def.get(p)),
  })),
);

function isNumeric(v: unknown): boolean {
  return typeof v === 'number';
}

const ids = computed(() => {
  const raw = String(route.query.ids ?? '');
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
});

onMounted(async () => {
  loading.value = true;
  try {
    items.value = await fetchCompare(ids.value);
  } finally {
    loading.value = false;
  }
});
</script>

<style scoped>
.property-compare-view { padding: 22px 24px; max-width: 100%; background: var(--surface-2); min-height: 100%; }
.breadcrumb { display: flex; align-items: center; gap: 6px; margin-bottom: 14px; font-size: 12px; color: var(--ink-3); }
.breadcrumb a { color: var(--brand); text-decoration: none; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; }
.breadcrumb a:hover { text-decoration: underline; }
.breadcrumb .sep { color: var(--ink-4); }

.page-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 16px; }
.page-head .h-page { margin: 0; }

.load-row { display: flex; align-items: center; gap: 8px; color: var(--ink-3); padding: 24px; }

.table-card { overflow: auto; padding: 0; }
.compare-table { min-width: 640px; }
.compare-table th.attr-col, .attr-cell { position: sticky; left: 0; background: var(--surface-3); z-index: 1; }
.compare-table thead th { background: var(--surface-3); }
.unit-head .cell-strong { font-size: 14px; }
.val-cell { min-width: 140px; }
.attr-cell { font-weight: 600; color: var(--ink-2); white-space: nowrap; }
.val-cell.num { font-family: var(--mono); font-variant-numeric: tabular-nums; }

.empty { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-lg); padding: 56px 24px; margin-top: 4px; display: flex; flex-direction: column; align-items: center; text-align: center; }
.empty .v-icon { color: var(--ink-4); }
.empty h3 { margin: 12px 0 6px; color: var(--ink); font-size: 16px; font-weight: 700; }
.empty p { margin: 0; font-size: 13px; color: var(--ink-3); }

.best-hint { display: flex; align-items: center; gap: 7px; margin-top: 12px; font-size: 12px; color: var(--ink-3); }
</style>