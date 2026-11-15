<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Nguyễn Tiến Lộc -->
<template>
  <v-dialog
    :model-value="modelValue"
    @update:model-value="$emit('update:modelValue', $event)"
    max-width="780"
  >
    <v-card class="pfd-card">
      <v-card-title class="pfd-title">
        <v-icon size="18" class="mr-1">
          {{ isEdit ? 'mdi-pencil-outline' : 'mdi-plus-box-outline' }}
        </v-icon>
        {{ isEdit ? `Sửa căn ${property?.unitCode ?? ''}` : 'Thêm căn lẻ' }}
      </v-card-title>

      <v-card-text class="pfd-body">
        <!-- ════════ Thông tin cơ bản ════════ -->
        <div class="pfd-sec">
          <v-icon size="14">mdi-home-variant-outline</v-icon> Thông tin cơ bản
        </div>
        <v-row dense>
          <v-col cols="12" sm="6">
            <v-text-field
              v-model="form.unitCode"
              label="Mã căn *"
              placeholder="Vd: A1-101"
              :disabled="saving"
              density="compact"
            />
          </v-col>
          <v-col cols="12" sm="6">
            <v-select
              v-model="form.projectId"
              label="Dự án *"
              :items="projects"
              item-title="name"
              item-value="id"
              :loading="optionsLoading"
              :disabled="saving"
              density="compact"
              no-data-text="Chưa có dự án nào"
            />
          </v-col>
          <v-col cols="12" sm="6">
            <v-select
              v-model="form.agencyId"
              label="Đại lý"
              :items="agencies"
              item-title="name"
              item-value="id"
              :disabled="saving"
              clearable
              density="compact"
              no-data-text="Chưa có đại lý nào"
            />
          </v-col>
          <v-col cols="12" sm="6">
            <v-select
              v-model="form.propertyTypeCode"
              label="Loại căn"
              :items="typeOptions"
              item-title="label"
              item-value="code"
              :disabled="saving"
              clearable
              density="compact"
            />
          </v-col>
          <v-col cols="12" sm="6">
            <v-select
              v-model="form.statusCode"
              label="Trạng thái *"
              :items="statusOptions"
              item-title="label"
              item-value="code"
              :disabled="saving"
              density="compact"
            />
          </v-col>
          <v-col cols="12" sm="6">
            <v-select
              v-model="form.category"
              label="Phân loại"
              :items="CATEGORY_OPTIONS"
              item-title="label"
              item-value="value"
              :disabled="saving"
              clearable
              density="compact"
            />
          </v-col>
          <v-col cols="12" sm="6">
            <v-select
              v-model="form.transactionType"
              label="Loại giao dịch"
              :items="TRANSACTION_OPTIONS"
              item-title="label"
              item-value="value"
              :disabled="saving"
              clearable
              density="compact"
            />
          </v-col>
          <v-col cols="12" sm="3">
            <v-text-field v-model="form.zoneName" label="Phân khu" :disabled="saving" density="compact" />
          </v-col>
          <v-col cols="12" sm="3">
            <v-text-field v-model="form.blockName" label="Tòa / block" :disabled="saving" density="compact" />
          </v-col>
        </v-row>

        <!-- ════════ Diện tích & số phòng ════════ -->
        <div class="pfd-sec">
          <v-icon size="14">mdi-ruler-square</v-icon> Diện tích & số phòng
        </div>
        <v-row dense>
          <v-col cols="6" sm="3">
            <v-text-field v-model="form.floorNo" label="Tầng" type="number" :disabled="saving" density="compact" />
          </v-col>
          <v-col cols="6" sm="3">
            <v-text-field v-model="form.totalFloors" label="Tổng số tầng" type="number" :disabled="saving" density="compact" />
          </v-col>
          <v-col cols="6" sm="3">
            <v-text-field v-model="form.bedrooms" label="Phòng ngủ" type="number" :disabled="saving" density="compact" />
          </v-col>
          <v-col cols="6" sm="3">
            <v-text-field v-model="form.bathrooms" label="Phòng tắm" type="number" :disabled="saving" density="compact" />
          </v-col>
          <v-col cols="12" sm="6">
            <v-text-field v-model="form.usableAreaM2" label="Diện tích thông thuỷ (m²)" type="number" :disabled="saving" density="compact" />
          </v-col>
          <v-col cols="12" sm="6">
            <v-text-field v-model="form.timTuongAreaM2" label="Diện tích tim tường (m²)" type="number" :disabled="saving" density="compact" />
          </v-col>
        </v-row>

        <!-- ════════ Giá ════════ -->
        <div class="pfd-sec">
          <v-icon size="14">mdi-currency-usd</v-icon> Giá
        </div>
        <v-row dense>
          <v-col cols="12" sm="6">
            <v-text-field v-model="form.priceVnd" label="Giá bán (VND)" type="number" :disabled="saving" density="compact" />
          </v-col>
          <v-col cols="12" sm="6">
            <v-text-field v-model="form.priceRentVnd" label="Giá cho thuê (VND/tháng)" type="number" :disabled="saving" density="compact" />
          </v-col>
          <v-col cols="12" sm="4">
            <v-select
              v-model="form.priceBasisCode"
              label="Cơ sở giá"
              :items="PRICE_BASIS_OPTIONS"
              item-title="label"
              item-value="value"
              :disabled="saving"
              clearable
              density="compact"
            />
          </v-col>
          <v-col cols="12" sm="4">
            <v-text-field v-model="form.priceTtsVnd" label="Giá theo TTS (VND)" type="number" :disabled="saving" density="compact" />
          </v-col>
          <v-col cols="12" sm="4">
            <v-text-field v-model="form.priceHtlsVnd" label="Giá theo HTLS (VND)" type="number" :disabled="saving" density="compact" />
          </v-col>
          <v-col cols="12" sm="4">
            <v-text-field v-model="form.unitPriceTtsVnd" label="Đơn giá TTS (VND/m²)" type="number" :disabled="saving" density="compact" />
          </v-col>
        </v-row>

        <!-- ════════ Đặc điểm & pháp lý ════════ -->
        <div class="pfd-sec">
          <v-icon size="14">mdi-compass-outline</v-icon> Đặc điểm & pháp lý
        </div>
        <v-row dense>
          <v-col cols="12" sm="4">
            <v-select
              v-model="form.directionCode"
              label="Hướng"
              :items="directionOptions"
              item-title="label"
              item-value="code"
              :disabled="saving"
              clearable
              density="compact"
            />
          </v-col>
          <v-col cols="12" sm="4">
            <v-select
              v-model="form.viewCode"
              label="View"
              :items="viewOptions"
              item-title="label"
              item-value="code"
              :disabled="saving"
              clearable
              density="compact"
            />
          </v-col>
          <v-col cols="12" sm="4">
            <v-text-field v-model="form.handoverYear" label="Năm bàn giao" type="number" :disabled="saving" density="compact" />
          </v-col>
          <v-col cols="12" sm="4">
            <v-select
              v-model="form.handoverCode"
              label="Bàn giao"
              :items="handoverOptions"
              item-title="label"
              item-value="code"
              :disabled="saving"
              clearable
              density="compact"
            />
          </v-col>
          <v-col cols="12" sm="4">
            <v-select
              v-model="form.furnitureCode"
              label="Nội thất"
              :items="furnitureOptions"
              item-title="label"
              item-value="code"
              :disabled="saving"
              clearable
              density="compact"
            />
          </v-col>
          <v-col cols="12" sm="4">
            <v-select
              v-model="form.specialMechanismCode"
              label="Cơ chế đặc biệt"
              :items="mechanismOptions"
              item-title="label"
              item-value="code"
              :disabled="saving"
              clearable
              density="compact"
            />
          </v-col>
          <v-col cols="12" sm="4">
            <v-select
              v-model="form.legalCode"
              label="Pháp lý"
              :items="legalOptions"
              item-title="label"
              item-value="code"
              :disabled="saving"
              clearable
              density="compact"
            />
          </v-col>
          <v-col cols="12" sm="8">
            <v-text-field v-model="form.legalNote" label="Ghi chú pháp lý" :disabled="saving" density="compact" />
          </v-col>
          <v-col cols="12">
            <v-textarea v-model="form.note" label="Ghi chú" rows="2" auto-grow :disabled="saving" density="compact" />
          </v-col>
        </v-row>

        <v-alert v-if="formError" type="error" density="compact" class="mt-2">{{ formError }}</v-alert>
      </v-card-text>

      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" :disabled="saving" @click="$emit('update:modelValue', false)">Huỷ</v-btn>
        <v-btn
          color="primary"
          :loading="saving"
          :disabled="!form.unitCode.trim() || saving"
          @click="handleSubmit"
        >
          {{ isEdit ? 'Lưu' : 'Thêm căn' }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  useProperties,
  fetchMasterItems,
  toNumString,
  type MasterOption,
  type PropertyItem,
} from '@/composables/use-properties';
import { useProjects } from '@/composables/use-projects';
import { useAgencies } from '@/composables/use-agencies';

