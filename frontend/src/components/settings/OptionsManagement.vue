<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Nguyễn Tiến Lộc -->
<!--
  OptionsManagement.vue — Trang "Tùy chọn" (/settings/crm/options).
  Quản lý MasterData: nhóm (category) + item (code/label/thứ tự/màu/bật-tắt).
  Copy pattern StatusManagement.vue (v-data-table + modal form + modal xoá),
  state qua composable use-master-data.ts (không tạo Pinia store mới).
-->
<template>
  <div>
    <div class="d-flex align-center mb-4 flex-wrap ga-2">
      <!-- Chọn nhóm danh mục -->
      <v-select
        v-model="selectedCategoryKey"
        :items="categories"
        item-title="label"
        item-value="key"
        label="Nhóm danh mục"
        density="compact"
        hide-details
        style="max-width: 280px"
        prepend-inner-icon="mdi-format-list-bulleted"
        :loading="loading && !categories.length"
        @update:model-value="onCategoryChange"
      />
      <v-spacer />
      <!-- Tìm trong nhóm -->
      <v-text-field
        v-model="search"
        prepend-inner-icon="mdi-magnify"
        placeholder="Tìm theo mã / nhãn…"
        density="compact"
        hide-details
        clearable
        style="max-width: 240px"
        @update:model-value="onSearch"
        @click:clear="onSearch"
      />
      <v-btn color="primary" prepend-icon="mdi-plus" :disabled="!selectedCategoryKey" @click="openCreate">
        Thêm mục
      </v-btn>
    </div>

    <v-alert v-if="error" type="error" density="compact" class="mb-3">{{ error }}</v-alert>

    <v-card>
      <v-data-table
        :headers="headers"
        :items="visibleItems"
        :loading="loading"
        no-data-text="Chưa có danh mục trong nhóm này"
        items-per-page="50"
      >
        <template #item.sortOrder="{ item }">
          <div class="d-flex align-center">
            <span class="num">{{ item.sortOrder }}</span>
            <!-- Khi đang lọc (tìm kiếm) danh sách không đủ → không cho đổi thứ tự. -->
            <v-btn icon size="small" title="Lên 1 bước" @click="moveItem(item, -1)" :disabled="!!search || item.sortOrder <= 1"><v-icon>mdi-arrow-up</v-icon></v-btn>
            <v-btn icon size="small" title="Xuống 1 bước" @click="moveItem(item, 1)" :disabled="!!search || item.sortOrder >= visibleItems.length"><v-icon>mdi-arrow-down</v-icon></v-btn>
          </div>
        </template>
        <template #item.code="{ item }">
          <code class="text-caption">{{ item.code }}</code>
        </template>
        <template #item.label="{ item }">
          <span v-if="item.color" class="status-chip-preview" :style="{ background: chipBg(item.color), color: chipFg(item.color) }">{{ item.label }}</span>
          <span v-else>{{ item.label }}</span>
        </template>
        <template #item.parentCode="{ item }">
          <span v-if="item.parentCode" class="text-caption">{{ item.parentCode }}</span>
          <span v-else class="text-grey">—</span>
        </template>
        <template #item.isActive="{ item }">
          <v-icon v-if="item.isActive" color="success" size="18">mdi-check-circle</v-icon>
          <v-icon v-else color="grey" size="18">mdi-minus-circle-outline</v-icon>
        </template>
        <template #item.actions="{ item }">
          <v-btn icon size="small" title="Chỉnh sửa" @click="openEdit(item)"><v-icon>mdi-pencil</v-icon></v-btn>
          <v-btn icon size="small" color="error" title="Xóa" @click="confirmDelete(item)"><v-icon>mdi-delete</v-icon></v-btn>
        </template>
      </v-data-table>
    </v-card>

    <!-- Create / Edit dialog -->
    <v-dialog v-model="showForm" max-width="460">
      <v-card>
        <v-card-title>{{ editing ? 'Chỉnh sửa danh mục' : `Thêm danh mục — ${selectedCategoryLabel}` }}</v-card-title>
        <v-card-text>
          <v-text-field v-model="form.code" label="Mã (code) *" hint="Mã ổn định, không đổi sau khi dùng (vd: facebook, cao_cap). Chỉ sửa được khi mới tạo." persistent-hint :disabled="!!editing" />
          <v-text-field v-model="form.label" label="Nhãn hiển thị *" />
          <v-text-field v-model="form.parentCode" label="Mã cha (parentCode)" hint="Để trống nếu là nhóm cấp 1" persistent-hint />
          <div class="d-flex align-center mt-3 mb-2">
            <span class="text-body-2 mr-3">Màu chip:</span>
            <input type="color" v-model="form.color" class="color-input" />
            <code class="ml-2">{{ form.color }}</code>
          </div>
          <v-text-field v-model.number="form.sortOrder" type="number" label="Thứ tự (nên để mặc định)" />
          <v-checkbox v-model="form.isActive" label="Đang hoạt động" density="compact" hide-details />
          <v-alert v-if="formError" type="error" density="compact" class="mt-3">{{ formError }}</v-alert>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="showForm = false">Hủy</v-btn>
          <v-btn color="primary" :loading="saving" @click="handleSubmit">{{ editing ? 'Lưu' : 'Tạo' }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useMasterData, type MasterDataItem } from '@/composables/use-master-data';
import { useToast } from '@/composables/use-toast';
import { useConfirm } from '@/composables/use-confirm';

const {
  categories,
  loading,
  saving,
  error,
  fetchCategories,
  fetchItems,
  itemsOf,
  createItem,
  updateItem,
  deleteItem,
  reorderItems,
} = useMasterData();

