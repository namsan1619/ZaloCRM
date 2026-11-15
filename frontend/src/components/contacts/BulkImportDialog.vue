<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Nguyễn Tiến Lộc -->
<!--
  BulkImportDialog.vue — Import khách hàng hàng loạt (P2).
  2 bước: (1) chọn file → upload; (2) theo dõi tiến độ job nền + kết quả
  created/duplicate/invalid + tải file lỗi CSV.
  State + API qua composable use-contacts-import.ts.
  Emit `done` khi job kết thúc để ContactsView refresh danh sách.
-->
<template>
  <v-dialog :model-value="modelValue" max-width="620" @update:model-value="onToggle">
    <v-card>
      <v-card-title class="d-flex align-center">
        <v-icon class="mr-2" color="primary">mdi-file-import-outline</v-icon>
        Import khách hàng
      </v-card-title>

      <v-card-text>
        <v-alert v-if="error" type="error" density="compact" class="mb-3">{{ error }}</v-alert>

        <!-- Bước 1: chọn file -->
        <div v-if="!job">
          <p class="text-body-2 mb-2">
            Tải lên file danh bạ (CSV hoặc Excel). Cột <strong>SĐT</strong> bắt buộc; có thể kèm
            tên, địa chỉ, ghi chú. Hàng trùng SĐT sẽ được đếm là <em>trùng</em>, hàng sai định dạng
            là <em>lỗi</em> — bạn tải được file chi tiết sau khi xử lý.
          </p>
          <v-file-input
            v-model="fileValue"
            label="Chọn file (CSV / XLSX)"
            accept=".csv,.xlsx,.xls"
            prepend-icon="mdi-file-upload-outline"
            :loading="uploading"
            hide-details
          />
        </div>

        <!-- Bước 2: tiến độ + kết quả -->
        <div v-else>
          <div class="d-flex align-center mb-2">
            <div class="text-body-2 font-weight-medium truncate-file">{{ job.fileName || 'Import' }}</div>
            <v-spacer />
            <v-chip size="small" :color="statusColor" text-color="white">{{ statusLabel }}</v-chip>
          </div>
          <v-progress-linear
            :model-value="progressPercent"
            :color="progressColor"
            height="12"
            rounded
            class="mb-3"
          />
          <div class="d-flex justify-space-between text-caption text-grey mb-2">
            <span>{{ progressPercent }}%</span>
            <span>{{ job.processedRows ?? 0 }} / {{ job.totalRows ?? 0 }} dòng đã xử lý</span>
          </div>

          <v-row dense class="mb-2">
            <v-col cols="4"><v-card class="pa-2 text-center" variant="tonal" color="success"><div class="num text-h6">{{ job.createdRows ?? 0 }}</div><div class="text-caption">Đã tạo</div></v-card></v-col>
            <v-col cols="4"><v-card class="pa-2 text-center" variant="tonal" color="warning"><div class="num text-h6">{{ job.duplicateRows ?? 0 }}</div><div class="text-caption">Trùng</div></v-card></v-col>
            <v-col cols="4"><v-card class="pa-2 text-center" variant="tonal" color="error"><div class="num text-h6">{{ job.invalidRows ?? 0 }}</div><div class="text-caption">Lỗi</div></v-card></v-col>
          </v-row>

          <v-alert v-if="isTerminal" :type="job.status === 'done' ? 'success' : 'error'" density="compact">
            <template v-if="job.status === 'done'">
              Import hoàn tất: tạo {{ job.createdRows ?? 0 }} khách, trùng {{ job.duplicateRows ?? 0 }},
              lỗi {{ job.invalidRows ?? 0 }}.
            </template>
            <template v-else-if="job.status === 'failed'">Import thất bại: {{ job.errorReason || 'lỗi không xác định' }}</template>
            <template v-else>Import đã bị huỷ.</template>
            <template v-if="job.status === 'done' && (job.invalidRows ?? 0) > 0">
              <div class="mt-2">
                <v-btn size="small" color="error" variant="tonal" prepend-icon="mdi-download" @click="onDownloadErrors">
                  Tải file lỗi
                </v-btn>
              </div>
            </template>
          </v-alert>
        </div>
      </v-card-text>

      <v-card-actions>
        <v-spacer />
        <template v-if="!job">
          <v-btn @click="onToggle(false)">Hủy</v-btn>
          <v-btn color="primary" :loading="uploading" :disabled="!selectedFile" @click="onUpload">
            <v-icon start>mdi-upload</v-icon> Bắt đầu import
          </v-btn>
        </template>
        <template v-else>
          <v-btn v-if="!isTerminal" @click="onCancel" :disabled="cancelling">
            {{ cancelling ? 'Đang huỷ…' : 'Huỷ import' }}
          </v-btn>
          <v-btn color="primary" @click="onToggle(false)">Đóng</v-btn>
        </template>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useContactsImport, type ContactImportJob } from '@/composables/use-contacts-import';