/**
 * PropertyFormDialog — form dùng chung cho Căn (Property): tạo căn lẻ + sửa căn.
 * Dùng chung cho PropertyListView (Thêm căn lẻ / Sửa nhanh) và PropertyDetailView
 * (Sửa). Parent xử lý toast + reload qua event `saved` (component không tự toast
 * để tránh toast trùng khi có nhiều chỗ mở).
 *
 * Props:
 *   modelValue   — v-model, mở/đóng dialog
 *   mode         — 'create' | 'edit'
 *   property     — bắt buộc khi mode='edit' (prefill + gọi updateProperty)
 *   projectId    — prefill Dự án khi tạo trực tiếp từ trang dự án (optional)
 * Emits:
 *   update:modelValue (boolean)
 *   saved (PropertyItem) — trả property vừa tạo/sửa từ server
 */
const props = withDefaults(defineProps<{
  modelValue: boolean;
  mode: 'create' | 'edit';
  property?: PropertyItem | null;
  projectId?: string;
}>(), {
  property: null,
  projectId: '',
});

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void;
  (e: 'saved', property: PropertyItem): void;
}>();

const isEdit = computed(() => props.mode === 'edit');

// ── Static options (enum trong schema, không phải MasterData) ──
const CATEGORY_OPTIONS = [
  { value: 'HIGH_RISE', label: 'Cao tầng' },
  { value: 'LOW_RISE', label: 'Thấp tầng' },
  { value: 'LAND', label: 'Đất nền' },
];
const TRANSACTION_OPTIONS = [
  { value: 'SALE', label: 'Bán' },
  { value: 'RENT', label: 'Cho thuê' },
];
const PRICE_BASIS_OPTIONS = [
  { value: 'TOTAL', label: 'Tổng giá' },
  { value: 'PER_M2', label: 'Theo m²' },
];

