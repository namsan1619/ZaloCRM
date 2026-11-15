<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Nguyễn Tiến Lộc -->
<template>
  <div class="property-detail-view">
    <!-- Breadcrumb -->
    <div class="breadcrumb">
      <a @click="$router.push('/properties')">
        <v-icon size="14">mdi-office-building-outline</v-icon> Bảng hàng
      </a>
      <v-icon size="14" class="sep">mdi-chevron-right</v-icon>
      <span>{{ property?.unitCode ?? '...' }}</span>
    </div>

    <div v-if="loading" class="load-row">
      <v-icon size="16" class="spin">mdi-loading</v-icon> Đang tải...
    </div>

    <template v-else-if="property">
      <!-- ════════ Hero ════════ -->
      <div class="detail-hero">
        <div class="hero-head">
          <div style="min-width:0; flex:1;">
            <h2>
              <span class="hero-ico"><v-icon size="20">mdi-home-outline</v-icon></span>
              <span class="title-text">{{ property.unitCode }}</span>
              <span class="chip" :class="statusChip(property.statusCode)">
                <span class="dot"></span>{{ statusLabel(property.statusCode) }}
              </span>
            </h2>
            <div class="sub">
              <b>{{ property.project?.name || 'Chưa gắn dự án' }}</b>
              <template v-if="property.agency?.name"> · Đại lý <b>{{ property.agency.name }}</b></template>
              <template v-if="property.blockName || property.zoneName"> · {{ property.blockName || '' }}{{ property.zoneName ? ` / ${property.zoneName}` : '' }}</template>
            </div>
          </div>
          <div class="hero-actions">
            <button class="btn btn-primary btn-sm" @click="openEdit">
              <v-icon size="16">mdi-pencil-outline</v-icon> Sửa
            </button>
            <button class="btn btn-ghost btn-sm" @click="$router.push('/properties')">
              <v-icon size="16">mdi-arrow-left</v-icon> Về danh sách
            </button>
          </div>
        </div>

        <!-- ════════ Price block ════════ -->
        <div class="price-band">
          <div class="price-main">
            <div class="pl">Giá bán</div>
            <div class="pv num">{{ formatVnd(property.priceVnd) }}</div>
            <div v-if="property.priceNote" class="pn">{{ property.priceNote }}</div>
          </div>
          <div class="price-sub">
            <div>
              <div class="pl">Theo TTS</div>
              <div class="pv sm num">{{ formatVnd(property.priceTtsVnd) }}</div>
            </div>
            <div>
              <div class="pl">Theo HTLS</div>
              <div class="pv sm num">{{ formatVnd(property.priceHtlsVnd) }}</div>
            </div>
            <div>
              <div class="pl">Đơn giá TTS/m²</div>
              <div class="pv sm num">{{ formatVnd(property.unitPriceTtsVnd) }}</div>
            </div>
          </div>
        </div>
      </div>

      <!-- ════════ Spec grid 2 cột ════════ -->
      <div class="spec-grid">
        <div class="card card-pad">
          <h3 class="h-sec">
            <v-icon size="16">mdi-ruler-square</v-icon> Thông số căn
          </h3>
          <div class="spec-2col">
            <div class="spec-item"><span class="k">Loại</span><span class="v">{{ typeLabel(property.propertyTypeCode) }}</span></div>
            <div class="spec-item"><span class="k">Phân khu</span><span class="v">{{ property.zoneName || '—' }}</span></div>
            <div class="spec-item"><span class="k">Tòa / block</span><span class="v">{{ property.blockName || '—' }}</span></div>
            <div class="spec-item"><span class="k">Tầng</span><span class="v">{{ property.floorNo ?? '—' }}<template v-if="property.totalFloors"> / {{ property.totalFloors }} tầng</template></span></div>
            <div class="spec-item"><span class="k">Phòng ngủ</span><span class="v">{{ property.bedrooms ?? '—' }}</span></div>
            <div class="spec-item"><span class="k">Phòng tắm</span><span class="v">{{ property.bathrooms ?? '—' }}</span></div>
            <div class="spec-item"><span class="k">Diện tích tim tường</span><span class="v num">{{ formatArea(property.timTuongAreaM2) }}</span></div>
            <div class="spec-item"><span class="k">Diện tích thông thuỷ</span><span class="v num">{{ formatArea(property.usableAreaM2) }}</span></div>
            <div class="spec-item"><span class="k">Diện tích đất</span><span class="v num">{{ formatArea(property.landAreaM2) }}</span></div>
            <div class="spec-item"><span class="k">Diện tích xây dựng</span><span class="v num">{{ formatArea(property.constructionAreaM2) }}</span></div>
            <div class="spec-item"><span class="k">Mặt tiền</span><span class="v num">{{ property.frontageM != null ? `${property.frontageM} m` : '—' }}</span></div>
            <div class="spec-item"><span class="k">Chiều sâu</span><span class="v num">{{ property.depthM != null ? `${property.depthM} m` : '—' }}</span></div>
            <div class="spec-item"><span class="k">Đường trước nhà</span><span class="v num">{{ property.roadWidthM != null ? `${property.roadWidthM} m` : '—' }}</span></div>
            <div class="spec-item"><span class="k">Hướng ban công</span><span class="v">{{ directionLabel(property.balconyDirectionCode) }}</span></div>
            <div class="spec-item"><span class="k">Hướng nhà</span><span class="v">{{ directionLabel(property.directionCode) }}</span></div>
            <div class="spec-item"><span class="k">View</span><span class="v">{{ viewLabel(property.viewCode) }}</span></div>
          </div>
        </div>

        <div class="card card-pad">
          <h3 class="h-sec">
            <v-icon size="16">mdi-file-document-outline</v-icon> Pháp lý & bàn giao
          </h3>
          <div class="spec-2col">
            <div class="spec-item"><span class="k">Pháp lý</span><span class="v">{{ legalLabel(property.legalCode) }}</span></div>
            <div class="spec-item"><span class="k">Bàn giao</span><span class="v">{{ handoverLabel(property.handoverCode) }}</span></div>
            <div class="spec-item"><span class="k">Năm bàn giao</span><span class="v">{{ property.handoverYear ?? '—' }}</span></div>
            <div class="spec-item"><span class="k">Nội thất</span><span class="v">{{ furnitureLabel(property.furnitureCode) }}</span></div>
            <div class="spec-item"><span class="k">Cơ chế đặc biệt</span><span class="v">{{ mechanismLabel(property.specialMechanismCode) }}</span></div>
            <div class="spec-item"><span class="k">Loại giao dịch</span><span class="v">{{ transactionLabel(property.transactionType) }}</span></div>
            <div class="spec-item"><span class="k">Cho thuê</span><span class="v num">{{ formatVnd(property.priceRentVnd) }}</span></div>
          </div>
          <div v-if="property.note || property.statusNote || property.legalNote" class="note-block">
            <div v-if="property.note" class="note-line"><span class="k">Ghi chú:</span> {{ property.note }}</div>
            <div v-if="property.statusNote" class="note-line"><span class="k">Trạng thái:</span> {{ property.statusNote }}</div>
            <div v-if="property.legalNote" class="note-line"><span class="k">Pháp lý:</span> {{ property.legalNote }}</div>
          </div>
        </div>
      </div>
    </template>

    <div v-else class="empty">
      <v-icon size="40">mdi-home-off-outline</v-icon>
      <h3>Không tìm thấy căn</h3>
      <p>Căn này có thể đã bị xoá hoặc bạn không có quyền xem.</p>
    </div>

    <!-- ════════ Edit dialog (form dùng chung) ════════ -->
    <PropertyFormDialog
      v-model="showEdit"
      mode="edit"
      :property="property"
      @saved="onSaved"
    />
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import {
  useProperties,
  fetchMasterItems,
  formatVnd,
  formatArea,
  type MasterOption,
  type PropertyItem,
} from '@/composables/use-properties';
import { useToast } from '@/composables/use-toast';
import PropertyFormDialog from '@/components/properties/PropertyFormDialog.vue';