import { useToast } from '@/composables/use-toast';

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void;
  (e: 'done', job: ContactImportJob): void;
}>();

const toast = useToast();
const { job, uploading, error, upload, startPolling, cancel, downloadErrors, reset } = useContactsImport();

// Vuetify VFileInput modelValue là File | File[] | null (dù không bật multiple,
// vẫn phải khai báo union để v-model không vỡ type ở vue-tsc).
const fileValue = ref<File | File[] | null>(null);
const cancelling = ref(false);
const jobIdRef = ref<string | null>(null);

const selectedFile = computed<File | null>(() => {
  const v = fileValue.value;
  if (!v) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
});

const isTerminal = computed(
  () => !!job.value && ['done', 'failed', 'cancelled'].includes(job.value.status),
);

const progressPercent = computed(() => {
  const j = job.value;
  if (!j) return 0;
  // Server tính sẵn progress (gồm cả dòng lỗi) → ưu tiên; fallback tự tính.
  if (typeof j.progress === 'number') return Math.min(100, Math.max(0, j.progress));
  if (!j.totalRows) return 0;
  return Math.min(100, Math.round(((j.processedRows ?? 0) / j.totalRows) * 100));
});

const statusLabel = computed(() => {
  switch (job.value?.status) {
    case 'pending': return 'Chờ xử lý';
    case 'running': return 'Đang import';
    case 'done': return 'Hoàn tất';
    case 'failed': return 'Thất bại';
    case 'cancelled': return 'Đã huỷ';
    default: return '—';
  }
});

const statusColor = computed(() => {
  switch (job.value?.status) {
    case 'done': return 'success';
    case 'failed': return 'error';
    case 'cancelled': return 'grey';
    default: return 'primary';
  }
});

const progressColor = computed(() => {
  switch (job.value?.status) {
    case 'done': return 'success';
    case 'failed': return 'error';
    default: return 'primary';
  }
});

watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      reset();
      fileValue.value = null;
      cancelling.value = false;
      jobIdRef.value = null;
    }
  },
);

function onToggle(open: boolean) {
  emit('update:modelValue', open);
}

async function onUpload() {
  if (!selectedFile.value) return;
  const result = await upload(selectedFile.value);
  if (!result) return;
  jobIdRef.value = result.jobId;
  startPolling(result.jobId, (j) => {
    emit('done', j);
    if (j.status === 'done' && j.createdRows > 0) {
      toast.success(`Import xong: tạo ${j.createdRows} khách mới`);
    }
  });
}

async function onCancel() {
  if (!jobIdRef.value) return;
  cancelling.value = true;
  const ok = await cancel(jobIdRef.value);
  cancelling.value = false;
  if (ok) toast.success('Đã huỷ import');
  else toast.error('Không huỷ được import');
}

async function onDownloadErrors() {
  if (!jobIdRef.value) return;
  const ok = await downloadErrors(jobIdRef.value);
  if (ok) toast.success('Đã tải file lỗi');
  else toast.error('Tải file lỗi thất bại');
}
</script>

<style scoped>
.truncate-file { max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>