<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Nguyen Tien Loc -->
<!--
  CampaignScriptsPage — Cài đặt "Kịch bản tin nhắn" (P0 CRM 2026-11-16).
  CRUD CampaignScript: friend_request / greeting / care. Admin/owner được ghi
  (pattern assertWritable phía BE). DELETE có thể 409 IN_USE (đợt chạy đang dùng).
  Contract:
    GET    /api/v1/campaign-scripts?kind=&activeOnly=1 → { scripts: [...] }
    POST   /api/v1/campaign-scripts  {name,kind,content,mediaUrls?,isActive?} → {script}
    PUT    /api/v1/campaign-scripts/:id                → {script}
    DELETE /api/v1/campaign-scripts/:id                → {deleted:true} (409 IN_USE)
-->
<template>
  <div class="csp-settings">
    <header class="csp-head">
      <div class="csp-ico"><v-icon size="22">mdi-script-text-outline</v-icon></div>
      <div>
        <h1 class="csp-h1">Kịch bản tin nhắn</h1>
        <p class="csp-sub">
          Mẫu nội dung dùng cho đợt chạy chiến dịch: kết bạn (<b>friend_request</b>), chào
          (<b>greeting</b>) và chăm sóc (<b>care</b>). Hỗ trợ biến
          <code v-for="v in TPL_VARS" :key="v">{{ v }}</code>
          <span class="csp-sub-note">(thay tự động khi gửi)</span>
        </p>
      </div>
    </header>

    <div class="csp-toolbar">
      <div class="csp-tabs">
        <button
          v-for="t in KIND_TABS"
          :key="t.value"
          class="csp-tab"
          :class="{ active: kindFilter === t.value }"
          @click="onSwitchKind(t.value)"
        >
          <v-icon size="14">{{ t.icon }}</v-icon>
          {{ t.label }}
          <span v-if="t.value === ''" class="csp-tab-count num">{{ total }}</span>
        </button>
      </div>
      <button class="btn btn-primary btn-sm" :disabled="!canEdit" @click="openCreate">
        <v-icon size="15">mdi-plus-circle-outline</v-icon> Tạo kịch bản
      </button>
    </div>

    <div v-if="loading" class="csp-loading">
      <v-icon size="16" class="spin">mdi-loading</v-icon> Đang tải...
    </div>

    <div v-else-if="scripts.length === 0" class="csp-empty">
      <v-icon size="36">mdi-script-text-outline</v-icon>
      <h3>Chưa có kịch bản nào</h3>
      <p>Bấm "Tạo kịch bản" để soạn nội dung dùng cho đợt chạy kết bạn / chăm sóc.</p>
    </div>

    <div v-else class="card table-card csp-card">
      <table class="tbl csp-table">
        <thead>
          <tr>
            <th>Tên</th>
            <th>Loại</th>
            <th>Nội dung</th>
            <th>Kích hoạt</th>
            <th class="right"></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="s in scripts" :key="s.id">
            <td class="cell-strong">{{ s.name }}</td>
            <td><span class="chip" :class="kindChip(s.kind)">{{ kindLabel(s.kind) }}</span></td>
            <td><div class="csp-content">{{ s.content }}</div></td>
            <td>
              <v-switch
                :model-value="s.isActive"
                color="primary"
                hide-details
                density="compact"
                :disabled="!canEdit || toggleBusyId === s.id"
                @update:model-value="(v: boolean | string | number | null) => toggleActive(s, !!v)"
              />
            </td>
            <td class="row-actions">
              <button class="btn btn-ghost btn-icon btn-sm" title="Sửa" :disabled="!canEdit" @click="openEdit(s)">
                <v-icon size="15">mdi-pencil-outline</v-icon>
              </button>
              <button class="btn btn-ghost btn-icon btn-sm" title="Xoá" :disabled="!canEdit" @click="confirmDelete(s)">
                <v-icon size="15">mdi-delete-outline</v-icon>
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Dialog thêm / sửa -->
    <v-dialog v-model="showForm" max-width="580">
      <v-card>
        <v-card-title>
          <v-icon size="18">mdi-script-text-outline</v-icon>
          {{ editing ? 'Sửa kịch bản' : 'Tạo kịch bản' }}
        </v-card-title>
        <v-card-text>
          <v-text-field v-model="form.name" label="Tên kịch bản *" />
          <v-select
            v-model="form.kind"
            label="Loại"
            :items="KIND_OPTIONS"
            item-title="label"
            item-value="value"
            hint="friend_request: lời chào sau khi kết bạn · greeting: chào chung · care: vòng chăm sóc"
            persistent-hint
          />
          <v-textarea
            v-model="form.content"
            label="Nội dung *"
            auto-grow
            rows="5"
            :counter="4000"
            hint="Biến: {{tên}}, {{số_điện_thoại}}, {{dự_án}}"
            persistent-hint
          />
          <v-switch v-model="form.isActive" label="Đang hoạt động" color="primary" hide-details inset />
          <v-alert v-if="formError" type="error" density="compact" class="mt-3">{{ formError }}</v-alert>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="showForm = false">Huỷ</v-btn>
          <v-btn color="primary" :loading="saving" :disabled="!canEdit" @click="submit">
            {{ editing ? 'Lưu' : 'Tạo' }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { useToast } from '@/composables/use-toast';
import { useConfirm } from '@/composables/use-confirm';
import {
  useCampaignRuns,
  SCRIPT_KINDS,
  type CampaignScriptItem,
  type ScriptPayload,
} from '@/composables/use-campaign-runs';

const toast = useToast();
const { confirm } = useConfirm();
const auth = useAuthStore();

const { fetchScripts, createScript, updateScript, deleteScript } = useCampaignRuns();

// Biến kịch bản — để trong script (giá trị dữ liệu) thay vì template literal
// trong template (Vue compiler đọc nhầm `}}` trong chuỗi thành điểm đóng interpolation).
const TPL_VARS = ['{{tên}}', '{{số_điện_thoại}}', '{{dự_án}}'];

const KIND_TABS = [
  { value: '', label: 'Tất cả', icon: 'mdi-view-list' },
  ...SCRIPT_KINDS.map((k) => ({ value: k.value, label: k.label, icon: scriptKindIcon(k.value) })),
];

const KIND_OPTIONS = SCRIPT_KINDS.map((k) => ({ value: k.value, label: k.label }));

const canEdit = computed(() => ['owner', 'admin'].includes(auth.user?.role ?? ''));

const scripts = ref<CampaignScriptItem[]>([]);
const total = ref(0);
const loading = ref(false);
const saving = ref(false);
const formError = ref('');
const kindFilter = ref('');
const showForm = ref(false);
const editing = ref<CampaignScriptItem | null>(null);
const toggleBusyId = ref<string | null>(null);

interface ScriptForm {
  name: string;
  kind: string;
  content: string;
  isActive: boolean;
}

const form = ref<ScriptForm>(emptyForm());

function emptyForm(): ScriptForm {
  return { name: '', kind: 'friend_request', content: '', isActive: true };
}

onMounted(load);

async function load() {
  loading.value = true;
  try {
    const list = await fetchScripts({ kind: kindFilter.value || undefined });
    scripts.value = list;
    total.value = list.length;
  } finally {
    loading.value = false;
  }
}

function onSwitchKind(kind: string) {
  kindFilter.value = kind;
  load();
}

function openCreate() {
  editing.value = null;
  form.value = emptyForm();
  formError.value = '';
  showForm.value = true;
}

function openEdit(s: CampaignScriptItem) {
  editing.value = s;
  form.value = { name: s.name, kind: s.kind, content: s.content, isActive: s.isActive };
  formError.value = '';
  showForm.value = true;
}

async function toggleActive(s: CampaignScriptItem, v: boolean) {
  if (s.isActive === v || toggleBusyId.value) return;
  toggleBusyId.value = s.id;
  try {
    await updateScript(s.id, { isActive: v });
    s.isActive = v;
    toast.success(v ? `Đã kích hoạt "${s.name}"` : `Đã tắt "${s.name}"`);
  } catch (err) {
    const msg = (err as { response?: { data?: { error?: string } } }).response?.data?.error
      ?? 'Cập nhật trạng thái thất bại';
    toast.error(msg, 5000);
  } finally {
    toggleBusyId.value = null;
  }
}

async function submit() {
  if (!form.value.name.trim()) { formError.value = 'Tên kịch bản không được trống'; return; }
  if (!form.value.content.trim()) { formError.value = 'Nội dung không được trống'; return; }
  saving.value = true;
  formError.value = '';
  try {
    const payload: ScriptPayload = {
      name: form.value.name.trim(),
      kind: form.value.kind,
      content: form.value.content,
      isActive: form.value.isActive,
    };
    if (editing.value) {
      await updateScript(editing.value.id, payload);
      toast.success('Đã cập nhật kịch bản');
    } else {
      await createScript(payload);
      toast.success('Đã tạo kịch bản');
    }
    showForm.value = false;
    await load();
  } catch (err) {
    const code = (err as { response?: { data?: { code?: string } } }).response?.data?.code;
    formError.value = code === 'DUPLICATE_NAME'
      ? 'Tên kịch bản đã tồn tại trong tổ chức'
      : ((err as { response?: { data?: { error?: string } } }).response?.data?.error ?? 'Lưu thất bại — thử lại');
  } finally {
    saving.value = false;
  }
}

async function confirmDelete(s: CampaignScriptItem) {
  if (!(await confirm({
    title: `Xoá kịch bản "${s.name}"?`,
    message: 'Thao tác không thể hoàn tác.',
    tone: 'danger',
    confirmText: 'Xoá',
    cancelText: 'Huỷ',
  }))) return;
  try {
    await deleteScript(s.id);
    toast.success('Đã xoá kịch bản');
    await load();
  } catch (err) {
    const code = (err as { response?: { data?: { code?: string } } }).response?.data?.code;
    const msg = code === 'IN_USE'
      ? 'Kịch bản đang được đợt chạy / chiến dịch sử dụng — không thể xoá'
      : ((err as { response?: { data?: { error?: string } } }).response?.data?.error ?? 'Xoá thất bại');
    toast.error(msg, 5000);
  }
}

// ───────── Helpers ─────────
function scriptKindIcon(kind: string): string {
  if (kind === 'friend_request') return 'mdi-account-plus-outline';
  if (kind === 'greeting') return 'mdi-hand-wave-outline';
  if (kind === 'care') return 'mdi-hand-heart-outline';
  return 'mdi-script-text-outline';
}

function kindLabel(kind: string): string {
  return SCRIPT_KINDS.find((k) => k.value === kind)?.label ?? kind;
}

function kindChip(kind: string): string {
  return SCRIPT_KINDS.find((k) => k.value === kind)?.chip ?? 'chip-grey';
}
</script>

<style scoped>
.csp-settings { font-family: 'Inter', -apple-system, sans-serif; color: #1F2D3D; }
.csp-head { display: flex; gap: 14px; align-items: flex-start; margin-bottom: 18px; }
.csp-ico {
  width: 44px; height: 44px; border-radius: 12px; background: #EEF0FF; color: #5E6AD2;
  display: grid; place-items: center; flex: none;
}
.csp-h1 { font-size: 19px; font-weight: 700; margin: 0 0 4px; }
.csp-sub { font-size: 13px; color: #6B7785; margin: 0; line-height: 1.55; }
.csp-sub code {
  background: #F4F4F7; border: 1px solid #E4E5E9; border-radius: 4px;
  padding: 1px 5px; font-size: 12px; color: #475066;
}

.csp-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; flex-wrap: wrap; }
.csp-tabs {
  display: flex; align-items: center; gap: 4px; flex-wrap: wrap;
  background: #fff; border: 1px solid #E4E5E9; border-radius: 10px; padding: 5px;
}
.csp-tab {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 7px 12px; border-radius: 7px; background: transparent; border: none; cursor: pointer;
  font-size: 12.5px; font-weight: 500; color: #6B7785; font-family: inherit;
}
.csp-tab:hover { background: #F4F4F7; color: #1F2D3D; }
.csp-tab.active { background: #1F2D3D; color: #fff; }
.csp-tab-count { background: rgba(31, 45, 61, 0.12); padding: 0 6px; border-radius: 999px; font-size: 10.5px; font-weight: 700; }
.csp-tab.active .csp-tab-count { background: rgba(255, 255, 255, 0.2); color: #fff; }

.csp-loading { padding: 32px; text-align: center; color: #97A0AC; display: flex; align-items: center; justify-content: center; gap: 8px; }

.csp-empty {
  background: #fff; border: 1px solid #E4E5E9; border-radius: 12px;
  padding: 48px 24px; display: flex; flex-direction: column; align-items: center; text-align: center;
}
.csp-empty .v-icon { color: #B9C0CA; }
.csp-empty h3 { margin: 12px 0 6px; font-size: 16px; font-weight: 700; }
.csp-empty p { margin: 0; font-size: 13px; color: #6B7785; }

.csp-card { overflow: auto; padding: 0; background: #fff; border: 1px solid #E4E5E9; border-radius: 12px; }
.csp-table th.right, .csp-table td.right { text-align: right; }
.csp-content {
  max-width: 420px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 12.5px; color: #475066; font-family: 'JetBrains Mono', 'SFMono-Regular', Consolas, monospace;
}
.row-actions .btn { margin-left: 2px; }
</style>