const route = useRoute();
const toast = useToast();
const { fetchPropertyById } = useProperties();

const property = ref<PropertyItem | null>(null);
const loading = ref(true);

const showEdit = ref(false);

const typeOptions = ref<MasterOption[]>([]);
const statusOptions = ref<MasterOption[]>([]);
const directionOptions = ref<MasterOption[]>([]);
const viewOptions = ref<MasterOption[]>([]);
const legalOptions = ref<MasterOption[]>([]);
const handoverOptions = ref<MasterOption[]>([]);
const furnitureOptions = ref<MasterOption[]>([]);
const mechanismOptions = ref<MasterOption[]>([]);

function labelFor(list: MasterOption[], code: string | null): string {
  if (!code) return '—';
  const hit = list.find((o) => o.code === code);
  return hit?.label ?? code;
}

const id = String(route.params.id ?? '');

onMounted(async () => {
  await Promise.all([
    loadProperty(),
    loadMasterOptions(),
  ]);
});

async function loadProperty() {
  loading.value = true;
  try {
    property.value = await fetchPropertyById(id);
  } finally {
    loading.value = false;
  }
}

async function loadMasterOptions() {
  const [types, statuses, dirs, views, legals, handovers, furnitures, mechs] = await Promise.all([
    fetchMasterItems('LOAI_CAN'),
    fetchMasterItems('TRANG_THAI_CAN'),
    fetchMasterItems('HUONG'),
    fetchMasterItems('VIEW'),
    fetchMasterItems('PHAPLY'),
    fetchMasterItems('BAN_GIAO'),
    fetchMasterItems('NOI_THAT'),
    fetchMasterItems('CO_CHE_DAC_BIET'),
  ]);
  typeOptions.value = types;
  statusOptions.value = statuses;
  directionOptions.value = dirs;
  viewOptions.value = views;
  legalOptions.value = legals;
  handoverOptions.value = handovers;
  furnitureOptions.value = furnitures;
  mechanismOptions.value = mechs;
}

// ───────── Edit (form dùng chung) ─────────
function openEdit() {
  if (!property.value) return;
  showEdit.value = true;
}

async function onSaved() {
  toast.success('Đã cập nhật căn');
  await loadProperty();
}

