<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Nguyễn Tiến Lộc -->
<template>
  <div class="agency-list-view">
    <!-- Page head -->
    <div class="page-head">
      <div>
        <h1 class="h-page">
          <v-icon size="22" class="head-ico">mdi-account-tie-outline</v-icon> Đại lý
        </h1>
        <div class="t-sub">Đối tác phân phối bảng hàng — <b>{{ total.toLocaleString('vi-VN') }}</b> đại lý</div>
      </div>
      <div class="head-actions">
        <button class="btn btn-ghost btn-sm" @click="$router.push('/properties')">
          <v-icon size="16">mdi-office-building-outline</v-icon> Bảng hàng
        </button>
        <button class="btn btn-primary btn-sm" @click="openCreate">
          <v-icon size="16">mdi-plus-circle-outline</v-icon> Thêm đại lý
        </button>
      </div>
    </div>

    <!-- Search -->
    <div class="filter-strip">
      <div class="field sm search">
        <v-icon size="15">mdi-magnify</v-icon>
        <input
          v-model="searchText"
          placeholder="Tìm mã, tên đại lý, SĐT, người liên hệ..."
          @input="debouncedSearch"
        />
      </div>
      <span class="count-hint">Tìm thấy {{ total.toLocaleString('vi-VN') }} đại lý</span>
    </div>

    <!-- Table -->
    <div class="card table-card">
      <table class="tbl agencies-table">
        <thead>
          <tr>
            <th>Mã</th>
            <th>Tên đại lý</th>
            <th>SĐT</th>
            <th>Người liên hệ</th>
            <th>Trạng thái</th>
            <th class="right"></th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="loading">
            <td colspan="6" class="empty-cell"><v-icon size="16" class="spin">mdi-loading</v-icon> Đang tải...</td>
          </tr>
          <tr v-else-if="agencies.length === 0">
            <td colspan="6" class="empty-cell">Chưa có đại lý nào. Bấm "Thêm đại lý" để tạo.</td>
          </tr>
          <tr v-for="a in agencies" :key="a.id">
            <td>
              <span class="key-chip">{{ a.code }}</span>
            </td>
            <td class="cell-strong">{{ a.name }}</td>
            <td>{{ a.phone || '—' }}</td>
            <td>{{ a.contactName || '—' }}</td>
            <td>
              <span class="chip" :class="a.isActive ? 'chip-green' : 'chip-grey'">
                <span class="dot"></span>{{ a.isActive ? 'Hoạt động' : 'Ngừng' }}
              </span>
            </td>
            <td class="row-actions">
              <button class="btn btn-ghost btn-icon btn-sm" title="Sửa" @click="openEdit(a)">
                <v-icon size="15">mdi-pencil-outline</v-icon>
              </button>
              <button class="btn btn-ghost btn-icon btn-sm" title="Xoá" @click="confirmDelete(a)">
                <v-icon size="15">mdi-delete-outline</v-icon>
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Pagination -->
    <div v-if="total > limit" class="pager">
      <span class="pager-info">Hiện {{ pageStart }}–{{ pageEnd }} / {{ total.toLocaleString('vi-VN') }} đại lý</span>
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

    <!-- Create / Edit dialog -->
    <v-dialog v-model="showForm" max-width="480">
      <v-card>
        <v-card-title>{{ editing ? 'Chỉnh sửa đại lý' : 'Thêm đại lý' }}</v-card-title>
        <v-card-text>
          <div class="d-flex ga-3">
            <v-text-field v-model="form.code" label="Mã đại lý *" hint="Mã từ bảng hàng import (vd DL01, HDQ)" persistent-hint />
            <v-text-field v-model="form.name" label="Tên đại lý *" />
          </div>
          <div class="d-flex ga-3">
            <v-text-field v-model="form.phone" label="SĐT" />
            <v-text-field v-model="form.contactName" label="Người liên hệ" />
          </div>
          <v-checkbox v-model="form.isActive" label="Đang hoạt động" density="compact" hide-details />
          <v-textarea v-model="form.note" label="Ghi chú" auto-grow rows="2" />
          <v-alert v-if="formError" type="error" density="compact" class="mt-3">{{ formError }}</v-alert>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="showForm = false">Huỷ</v-btn>
          <v-btn color="primary" :loading="saving" @click="handleSubmit">{{ editing ? 'Lưu' : 'Tạo' }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  useAgencies,
  type AgencyItem,
  type AgencyPayload,
} from '@/composables/use-agencies';
import { useToast } from '@/composables/use-toast';
import { useConfirm } from '@/composables/use-confirm';