const toast = useToast();
const { confirm } = useConfirm();

const selectedCategoryKey = ref('');
const search = ref('');
let searchTimer: ReturnType<typeof setTimeout> | null = null;

const showForm = ref(false);
const editing = ref<MasterDataItem | null>(null);
const formError = ref('');
const form = ref({ code: '', label: '', parentCode: '', color: '#9CA3AF', sortOrder: 1, isActive: true });

const headers = [
  { title: 'TT', key: 'sortOrder', width: 120, sortable: false },
  { title: 'Mã', key: 'code', width: 140 },
  { title: 'Nhãn', key: 'label' },
  { title: 'Cha', key: 'parentCode', width: 120 },
  { title: 'Hoạt động', key: 'isActive', width: 100, sortable: false },
  { title: 'Hành động', key: 'actions', sortable: false, align: 'end' as const, width: 100 },
];

const visibleItems = computed<MasterDataItem[]>(() => {
  const items = itemsOf(selectedCategoryKey.value);
  const q = search.value.trim().toLowerCase();
  if (!q) return items;
  return items.filter(
    (i) => i.code.toLowerCase().includes(q) || i.label.toLowerCase().includes(q),
  );
});

const selectedCategoryLabel = computed(
  () => categories.value.find((c) => c.key === selectedCategoryKey.value)?.label ?? '',
);

function openCreate() {
  editing.value = null;
  form.value = {
    code: '',
    label: '',
    parentCode: '',
    color: '#9CA3AF',
    sortOrder: (itemsOf(selectedCategoryKey.value).length || 0) + 1,
    isActive: true,
  };
  formError.value = '';
  showForm.value = true;
}

function openEdit(item: MasterDataItem) {
  editing.value = item;
  form.value = {
    code: item.code,
    label: item.label,
    parentCode: item.parentCode ?? '',
    color: item.color ?? '#9CA3AF',
    sortOrder: item.sortOrder,
    isActive: item.isActive,
  };
  formError.value = '';
  showForm.value = true;
}

async function handleSubmit() {
  if (!form.value.code.trim()) { formError.value = 'Mã không được trống'; return; }
  if (!form.value.label.trim()) { formError.value = 'Nhãn không được trống'; return; }
  saving.value = true;
  formError.value = '';
  // composable bắt lỗi trong và set error (không throw) → kiểm tra kết quả trả về
  if (editing.value) {
    const item = await updateItem(editing.value.id, {
      label: form.value.label,
      parentCode: form.value.parentCode || null,
      color: form.value.color,
      sortOrder: form.value.sortOrder,
      isActive: form.value.isActive,
    }, selectedCategoryKey.value);
    if (item) { toast.success('Đã cập nhật'); showForm.value = false; }
  } else {
    const item = await createItem({
      categoryKey: selectedCategoryKey.value,
      code: form.value.code.trim(),
      label: form.value.label.trim(),
      parentCode: form.value.parentCode || null,
      color: form.value.color,
      sortOrder: form.value.sortOrder,
      isActive: form.value.isActive,
    });
    if (item) { toast.success('Đã tạo danh mục'); showForm.value = false; }
  }
  saving.value = false;
}

async function confirmDelete(item: MasterDataItem) {
  const ok = await confirm({
    title: 'Xóa danh mục?',
    message: `Xóa "${item.label}" (${item.code})? Danh mục đang được dùng sẽ bị backend chặn.`,
    tone: 'danger',
    confirmText: 'Xóa',
  });
  if (!ok) return;
  const done = await deleteItem(item.id, selectedCategoryKey.value);
  if (done) toast.success('Đã xóa');
}

async function moveItem(item: MasterDataItem, delta: number) {
  // Lấy thứ tự hiện tại, swap 2 vị trí rồi gửi lại toàn bộ danh sách cho reorder
  const sorted = [...itemsOf(selectedCategoryKey.value)].sort((a, b) => a.sortOrder - b.sortOrder);
  const idx = sorted.findIndex((x) => x.id === item.id);
  const targetIdx = idx + delta;
  if (targetIdx < 0 || targetIdx >= sorted.length) return;

  const ids = sorted.map((x) => x.id);
  [ids[idx], ids[targetIdx]] = [ids[targetIdx], ids[idx]];
  const ok = await reorderItems(selectedCategoryKey.value, ids);
  if (ok) toast.success('Đã đổi thứ tự');
  else toast.error('Đổi thứ tự thất bại');
}

function onCategoryChange() {
  search.value = '';
  void fetchItems(selectedCategoryKey.value);
}

function onSearch() {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => void fetchItems(selectedCategoryKey.value, search.value.trim()), 300);
}

async function init() {
  const cats = await fetchCategories();
  if (cats.length) {
    selectedCategoryKey.value = cats[0].key;
    await fetchItems(selectedCategoryKey.value);
  }
}

onMounted(init);

// Màu chip: nền nhạt từ hex, chữ giữ nguyên hex (copy pattern StatusManagement.vue).
function chipBg(hex: string | null): string {
  if (!hex) return 'rgba(90,100,120,0.10)';
  const m = hex.match(/^#([0-9a-f]{6})$/i);
  if (!m) return 'rgba(90,100,120,0.10)';
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},0.15)`;
}
function chipFg(hex: string | null): string {
  return hex || 'var(--smax-grey-700)';
}
</script>

<style scoped>
.status-chip-preview { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 12px; font-weight: 500; }
.color-input { width: 40px; height: 28px; border: 1px solid var(--smax-grey-300); border-radius: 4px; cursor: pointer; padding: 0; }
</style>