// ── Composable state ──
const { createProperty, updateProperty } = useProperties();
const { projects, fetchProjects } = useProjects();
const { agencies, fetchAgencies } = useAgencies();

const masterLoaded = ref(false);
const optionsLoading = ref(false);
const saving = ref(false);
const formError = ref('');

// MasterData options (dùng chung cho cả 2 mode)
const typeOptions = ref<MasterOption[]>([]);
const statusOptions = ref<MasterOption[]>([]);
const directionOptions = ref<MasterOption[]>([]);
const viewOptions = ref<MasterOption[]>([]);
const handoverOptions = ref<MasterOption[]>([]);
const furnitureOptions = ref<MasterOption[]>([]);
const legalOptions = ref<MasterOption[]>([]);
const mechanismOptions = ref<MasterOption[]>([]);

// ── Form state — mọi giá trị là string để v-model với v-text-field/v-select.
// BigInt giá từ API về dạng string → giữ raw digits trong form, parse khi gửi.
interface FormState {
  unitCode: string;
  projectId: string;
  agencyId: string;
  zoneName: string;
  blockName: string;
  propertyTypeCode: string;
  statusCode: string;
  category: string;
  transactionType: string;
  floorNo: string;
  totalFloors: string;
  bedrooms: string;
  bathrooms: string;
  usableAreaM2: string;
  timTuongAreaM2: string;
  priceVnd: string;
  priceRentVnd: string;
  priceBasisCode: string;
  priceTtsVnd: string;
  priceHtlsVnd: string;
  unitPriceTtsVnd: string;
  specialMechanismCode: string;
  directionCode: string;
  viewCode: string;
  handoverCode: string;
  furnitureCode: string;
  legalCode: string;
  legalNote: string;
  note: string;
  handoverYear: string;
}