// ───────── Label helpers ─────────
function typeLabel(code: string | null) { return labelFor(typeOptions.value, code); }
function statusLabel(code: string | null) { return labelFor(statusOptions.value, code); }
function directionLabel(code: string | null) { return labelFor(directionOptions.value, code); }
function viewLabel(code: string | null) { return labelFor(viewOptions.value, code); }
function legalLabel(code: string | null) { return labelFor(legalOptions.value, code); }
function handoverLabel(code: string | null) { return labelFor(handoverOptions.value, code); }
function furnitureLabel(code: string | null) { return labelFor(furnitureOptions.value, code); }
function mechanismLabel(code: string | null) { return labelFor(mechanismOptions.value, code); }

function transactionLabel(t: string | null): string {
  if (!t) return '—';
  if (t === 'SALE') return 'Bán';
  if (t === 'RENT') return 'Cho thuê';
  return t;
}

function statusChip(code: string | null): string {
  const c = (code || '').toUpperCase();
  if (c === 'AVAILABLE') return 'chip-green';
  if (/DEPOSIT|COC|RESERVED/i.test(c)) return 'chip-amber';
  if (/SOLD|SOLD_OUT/i.test(c)) return 'chip-grey';
  if (/HOLD|BLOCK/i.test(c)) return 'chip-red';
  return 'chip-blue';
}
</script>

<style scoped>
/* ════════ HS Atlas detail (thể loại ListDetailView) ════════ */
.property-detail-view { padding: 22px 24px; max-width: 100%; background: var(--surface-2); min-height: 100%; }
.breadcrumb { display: flex; align-items: center; gap: 6px; margin-bottom: 14px; font-size: 12px; color: var(--ink-3); }
.breadcrumb a { color: var(--brand); text-decoration: none; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; }
.breadcrumb a:hover { text-decoration: underline; }
.breadcrumb .sep { color: var(--ink-4); }

.load-row { display: flex; align-items: center; gap: 8px; color: var(--ink-3); padding: 24px; }

.detail-hero { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-lg); box-shadow: var(--sh-sm); padding: 18px 20px; margin-bottom: 16px; }
.hero-head { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 14px; gap: 14px; flex-wrap: wrap; }
.hero-head h2 { margin: 0 0 4px; font-size: 18px; font-weight: 700; color: var(--ink); display: flex; align-items: center; gap: 8px; }
.hero-ico { width: 32px; height: 32px; border-radius: var(--r-sm); background: var(--brand-soft); color: var(--brand); display: inline-flex; align-items: center; justify-content: center; flex: none; }
.hero-head .sub { color: var(--ink-3); font-size: 12.5px; }
.hero-head .sub b { color: var(--ink); font-weight: 600; }
.hero-actions { display: flex; gap: 8px; }

/* ───── Price band ───── */
.price-band { display: flex; gap: 20px; align-items: stretch; flex-wrap: wrap; }
.price-main { flex: 1; min-width: 220px; background: var(--brand-softer); border: 1px solid var(--brand-soft); border-radius: var(--r-md); padding: 14px 16px; }
.price-main .pl { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--brand-700); }
.price-main .pv { font-size: 26px; font-weight: 800; color: var(--ink); margin-top: 4px; }
.price-sub { flex: 1.4; display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; min-width: 280px; }
.price-sub > div { background: var(--surface-2); border: 1px solid var(--line); border-radius: var(--r-md); padding: 12px 14px; }
.price-sub .pl { font-size: 11px; color: var(--ink-3); }
.price-sub .pv.sm { font-size: 15px; font-weight: 700; color: var(--ink); margin-top: 3px; }
.pn { font-size: 12px; color: var(--ink-3); margin-top: 4px; }

/* ───── Spec grid ───── */
.spec-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
@media (max-width: 1000px) { .spec-grid { grid-template-columns: 1fr; } }
.card-pad h3 { display: flex; align-items: center; gap: 7px; margin: 0 0 12px; }
.spec-2col { display: grid; grid-template-columns: 1fr 1fr; gap: 2px 24px; }
@media (max-width: 720px) { .spec-2col { grid-template-columns: 1fr; } }
.spec-item { display: flex; justify-content: space-between; gap: 12px; padding: 8px 0; border-bottom: 1px dashed var(--line-2); }
.spec-item .k { font-size: 12.5px; color: var(--ink-3); flex: none; }
.spec-item .v { font-size: 13px; color: var(--ink); font-weight: 500; text-align: right; }
.note-block { margin-top: 14px; padding-top: 10px; border-top: 1px solid var(--line); }
.note-line { font-size: 12.5px; color: var(--ink-2); line-height: 1.6; }
.note-line .k { color: var(--ink-3); font-weight: 600; }

.empty { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-lg); padding: 56px 24px; margin-top: 4px; display: flex; flex-direction: column; align-items: center; text-align: center; }
.empty .v-icon { color: var(--ink-4); }
.empty h3 { margin: 12px 0 6px; color: var(--ink); font-size: 16px; font-weight: 700; }
.empty p { margin: 0; font-size: 13px; color: var(--ink-3); }
</style>