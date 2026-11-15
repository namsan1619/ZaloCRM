<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Nguyễn Tiến Lộc -->
<template>
  <div v-if="modelValue" class="pid-overlay" @click.self="$emit('update:modelValue', false)">
    <div class="pid-modal">
      <div class="pid-head">
        <h3 class="pid-title">
          <v-icon size="18">mdi-tray-arrow-down</v-icon> Import bảng hàng
        </h3>
        <button class="pid-x" aria-label="Đóng" @click="$emit('update:modelValue', false)">✕</button>
      </div>

      <div class="pid-body">
        <!-- Bước 1: chọn file -->
        <div v-if="!preview" class="pid-field">
          <label class="pid-label">File Excel / CSV bảng hàng</label>
          <div
            class="pid-dropzone"
            :class="{ 'is-dragover': isDragOver }"
            @click="triggerPicker"
            @dragover.prevent="isDragOver = true"
            @dragleave.prevent="isDragOver = false"
            @drop.prevent="onDrop"
          >
            <input
              ref="pickerRef"
              type="file"
              accept=".xlsx,.xls,.csv"
              style="display:none"
              @change="onPick"
            />
            <v-icon size="34" class="dz-ico">mdi-file-excel-outline</v-icon>
            <div class="dz-title">Kéo thả file vào đây hoặc <u>chọn file</u></div>
            <div class="dz-sub">.xlsx / .xls / .csv — tối đa 10MB. Cột khuyến nghị: mã căn, dự án, đại lý, loại, diện tích, hướng, giá.</div>
            <div v-if="fileError" class="dz-error">⚠️ {{ fileError }}</div>
          </div>
        </div>

        <!-- Bước 2: dry-run preview -->
        <div v-if="preview" class="pid-preview">
          <div class="pid-file-meta">
            <span>📄 <b>{{ fileName }}</b></span>
            <span class="pid-dot">·</span>
            <button class="pid-link" @click="resetFile">Chọn file khác</button>
          </div>

          <!-- Loading dry-run -->
          <div v-if="dryRunning" class="pid-dry-load">
            <v-icon size="16" class="spin">mdi-loading</v-icon> Đang phân tích file...
          </div>

          <!-- Kết quả dry-run -->
          <div v-else class="pid-parse">
            <div class="pid-pp-row pid-pp--ok">
              <span class="pid-pp-ico">✓</span> Tổng <b>{{ preview.total }}</b> dòng
            </div>
            <div class="pid-pp-row pid-pp--ok">
              <span class="pid-pp-ico">✓</span> Hợp lệ <b>{{ preview.valid }}</b> căn
            </div>
            <div v-if="preview.invalid > 0" class="pid-pp-row pid-pp--err">
              <span class="pid-pp-ico">✗</span> Lỗi <b>{{ preview.invalid }}</b> dòng
            </div>
            <div v-if="preview.duplicate > 0" class="pid-pp-row pid-pp--warn">
              <span class="pid-pp-ico">↺</span> Trùng <b>{{ preview.duplicate }}</b> căn
            </div>

            <!-- Sample rows nếu BE trả về -->
            <div v-if="preview.sample && preview.sample.length" class="pid-sample">
              <div class="pid-sample-title">Xem trước {{ preview.sample.length }} dòng:</div>
              <table class="tbl pid-sample-tbl">
                <thead>
                  <tr><th>Mã căn</th><th>Dự án</th><th>Giá</th><th>Trạng thái</th></tr>
                </thead>
                <tbody>
                  <tr v-for="(r, i) in preview.sample" :key="i">
                    <td class="cell-strong">{{ sampleCell(r, 'unitCode', 'ma') }}</td>
                    <td>{{ sampleCell(r, 'projectName', 'duAn') }}</td>
                    <td class="num">{{ formatVnd(sampleRaw(r, 'priceVnd', 'gia')) }}</td>
                    <td>{{ sampleCell(r, 'statusCode', 'trangThai') }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      <div class="pid-foot">
        <span class="pid-foot-note">Import áp dụng mapping mặc định theo tên cột tiếng Việt.</span>
        <div class="pid-foot-actions">
          <button class="btn btn-ghost btn-sm" @click="$emit('update:modelValue', false)">Huỷ</button>
          <button
            class="btn btn-primary btn-sm"
            :disabled="!preview || dryRunning || committing"
            @click="onCommit"
          >
            <v-icon size="15">{{ committing ? 'mdi-loading' : 'mdi-check' }}</v-icon>
            {{ committing ? 'Đang import...' : 'Import vào bảng hàng' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import { useProperties, formatVnd, type DryRunResult } from '@/composables/use-properties';
import { useToast } from '@/composables/use-toast';

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void;
  (e: 'imported'): void;
}>();

const toast = useToast();
const { importDryRun, importCommit } = useProperties();

const pickerRef = ref<HTMLInputElement | null>(null);
const isDragOver = ref(false);
const fileError = ref<string | null>(null);
const fileName = ref('');
const file = ref<File | null>(null);
const preview = ref<DryRunResult | null>(null);
const dryRunning = ref(false);
const committing = ref(false);

function triggerPicker() {
  pickerRef.value?.click();
}

function onPick(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) handleFile(f);
}

function onDrop(e: DragEvent) {
  isDragOver.value = false;
  const f = e.dataTransfer?.files?.[0];
  if (f) handleFile(f);
}

async function handleFile(f: File) {
  fileError.value = null;
  if (f.size > 10 * 1024 * 1024) {
    fileError.value = 'File > 10MB. Vui lòng tách nhỏ.';
    return;
  }
  const lo = f.name.toLowerCase();
  if (!(lo.endsWith('.xlsx') || lo.endsWith('.xls') || lo.endsWith('.csv'))) {
    fileError.value = 'Chỉ nhận .xlsx / .xls / .csv';
    return;
  }
  file.value = f;
  fileName.value = f.name;
  dryRunning.value = true;
  preview.value = null;
  try {
    const result = await importDryRun(f);
    preview.value = result;
    if (result && result.valid === 0) {
      toast.warning('File không có dòng hợp lệ nào — kiểm tra lại định dạng cột');
    }
  } catch (err) {
    console.error(err);
    fileError.value = (err as { response?: { data?: { error?: string } } }).response?.data?.error
      ?? 'Không phân tích được file — kiểm tra định dạng.';
    preview.value = null;
    file.value = null;
  } finally {
    dryRunning.value = false;
  }
}

function resetFile() {
  file.value = null;
  fileName.value = '';
  preview.value = null;
  fileError.value = null;
  if (pickerRef.value) pickerRef.value.value = '';
}

async function onCommit() {
  if (!file.value) return;
  committing.value = true;
  try {
    await importCommit({ file: file.value, tempKey: preview.value?.tempKey });
    toast.success('Đã import bảng hàng thành công');
    emit('imported');
    emit('update:modelValue', false);
    resetFile();
  } catch (err) {
    const msg = (err as { response?: { data?: { error?: string } } }).response?.data?.error
      ?? 'Import thất bại — thử lại';
    toast.error(msg, 5000);
  } finally {
    committing.value = false;
  }
}

// Reset khi đóng modal
watch(() => props.modelValue, (v) => {
  if (!v) resetFile();
});

type SampleRow = Record<string, unknown>;

function sampleCell(row: unknown, ...keys: string[]): string {
  const v = sampleRaw(row, ...keys);
  if (v === null || v === undefined || v === '') return '—';
  return String(v);
}

function sampleRaw(row: unknown, ...keys: string[]): string | number | null | undefined {
  if (!row || typeof row !== 'object') return undefined;
  const rec = row as SampleRow;
  for (const k of keys) {
    const v = rec[k];
    if (v !== undefined && v !== null && v !== '') return v as string | number;
  }
  return undefined;
}
</script>

<style scoped>
/* Prefix pid- * — tránh đụng global theme (.field/.btn display:flex). */
.pid-overlay {
  position: fixed; inset: 0;
  background: rgba(20, 26, 36, .48);
  display: flex; align-items: center; justify-content: center;
  z-index: 200; padding: 20px;
}
.pid-modal {
  background: var(--surface, #fff);
  border-radius: 12px;
  width: 640px; max-width: 94vw; max-height: 88vh;
  box-shadow: 0 24px 60px rgba(20, 26, 36, .24);
  display: flex; flex-direction: column; overflow: hidden;
  color: var(--ink-2, #475066);
}
.pid-head {
  padding: 14px 20px; border-bottom: 1px solid var(--line, #e7eaf0);
  display: flex; justify-content: space-between; align-items: center; flex-shrink: 0;
}
.pid-title { margin: 0; font-size: 15.5px; font-weight: 600; color: var(--ink); display: flex; align-items: center; gap: 8px; }
.pid-x {
  background: transparent; border: none; color: var(--ink-3); font-size: 16px; cursor: pointer;
  width: 30px; height: 30px; border-radius: 6px;
  display: inline-flex; align-items: center; justify-content: center;
}
.pid-x:hover { background: var(--surface-3); color: var(--ink); }
.pid-body { padding: 18px 20px; overflow-y: auto; flex: 1; }
.pid-foot {
  padding: 12px 20px; background: var(--surface-2, #f7f9fc);
  border-top: 1px solid var(--line, #e7eaf0);
  display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-shrink: 0;
}
.pid-foot-note { font-size: 12px; color: var(--ink-3); }
.pid-foot-actions { display: flex; gap: 8px; }

.pid-field { margin-bottom: 12px; }
.pid-label {
  font-size: 11px; font-weight: 500; color: var(--ink-3);
  text-transform: uppercase; letter-spacing: .04em; margin-bottom: 6px; display: block;
}
.pid-dropzone {
  border: 2px dashed var(--line, #cdd4e0); border-radius: 10px; padding: 30px 16px;
  text-align: center; cursor: pointer; background: var(--surface-2, #f7f9fc);
  transition: border-color .14s, background .14s;
}
.pid-dropzone:hover, .pid-dropzone.is-dragover {
  background: var(--brand-soft, #e4f1f8); border-color: var(--brand, #1786be);
}
.dz-ico { color: var(--brand, #1786be); }
.dz-title { font-size: 14px; color: var(--ink, #141a24); margin: 8px 0 4px; }
.dz-sub { font-size: 12px; color: var(--ink-3); line-height: 1.5; }
.dz-error { margin-top: 10px; color: var(--error, #f04438); font-size: 12px; }

.pid-file-meta {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 13px;
  background: var(--surface-3, #f1f4f9); border: 1px solid var(--line, #e7eaf0);
  padding: 9px 12px; border-radius: 7px; margin-bottom: 12px; color: var(--ink-2);
}
.pid-dot { color: var(--ink-4); }
.pid-link { background: none; border: none; color: var(--brand, #1786be); font-size: 13px; cursor: pointer; text-decoration: underline; }

.pid-dry-load { display: flex; align-items: center; gap: 8px; color: var(--ink-3); font-size: 13px; padding: 12px 0; }
.pid-parse { background: var(--surface-3, #f1f4f9); border: 1px solid var(--line, #e7eaf0); border-radius: 8px; padding: 12px 14px; font-size: 12.5px; }
.pid-pp-row { display: flex; align-items: center; gap: 8px; padding: 2px 0; }
.pid-pp-ico { font-size: 13px; width: 18px; text-align: center; }
.pid-pp-row b { color: var(--ink, #141a24); font-variant-numeric: tabular-nums; }
.pid-pp--ok { color: var(--success, #12b76a); }
.pid-pp--err { color: var(--error, #f04438); }
.pid-pp--warn { color: var(--warning, #b45309); }

.pid-sample { margin-top: 12px; }
.pid-sample-title { font-size: 12px; color: var(--ink-3); margin-bottom: 6px; }
.pid-sample-tbl { font-size: 12px; }
</style>