function emptyForm(): FormState {
  return {
    unitCode: '',
    projectId: props.projectId ?? '',
    agencyId: '',
    zoneName: '',
    blockName: '',
    propertyTypeCode: '',
    statusCode: 'AVAILABLE',
    category: '',
    transactionType: 'SALE',
    floorNo: '',
    totalFloors: '',
    bedrooms: '',
    bathrooms: '',
    usableAreaM2: '',
    timTuongAreaM2: '',
    priceVnd: '',
    priceRentVnd: '',
    priceBasisCode: 'TOTAL',
    priceTtsVnd: '',
    priceHtlsVnd: '',
    unitPriceTtsVnd: '',
    specialMechanismCode: '',
    directionCode: '',
    viewCode: '',
    handoverCode: '',
    furnitureCode: '',
    legalCode: '',
    legalNote: '',
    note: '',
    handoverYear: '',
  };
}

function fromProperty(p: PropertyItem): FormState {
  return {
    unitCode: p.unitCode,
    projectId: p.projectId,
    agencyId: p.agencyId ?? '',
    zoneName: p.zoneName ?? '',
    blockName: p.blockName ?? '',
    propertyTypeCode: p.propertyTypeCode ?? '',
    statusCode: p.statusCode || 'AVAILABLE',
    category: p.category ?? '',
    transactionType: p.transactionType ?? 'SALE',
    floorNo: p.floorNo != null ? String(p.floorNo) : '',
    totalFloors: p.totalFloors != null ? String(p.totalFloors) : '',
    bedrooms: p.bedrooms != null ? String(p.bedrooms) : '',
    bathrooms: p.bathrooms != null ? String(p.bathrooms) : '',
    usableAreaM2: p.usableAreaM2 != null ? String(p.usableAreaM2) : '',
    timTuongAreaM2: p.timTuongAreaM2 != null ? String(p.timTuongAreaM2) : '',
    priceVnd: toNumString(p.priceVnd),
    priceRentVnd: toNumString(p.priceRentVnd),
    priceBasisCode: p.priceBasisCode ?? 'TOTAL',
    priceTtsVnd: toNumString(p.priceTtsVnd),
    priceHtlsVnd: toNumString(p.priceHtlsVnd),
    unitPriceTtsVnd: toNumString(p.unitPriceTtsVnd),
    specialMechanismCode: p.specialMechanismCode ?? '',
    directionCode: p.directionCode ?? '',
    viewCode: p.viewCode ?? '',
    handoverCode: p.handoverCode ?? '',
    furnitureCode: p.furnitureCode ?? '',
    legalCode: p.legalCode ?? '',
    legalNote: p.legalNote ?? '',
    note: p.note ?? '',
    handoverYear: p.handoverYear != null ? String(p.handoverYear) : '',
  };
}

const form = ref<FormState>(emptyForm());

// Watch cả modelValue, mode lẫn property: parent có thể set property + mở dialog
// cùng tick → watcher phải đọc được property MỚI NHẤT, không phải bản cũ.
watch([() => props.modelValue, () => props.mode, () => props.property], async ([open, mode, property]) => {
  if (!open) return;
  formError.value = '';
  form.value = mode === 'edit' && property
    ? fromProperty(property)
    : emptyForm();
  await loadOptions();
});

async function loadOptions() {
  if (optionsLoading.value) return;
  optionsLoading.value = true;
  try {
    const tasks: Promise<unknown>[] = [fetchProjects(), fetchAgencies()];
    if (!masterLoaded.value) {
      tasks.push(
        fetchMasterItems('LOAI_CAN').then((v) => { typeOptions.value = v; }),
        fetchMasterItems('TRANG_THAI_CAN').then((v) => { statusOptions.value = v; }),
        fetchMasterItems('HUONG').then((v) => { directionOptions.value = v; }),
        fetchMasterItems('VIEW').then((v) => { viewOptions.value = v; }),
        fetchMasterItems('BAN_GIAO').then((v) => { handoverOptions.value = v; }),
        fetchMasterItems('NOI_THAT').then((v) => { furnitureOptions.value = v; }),
        fetchMasterItems('PHAPLY').then((v) => { legalOptions.value = v; }),
        fetchMasterItems('CO_CHE_DAC_BIET').then((v) => { mechanismOptions.value = v; }),
      );
    }
    await Promise.all(tasks);
    masterLoaded.value = true;
  } finally {
    optionsLoading.value = false;
  }
}

