<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Nguyễn Tiến Lộc -->
<template>
  <div class="project-list-view">
    <!-- Page head -->
    <div class="page-head">
      <div>
        <h1 class="h-page">
          <v-icon size="22" class="head-ico">mdi-domain</v-icon> Dự án
        </h1>
        <div class="t-sub">Danh sách dự án bất động sản — <b>{{ total.toLocaleString('vi-VN') }}</b> dự án</div>
      </div>
      <div class="head-actions">
        <button class="btn btn-ghost btn-sm" @click="$router.push('/properties')">
          <v-icon size="16">mdi-office-building-outline</v-icon> Bảng hàng
        </button>
        <button class="btn btn-primary btn-sm" @click="openCreate">
          <v-icon size="16">mdi-plus-circle-outline</v-icon> Thêm dự án
        </button>
      </div>
    </div>

    <!-- Search -->
    <div class="filter-strip">
      <div class="field sm search">
        <v-icon size="15">mdi-magnify</v-icon>
        <input
          v-model="searchText"
          placeholder="Tìm tên dự án, chủ đầu tư, tỉnh/thành..."
          @input="debouncedSearch"
        />
      </div>
      <span class="count-hint">Tìm thấy {{ total.toLocaleString('vi-VN') }} dự án</span>
    </div>

    <!-- Table -->
    <div class="card table-card">
      <table class="tbl projects-table">
        <thead>
          <tr>
            <th>Tên dự án</th>
            <th>Chủ đầu tư</th>
            <th>Tỉnh / TP</th>
            <th>Quận / huyện</th>
            <th class="right">Năm bàn giao</th>
            <th>Trạng thái</th>
            <th class="right"></th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="loading">
            <td colspan="7" class="empty-cell"><v-icon size="16" class="spin">mdi-loading</v-icon> Đang tải...</td>
          </tr>
          <tr v-else-if="projects.length === 0">
            <td colspan="7" class="empty-cell">Chưa có dự án nào. Bấm "Thêm dự án" để tạo.</td>
          </tr>
          <tr v-for="p in projects" :key="p.id">
            <td class="cell-strong">{{ p.name }}</td>
            <td>{{ p.developer || '—' }}</td>
            <td>{{ p.province || '—' }}</td>
            <td>{{ p.district || '—' }}</td>
            <td class="right num">{{ p.handoverYear ?? '—' }}</td>
            <td>
              <span class="chip" :class="p.isActive ? 'chip-green' : 'chip-grey'">
                <span class="dot"></span>{{ p.isActive ? 'Hoạt động' : 'Ngừng' }}
              </span>
            </td>
            <td class="row-actions">
              <button class="btn btn-ghost btn-icon btn-sm" title="Sửa" @click="openEdit(p)">
                <v-icon size="15">mdi-pencil-outline</v-icon>
              </button>
              <button class="btn btn-ghost btn-icon btn-sm" title="Xoá" @click="confirmDelete(p)">
                <v-icon size="15">mdi-delete-outline</v-icon>
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Pagination -->
    <div v-if="total > limit" class="pager">
      <span class="pager-info">Hiện {{ pageStart }}–{{ pageEnd }} / {{ total.toLocaleString('vi-VN') }} dự án</span>
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
        <v-card-title>{{ editing ? 'Chỉnh sửa dự án' : 'Thêm dự án' }}</v-card-title>
        <v-card-text>
          <v-text-field v-model="form.name" label="Tên dự án *" />
          <v-text-field v-model="form.developer" label="Chủ đầu tư" />
          <div class="d-flex ga-3">
            <v-text-field v-model="form.province" label="Tỉnh / TP" />
            <v-text-field v-model="form.district" label="Quận / huyện" />
          </div>
          <v-text-field v-model="form.address" label="Địa chỉ" />
          <div class="d-flex ga-3">
            <v-text-field v-model="form.handoverYear" label="Năm bàn giao" type="number" />
            <v-checkbox v-model="form.isActive" label="Đang hoạt động" density="compact" hide-details class="mt-2" />
          </div>
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
  useProjects,
  type ProjectItem,
  type ProjectPayload,
} from '@/composables/use-projects';
import { useToast } from '@/composables/use-toast';
import { useConfirm } from '@/composables/use-confirm';