const toast = useToast();
const { confirm } = useConfirm();

const {
  agencies,
  total,
  loading,
  page,
  limit,
  fetchAgencies,
  search,
  goPage,
  createAgency,
  updateAgency,
  deleteAgency,
} = useAgencies();

const showForm = ref(false);
const saving = ref(false);
const editing = ref<AgencyItem | null>(null);
const formError = ref('');
const searchText = ref('');

const form = ref<AgencyPayload>({
  code: '', name: '', phone: '', contactName: '', note: '', isActive: true,
});

const pageStart = computed(() => (page.value - 1) * limit.value + 1);
const pageEnd = computed(() => Math.min(page.value * limit.value, total.value));

onMounted(() => fetchAgencies());

let searchTimer: ReturnType<typeof setTimeout> | null = null;
function debouncedSearch() {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => search(searchText.value), 300);
}

function openCreate() {
  editing.value = null;
  form.value = { code: '', name: '', phone: '', contactName: '', note: '', isActive: true };
  formError.value = '';
  showForm.value = true;
}

function openEdit(a: AgencyItem) {
  editing.value = a;
  form.value = {
    code: a.code,
    name: a.name,
    phone: a.phone ?? '',
    contactName: a.contactName ?? '',
    note: a.note ?? '',
    isActive: a.isActive,
  };
  formError.value = '';
  showForm.value = true;
}

async function handleSubmit() {
  if (!form.value.name.trim()) { formError.value = 'Tên đại lý không được trống'; return; }
  if (!form.value.code.trim()) { formError.value = 'Mã đại lý không được trống'; return; }
  saving.value = true;
  formError.value = '';
  try {
    if (editing.value) {
      await updateAgency(editing.value.id, form.value);
      toast.success('Đã cập nhật đại lý');
    } else {
      await createAgency(form.value);
      toast.success('Đã tạo đại lý');
    }
    showForm.value = false;
    await fetchAgencies();
  } catch (err) {
    formError.value = (err as { response?: { data?: { error?: string } } }).response?.data?.error ?? 'Lưu thất bại';
  } finally {
    saving.value = false;
  }
}

async function confirmDelete(a: AgencyItem) {
  if (!(await confirm({
    title: `Xoá đại lý "${a.name}"?`,
    message: 'Căn thuộc đại lý này sẽ chuyển về trống (không xoá theo).',
    tone: 'danger',
    confirmText: 'Xoá',
    cancelText: 'Huỷ',
  }))) return;
  try {
    await deleteAgency(a.id);
    toast.success('Đã xoá đại lý');
    await fetchAgencies();
  } catch (err) {
    const msg = (err as { response?: { data?: { error?: string } } }).response?.data?.error ?? 'Xoá thất bại';
    toast.error(msg, 5000);
  }
}
</script>

<style scoped>
.agency-list-view { padding: 20px 24px; background: var(--surface-2); min-height: 100%; }
.page-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 16px; flex-wrap: wrap; }
.page-head .h-page { display: flex; align-items: center; gap: 8px; margin: 0; }
.head-ico { color: var(--brand); }
.head-actions { display: flex; gap: 8px; flex-wrap: wrap; }

.filter-strip {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  background: var(--surface); border: 1px solid var(--line);
  border-radius: var(--r-md); padding: 10px 12px; margin-bottom: 12px;
}
.filter-strip .search { min-width: 260px; }
.filter-strip .field input { border: none; background: transparent; outline: none; font-size: 12.5px; color: var(--ink); width: 100%; }
.count-hint { font-size: 12px; color: var(--ink-4); }

.key-chip {
  display: inline-block; padding: 2px 8px; font-family: var(--mono); font-weight: 600;
  font-size: 11px; background: var(--surface-3); color: var(--ink);
  border-radius: var(--r-xs); letter-spacing: .5px;
}

.table-card { overflow: auto; padding: 0; }
.agencies-table th.right, .agencies-table td.right { text-align: right; }
.agencies-table .empty-cell { text-align: center; color: var(--ink-4); padding: 28px; }
.row-actions { text-align: right; white-space: nowrap; }
.row-actions .btn { margin-left: 2px; }

.pager { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 12px; }
.pager-info { font-size: 12.5px; color: var(--ink-3); }
.pager-ctrls { display: flex; align-items: center; gap: 8px; }
.pager-cur { font-size: 12px; font-weight: 600; color: var(--ink-2); }
.btn[disabled] { opacity: .45; cursor: not-allowed; }
</style>