// ── Payload ──
/** Trim string → null nếu rỗng. */
function opt(v: string): string | null {
  const t = v.trim();
  return t ? t : null;
}

/** Parse số nguyên/thực → Number hoặc null. */
function toNum(v: string): number | null {
  const t = v.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Giá: lấy digits từ raw string (BigInt từ API về dạng string) → Number khi gửi. */
function toPriceNum(v: string): number | null {
  const digits = toNumString(v);
  if (!digits) return null;
  const n = Number(digits);
  return Number.isFinite(n) ? n : null;
}

function buildPayload(): Record<string, unknown> {
  return {
    unitCode: form.value.unitCode.trim(),
    projectId: form.value.projectId,
    agencyId: opt(form.value.agencyId),
    zoneName: opt(form.value.zoneName),
    blockName: opt(form.value.blockName),
    propertyTypeCode: opt(form.value.propertyTypeCode),
    statusCode: form.value.statusCode || 'AVAILABLE',
    category: opt(form.value.category),
    transactionType: opt(form.value.transactionType),
    floorNo: toNum(form.value.floorNo),
    totalFloors: toNum(form.value.totalFloors),
    bedrooms: toNum(form.value.bedrooms),
    bathrooms: toNum(form.value.bathrooms),
    usableAreaM2: toNum(form.value.usableAreaM2),
    timTuongAreaM2: toNum(form.value.timTuongAreaM2),
    priceVnd: toPriceNum(form.value.priceVnd),
    priceRentVnd: toPriceNum(form.value.priceRentVnd),
    priceBasisCode: opt(form.value.priceBasisCode),
    priceTtsVnd: toPriceNum(form.value.priceTtsVnd),
    priceHtlsVnd: toPriceNum(form.value.priceHtlsVnd),
    unitPriceTtsVnd: toPriceNum(form.value.unitPriceTtsVnd),
    specialMechanismCode: opt(form.value.specialMechanismCode),
    directionCode: opt(form.value.directionCode),
    viewCode: opt(form.value.viewCode),
    handoverCode: opt(form.value.handoverCode),
    furnitureCode: opt(form.value.furnitureCode),
    legalCode: opt(form.value.legalCode),
    legalNote: opt(form.value.legalNote),
    note: opt(form.value.note),
    handoverYear: toNum(form.value.handoverYear),
  };
}

async function handleSubmit() {
  if (saving.value) return;
  if (!form.value.unitCode.trim()) {
    formError.value = 'Mã căn là bắt buộc';
    return;
  }
  if (!form.value.projectId) {
    formError.value = 'Dự án là bắt buộc';
    return;
  }
  saving.value = true;
  formError.value = '';
  try {
    const payload = buildPayload();
    const saved = props.mode === 'edit' && props.property
      ? await updateProperty(props.property.id, payload)
      : await createProperty(payload);
    if (saved) {
      emit('saved', saved);
      emit('update:modelValue', false);
    }
  } catch (err) {
    formError.value = (err as { response?: { data?: { error?: string } } }).response?.data?.error
      ?? 'Lưu thất bại — thử lại';
  } finally {
    saving.value = false;
  }
}
</script>

<style scoped>
/* Prefix pfd- * — dialog dùng chung, tránh đụng global theme. */
.pfd-card { border-radius: 12px; }
.pfd-title { font-size: 15.5px; font-weight: 600; display: flex; align-items: center; }
.pfd-body { max-height: 68vh; overflow-y: auto; }
.pfd-sec {
  display: flex; align-items: center; gap: 6px;
  font-size: 12px; font-weight: 700; letter-spacing: .03em;
  text-transform: uppercase; color: var(--brand-700, #0b5880);
  border-bottom: 1px solid var(--line-2, #edf0f5);
  padding-bottom: 6px; margin: 10px 0 6px;
}
.pfd-sec:first-child { margin-top: 0; }
</style>