const toast = useToast();
const { confirm } = useConfirm();

const {
  projects,
  total,
  loading,
  page,
  limit,
  fetchProjects,
  search,
  goPage,
  createProject,
  updateProject,
  deleteProject,
} = useProjects();

const showForm = ref(false);
const saving = ref(false);
const editing = ref<ProjectItem | null>(null);
const formError = ref('');
const searchText = ref('');

/** Form state — năm bàn giao để chuỗi (input number), parse khi submit. */
interface ProjectForm {
  name: string;
  developer: string;
  province: string;
  district: string;
  address: string;
  handoverYear: string;
  note: string;
  isActive: boolean;
}

const form = ref<ProjectForm>(emptyForm());

function emptyForm(): ProjectForm {
  return {
    name: '', developer: '', province: '', district: '',
    address: '', handoverYear: '', note: '', isActive: true,
  };
}

const pageStart = computed(() => (page.value - 1) * limit.value + 1);
const pageEnd = computed(() => Math.min(page.value * limit.value, total.value));

onMounted(() => fetchProjects());

let searchTimer: ReturnType<typeof setTimeout> | null = null;
function debouncedSearch() {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => search(searchText.value), 300);
}

function openCreate() {
  editing.value = null;
  form.value = emptyForm();
  formError.value = '';
  showForm.value = true;
}

function openEdit(p: ProjectItem) {
  editing.value = p;
  form.value = {
    name: p.name,
    developer: p.developer ?? '',
    province: p.province ?? '',
    district: p.district ?? '',
    address: p.address ?? '',
    handoverYear: p.handoverYear != null ? String(p.handoverYear) : '',
    note: p.note ?? '',
    isActive: p.isActive,
  };
  formError.value = '';
  showForm.value = true;
}

async function handleSubmit() {
  if (!form.value.name.trim()) { formError.value = 'Tên dự án không được trống'; return; }
  const payload: ProjectPayload = {
    name: form.value.name.trim(),
    developer: form.value.developer || null,
    province: form.value.province || null,
    district: form.value.district || null,
    address: form.value.address || null,
    handoverYear: form.value.handoverYear ? Number(form.value.handoverYear) : null,
    note: form.value.note || null,
    isActive: form.value.isActive,
  };
  saving.value = true;
  formError.value = '';
  try {
    if (editing.value) {
      await updateProject(editing.value.id, payload);
      toast.success('Đã cập nhật dự án');
    } else {
      await createProject(payload);
      toast.success('Đã tạo dự án');
    }
    showForm.value = false;
    await fetchProjects();
  } catch (err) {
    formError.value = (err as { response?: { data?: { error?: string } } }).response?.data?.error ?? 'Lưu thất bại';
  } finally {
    saving.value = false;
  }
}

async function confirmDelete(p: ProjectItem) {
  if (!(await confirm({
    title: `Xoá dự án "${p.name}"?`,
    message: 'Dự án đang có căn sẽ không xoá được (ràng buộc dữ liệu).',
    tone: 'danger',
    confirmText: 'Xoá',
    cancelText: 'Huỷ',
  }))) return;
  try {
    await deleteProject(p.id);
    toast.success('Đã xoá dự án');
    await fetchProjects();
  } catch (err) {
    const msg = (err as { response?: { data?: { error?: string } } }).response?.data?.error ?? 'Xoá thất bại';
    toast.error(msg, 5000);
  }
}
</script>

<style scoped>
.project-list-view { padding: 20px 24px; background: var(--surface-2); min-height: 100%; }
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

.table-card { overflow: auto; padding: 0; }
.projects-table th.right, .projects-table td.right { text-align: right; }
.projects-table .empty-cell { text-align: center; color: var(--ink-4); padding: 28px; }
.row-actions { text-align: right; white-space: nowrap; }
.row-actions .btn { margin-left: 2px; }

.pager { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 12px; }
.pager-info { font-size: 12.5px; color: var(--ink-3); }
.pager-ctrls { display: flex; align-items: center; gap: 8px; }
.pager-cur { font-size: 12px; font-weight: 600; color: var(--ink-2); }
.btn[disabled] { opacity: .45; cursor: not-allowed; }
</style>