// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyen Tien Loc
/**
 * Test thuần cho helper Đợt chạy (use-campaign-runs) — KHÔNG gọi API/DB.
 * runProgress / runActions / stateCounts / runStateLabel / runStateChip.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock api trước khi import composable — tránh kéo cả @/router/index.ts (import
// @ee/routes không resolve trong vitest.config.ts). Helper thuần không gọi api.
vi.mock('@/api/index', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

import {
  runProgress,
  runActions,
  stateCounts,
  runStateLabel,
  runStateChip,
} from './use-campaign-runs';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runProgress', () => {
  it('tính tổng 7 counters trên configuredTotal', () => {
    const p = runProgress({
      queuedCount: 10,
      sentCount: 20,
      acceptedCount: 5,
      repliedCount: 3,
      failedCount: 2,
      noZaloCount: 4,
      skippedCount: 1,
      configuredTotal: 45,
    });
    // 10+20+5+3+2+4+1 = 45
    expect(p.completed).toBe(45);
    expect(p.total).toBe(45);
    expect(p.pct).toBe(100);
  });

  it('pct làm tròn xuống 0 khi chưa có configuredTotal (chưa start)', () => {
    const p = runProgress({ queuedCount: 3, sentCount: 0, configuredTotal: 0 });
    expect(p.completed).toBe(3);
    expect(p.total).toBe(0);
    expect(p.pct).toBe(0);
  });

  it('pct không vượt 100 kể cả khi counter lệch với tổng', () => {
    const p = runProgress({ queuedCount: 50, sentCount: 60, configuredTotal: 100 });
    expect(p.pct).toBe(100);
  });

  it('missing fields coi như 0', () => {
    const p = runProgress({});
    expect(p.completed).toBe(0);
    expect(p.total).toBe(0);
    expect(p.pct).toBe(0);
  });
});

describe('runActions', () => {
  it('DRAFT: start + cancel, không pause/resume', () => {
    expect(runActions({ status: 'DRAFT' })).toEqual({ start: true, pause: false, resume: false, cancel: true });
  });
  it('RUNNING: pause + cancel, không start/resume', () => {
    expect(runActions({ status: 'RUNNING' })).toEqual({ start: false, pause: true, resume: false, cancel: true });
  });
  it('PAUSED: resume + cancel', () => {
    expect(runActions({ status: 'PAUSED' })).toEqual({ start: false, pause: false, resume: true, cancel: true });
  });
  it('DONE/CANCELLED: không còn nút nào', () => {
    expect(runActions({ status: 'DONE' })).toEqual({ start: false, pause: false, resume: false, cancel: false });
    expect(runActions({ status: 'CANCELLED' })).toEqual({ start: false, pause: false, resume: false, cancel: false });
  });
  it('FAILED: cho phép start lại (retry)', () => {
    expect(runActions({ status: 'FAILED' }).start).toBe(true);
  });
  it('status rỗng → coi như DRAFT', () => {
    expect(runActions({}).start).toBe(true);
  });
});

describe('stateCounts', () => {
  const run = {
    queuedCount: 5,
    sentCount: 6,
    acceptedCount: 7,
    repliedCount: 8,
    failedCount: 1,
    noZaloCount: 2,
    skippedCount: 3,
  };
  it('fallback sang 7 counters của run khi thiếu byState', () => {
    const c = stateCounts(run);
    expect(c.queued).toBe(5);
    expect(c.friend_request_sent).toBe(6);
    expect(c.friend_request_accepted).toBe(7);
    expect(c.replied).toBe(8);
    expect(c.failed).toBe(1);
    expect(c.no_zalo).toBe(2);
    expect(c.skipped).toBe(3);
  });
  it('byState ghi đè nhưng giữ các state còn lại', () => {
    const c = stateCounts(run, { replied: 99, greeting_sent: 4 });
    expect(c.replied).toBe(99);
    expect(c.greeting_sent).toBe(4);
    expect(c.queued).toBe(5);
    expect(c.skipped).toBe(3);
  });
  it('byState null → fallback', () => {
    const c = stateCounts(run, null);
    expect(c.replied).toBe(8);
  });
});

describe('runStateLabel / runStateChip', () => {
  it('label đã biết', () => {
    expect(runStateLabel('queued')).toBe('Chờ gửi');
    expect(runStateLabel('friend_request_accepted')).toBe('Kết bạn');
    expect(runStateLabel('replied')).toBe('Đã reply');
  });
  it('state lạ giữ nguyên / chip-grey', () => {
    expect(runStateLabel('care_sent')).toBe('Đã chăm sóc');
    expect(runStateLabel('xyz')).toBe('xyz');
    expect(runStateChip('xyz')).toBe('chip-grey');
  });
  it('chip của trạng thái quen thuộc', () => {
    expect(runStateChip('failed')).toBe('chip-red');
    expect(runStateChip('friend_request_accepted')).toBe('chip-green');
  });
});