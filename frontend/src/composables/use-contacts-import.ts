// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyễn Tiến Lộc
/**
 * use-contacts-import.ts — Import khách hàng hàng loạt (P2).
 *
 * Luồng: upload file (multipart) → backend tạo job → worker nền dedup + cấp mã KH
 * → FE poll tiến độ → báo cáo created/duplicate/invalid + tải file lỗi CSV.
 *
 * API (xem phase-02-khach-hang-import-1m.md):
 *   POST /contacts/import/upload        (multipart: file) → { jobId }
 *   GET  /contacts/import/:jobId         → job + counters
 *   GET  /contacts/import/:jobId/errors  → file CSV dòng lỗi
 *   POST /contacts/import/:jobId/cancel  → huỷ job
 */
import { ref } from 'vue';
import { api } from '@/api/index';

export type ContactImportJobStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

export interface ContactImportJob {
  id: string;
  fileName?: string;
  status: ContactImportJobStatus;
  totalRows: number;
  processedRows: number;
  createdRows: number;
  duplicateRows: number;
  invalidRows: number;
  errorRows: number;
  /** Tên file lỗi (CSV) phía server — dùng để báo cho user. */
  errorFile?: string | null;
  errorReason?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  /** % server tính sẵn (gồm cả dòng lỗi) — ưu tiên dùng khi có. */
  progress?: number;
  percentDone?: number;
}

export interface ContactImportUploadResult {
  jobId: string;
}

/** Khoảng thời gian poll tiến độ (ms) — backend xử lý theo lô nền. */
const POLL_INTERVAL_MS = 2500;

export function useContactsImport() {
  const job = ref<ContactImportJob | null>(null);
  const uploading = ref(false);
  const loading = ref(false);
  const error = ref('');

  let timer: ReturnType<typeof setTimeout> | null = null;

  /** Upload file → trả jobId (backend parse + staging, worker xử lý nền). */
  async function upload(file: File): Promise<ContactImportUploadResult | null> {
    uploading.value = true;
    error.value = '';
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await api.post('/contacts/import/upload', form);
      const jobId = (res.data?.jobId ?? res.data?.id) as string | undefined;
      if (!jobId) {
        error.value = 'Backend không trả về jobId';
        return null;
      }
      return { jobId };
    } catch (err) {
      console.error('[contact-import] upload failed:', err);
      error.value = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
        || 'Upload file thất bại';
      return null;
    } finally {
      uploading.value = false;
    }
  }

  /** Lấy 1 lần trạng thái job. */
  async function fetchJob(jobId: string): Promise<ContactImportJob | null> {
    loading.value = true;
    try {
      const res = await api.get(`/contacts/import/${jobId}`);
      const data = (res.data?.job ?? res.data) as ContactImportJob;
      job.value = data;
      return data;
    } catch (err) {
      console.error('[contact-import] fetchJob failed:', err);
      error.value = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
        || 'Không lấy được tiến độ import';
      return null;
    } finally {
      loading.value = false;
    }
  }

  function stopPolling() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  /**
   * Poll tiến độ mỗi POLL_INTERVAL_MS, tự dừng khi job về trạng thái kết thúc.
   * Dùng setTimeout nối tiếp (không setInterval) để không chồng request khi
   * backend bận.
   */
  function startPolling(jobId: string, onDone?: (job: ContactImportJob) => void) {
    stopPolling();
    const tick = async () => {
      const current = await fetchJob(jobId);
      if (!current) {
        stopPolling();
        return;
      }
      if (current.status === 'done' || current.status === 'failed' || current.status === 'cancelled') {
        stopPolling();
        onDone?.(current);
        return;
      }
      timer = setTimeout(tick, POLL_INTERVAL_MS);
    };
    void tick();
  }

  /** Huỷ job đang chạy (job vẫn chạy nền ở server nếu không huỷ — gọi cancel trước). */
  async function cancel(jobId: string): Promise<boolean> {
    stopPolling();
    try {
      await api.post(`/contacts/import/${jobId}/cancel`, {});
      await fetchJob(jobId);
      return true;
    } catch (err) {
      console.error('[contact-import] cancel failed:', err);
      error.value = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
        || 'Huỷ import thất bại';
      return false;
    }
  }

  /**
   * Tải file CSV các dòng lỗi. Backend trả file (content-type csv) — tải thẳng
   * qua blob, không parse.
   */
  async function downloadErrors(jobId: string): Promise<boolean> {
    try {
      const res = await api.get(`/contacts/import/${jobId}/errors`, { responseType: 'blob' });
      const blob = new Blob([res.data], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `contact-import-errors-${jobId}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      return true;
    } catch (err) {
      console.error('[contact-import] downloadErrors failed:', err);
      error.value = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
        || 'Tải file lỗi thất bại';
      return false;
    }
  }

  /** Reset state (dùng khi mở lại dialog). */
  function reset() {
    stopPolling();
    job.value = null;
    error.value = '';
  }

  return {
    job,
    uploading,
    loading,
    error,
    upload,
    fetchJob,
    startPolling,
    stopPolling,
    cancel,
    downloadErrors,
    reset,
  };
}
