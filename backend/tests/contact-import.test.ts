// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyễn Tiến Lộc
/**
 * contact-import.test.ts — Unit test cho import SĐT KH (P2).
 *
 * Phủ 2 phần rủi ro cao nhất:
 *  1. Mã KH KHÔNG TRÙNG — cấp dải số qua ContactCodeSequence (nhiều lô liên tiếp
 *     + race P2002 phải không cấp trùng).
 *  2. Worker DEDUP — SĐT trùng trong chính file và SĐT trùng với Contact CRM
 *     không được tạo 2 Contact.
 *
 * Mock prisma-client (không cần DB thật) — theo pattern tests/unit/*.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── Mock: prisma-client (sequence counter giả lập atomic increment) ───────────

let seqLastValue = 0;
let upsertShouldThrowP2002 = false;

const mockUpsert = vi.fn(async (args: any) => {
  if (upsertShouldThrowP2002) {
    upsertShouldThrowP2002 = false;
    const err: any = new Error('Unique constraint failed');
    err.code = 'P2002';
    throw err;
  }
  if (!seqLastValue) {
    seqLastValue = args.create.lastValue;
  } else {
    seqLastValue += args.update.lastValue.increment;
  }
  return { lastValue: seqLastValue };
});

const mockUpdate = vi.fn(async (args: any) => {
  seqLastValue += args.data.lastValue.increment;
  return { lastValue: seqLastValue };
});

vi.mock('../src/shared/database/prisma-client.js', () => ({
  prisma: {
    contactCodeSequence: {
      upsert: mockUpsert,
      update: mockUpdate,
    },
  },
  tenantTransaction: (fn: any) => fn({}),
}));

// ── Mock: logger ─────────────────────────────────────────────────────────────
vi.mock('../src/shared/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { formatCustomerCode, formatCustomerCodeRange, reserveCustomerCodeRange } =
  await import('../src/modules/contacts/contact-code-service.js');
const { dedupImportRows, parseContactRows, buildErrorCsv, streamParsedContactRows } =
  await import('../src/modules/contacts/contact-import-service.js');

/** Tạo file CSV tạm để test đường streaming. */
function writeTempCsv(content: string, name = 'import.csv'): string {
  const dir = mkdtempSync(join(tmpdir(), 'zalocrm-import-'));
  const path = join(dir, name);
  writeFileSync(path, content, 'utf8');
  return path;
}

beforeEach(() => {
  seqLastValue = 0;
  upsertShouldThrowP2002 = false;
  mockUpsert.mockClear();
  mockUpdate.mockClear();
});

describe('formatCustomerCode — định dạng mã KH', () => {
  it('KH + số đệm 0 đủ 6 chữ số', () => {
    expect(formatCustomerCode(1)).toBe('KH000001');
    expect(formatCustomerCode(42)).toBe('KH000042');
    expect(formatCustomerCode(999999)).toBe('KH999999');
  });

  it('vượt 6 chữ số → tự nới (KH1000000)', () => {
    expect(formatCustomerCode(1000000)).toBe('KH1000000');
  });

  it('formatCustomerCodeRange sinh đủ số lượng, không trùng', () => {
    const codes = formatCustomerCodeRange(1, 5);
    expect(codes).toEqual(['KH000001', 'KH000002', 'KH000003', 'KH000004', 'KH000005']);
    expect(new Set(codes).size).toBe(5);
  });

  it('dải không hợp lệ → throw', () => {
    expect(() => formatCustomerCodeRange(5, 1)).toThrow();
  });
});

describe('reserveCustomerCodeRange — KHÔNG cấp trùng mã', () => {
  it('lô đầu tiên bắt đầu từ 1', async () => {
    const r = await reserveCustomerCodeRange('org-1', 3);
    expect(r).toEqual({ start: 1, end: 3 });
  });

  it('các lô liên tiếp KHÔNG chồng nhau (3 rồi 2 rồi 4)', async () => {
    const a = await reserveCustomerCodeRange('org-1', 3);
    const b = await reserveCustomerCodeRange('org-1', 2);
    const c = await reserveCustomerCodeRange('org-1', 4);
    expect(a).toEqual({ start: 1, end: 3 });
    expect(b).toEqual({ start: 4, end: 5 });
    expect(c).toEqual({ start: 6, end: 9 });

    // Hợp 3 dải → 9 mã, KHÔNG trùng mã nào
    const all = [...formatCustomerCodeRange(a.start, a.end), ...formatCustomerCodeRange(b.start, b.end), ...formatCustomerCodeRange(c.start, c.end)];
    expect(all.length).toBe(9);
    expect(new Set(all).size).toBe(9);
  });

  it('race P2002 (2 tiến trình cùng tạo row đầu) → retry update path, KHÔNG trùng mã', async () => {
    // Lần đầu upsert đụng P2002 (race create) → fallback update tăng thêm 1
    upsertShouldThrowP2002 = true;
    const r = await reserveCustomerCodeRange('org-1', 2);
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ start: 1, end: 2 });
  });

  it('count <= 0 → throw (không cấp mã rác)', async () => {
    await expect(reserveCustomerCodeRange('org-1', 0)).rejects.toThrow();
    await expect(reserveCustomerCodeRange('org-1', -5)).rejects.toThrow();
  });
});

describe('dedupImportRows — worker KHÔNG tạo 2 Contact cho 1 SĐT', () => {
  it('trùng trong chính file → first-wins, các bản sau đánh dấu duplicate', () => {
    const rows = [
      { id: 'r1', phoneNormalized: '84908123456' },
      { id: 'r2', phoneNormalized: '84908123456' },
      { id: 'r3', phoneNormalized: '84911112222' },
    ];
    const res = dedupImportRows(rows, new Map());
    expect(res.newRows.map((r) => r.id)).toEqual(['r1', 'r3']);
    expect(res.duplicatesInFile).toEqual(['r2']);
    expect(res.duplicatesWithCrm).toEqual([]);
  });

  it('trùng với Contact CRM → gắn contactId, KHÔNG tạo mới', () => {
    const rows = [
      { id: 'r1', phoneNormalized: '84908123456' },
      { id: 'r2', phoneNormalized: '84911112222' },
    ];
    const existing = new Map([['84908123456', 'contact-9']]);
    const res = dedupImportRows(rows, existing);
    expect(res.newRows.map((r) => r.id)).toEqual(['r2']);
    expect(res.duplicatesWithCrm).toEqual([{ id: 'r1', contactId: 'contact-9' }]);
  });

  it('SĐT không normalize (null) → bỏ qua, không vào newRows', () => {
    const rows = [
      { id: 'r1', phoneNormalized: null },
      { id: 'r2', phoneNormalized: '84908123456' },
    ];
    const res = dedupImportRows(rows, new Map());
    expect(res.newRows.map((r) => r.id)).toEqual(['r2']);
    expect(res.duplicatesInFile).toEqual([]);
    expect(res.duplicatesWithCrm).toEqual([]);
  });

  it('không có trùng nào → tất cả là dòng mới', () => {
    const rows = [
      { id: 'r1', phoneNormalized: '84908123456' },
      { id: 'r2', phoneNormalized: '84911112222' },
      { id: 'r3', phoneNormalized: '84933334444' },
    ];
    const res = dedupImportRows(rows, new Map());
    expect(res.newRows.length).toBe(3);
    expect(res.duplicatesInFile.length).toBe(0);
    expect(res.duplicatesWithCrm.length).toBe(0);
  });
});

describe('parseContactRows — parse file KH', () => {
  it('không có header → cột 0 = SĐT, cột 1 = tên', () => {
    const rows = [
      ['0908123456', 'Nguyễn Văn A'],
      ['+84911112222', 'Trần Thị B'],
    ];
    const parsed = parseContactRows(rows);
    expect(parsed.length).toBe(2);
    expect(parsed[0].phoneNormalized).toBe('84908123456');
    expect(parsed[0].nameRaw).toBe('Nguyễn Văn A');
    expect(parsed[1].phoneNormalized).toBe('84911112222');
  });

  it('có header → tự detect cột SĐT/tên, cột khác vào payload', () => {
    const rows = [
      ['SĐT', 'Họ tên', 'Ghi chú'],
      ['0908123456', 'Nguyễn Văn A', 'khách quen'],
    ];
    const parsed = parseContactRows(rows);
    expect(parsed.length).toBe(1);
    expect(parsed[0].phoneNormalized).toBe('84908123456');
    expect(parsed[0].nameRaw).toBe('Nguyễn Văn A');
    expect(parsed[0].payload['Ghi chú']).toBe('khách quen');
  });

  it('SĐT không hợp lệ (số bàn / quốc gia khác) → phoneNormalized null, giữ phoneRaw', () => {
    const rows = [
      ['0201234567'],
      ['+886912345678'],
    ];
    const parsed = parseContactRows(rows);
    expect(parsed.length).toBe(2);
    expect(parsed[0].phoneNormalized).toBeNull();
    expect(parsed[0].phoneRaw).toBe('0201234567');
    expect(parsed[1].phoneNormalized).toBeNull();
  });

  it('dòng rỗng → bỏ qua (không tăng rowIndex)', () => {
    const rows = [
      ['0908123456', 'A'],
      ['', ''],
      ['09091112222', 'B'],
    ];
    const parsed = parseContactRows(rows);
    expect(parsed.length).toBe(2);
    expect(parsed.map((p) => p.rowIndex)).toEqual([1, 2]);
  });

  it('columnMap thủ công → ghi đè cột mặc định', () => {
    const rows = [
      ['A', 'B', '0908123456'],
    ];
    const parsed = parseContactRows(rows, { phone: 2, name: 0 });
    expect(parsed[0].phoneNormalized).toBe('84908123456');
    expect(parsed[0].nameRaw).toBe('A');
  });
});

describe('buildErrorCsv — file lỗi CSV', () => {
  it('có header + escape dấu phẩy/nhấy quyền', () => {
    const csv = buildErrorCsv([
      { rowIndex: 3, phoneRaw: '0908', nameRaw: 'A, B', status: 'invalid', errorReason: 'invalid_phone' },
    ]);
    expect(csv.split('\n')[0]).toBe('row_index,phone_raw,name,status,error_reason');
    expect(csv).toContain('"A, B"');
  });

  it('mảng rỗng → chỉ có header', () => {
    expect(buildErrorCsv([])).toBe('row_index,phone_raw,name,status,error_reason');
  });
});

describe('streamParsedContactRows — đường streaming (import 1M)', () => {
  it('đọc CSV từ file theo dòng, tự detect header', async () => {
    const path = writeTempCsv('SĐT,Họ tên,Ghi chú\n0908123456,Nguyễn Văn A,khách quen\n+84911112222,Trần Thị B,\n');
    try {
      const out: any[] = [];
      for await (const r of streamParsedContactRows(path)) out.push(r);
      expect(out.length).toBe(2);
      expect(out[0].phoneNormalized).toBe('84908123456');
      expect(out[0].nameRaw).toBe('Nguyễn Văn A');
      expect(out[0].payload['Ghi chú']).toBe('khách quen');
      expect(out[1].phoneNormalized).toBe('84911112222');
    } finally {
      rmSync(path, { force: true });
    }
  });

  it('dòng chứa dấu phẩy trong ô quote + newline trong ô → ghép đúng', async () => {
    const path = writeTempCsv('phone,name\n0908123456,"A, B"\n+84911112222,"C\nD",\n');
    try {
      const out: any[] = [];
      for await (const r of streamParsedContactRows(path)) out.push(r);
      expect(out.length).toBe(2);
      expect(out[0].nameRaw).toBe('A, B');
      expect(out[1].nameRaw).toBe('C\nD');
    } finally {
      rmSync(path, { force: true });
    }
  });

  it('BOM đầu file → bỏ, không ảnh hưởng parse', async () => {
    const path = writeTempCsv('﻿phone\n0908123456\n');
    try {
      const out: any[] = [];
      for await (const r of streamParsedContactRows(path)) out.push(r);
      expect(out.length).toBe(1);
      expect(out[0].phoneNormalized).toBe('84908123456');
    } finally {
      rmSync(path, { force: true });
    }
  });

  it('SĐT không hợp lệ trong stream → phoneNormalized null, phoneRaw giữ nguyên', async () => {
    const path = writeTempCsv('0908123456\n0201234567\n+886912345678\n');
    try {
      const out: any[] = [];
      for await (const r of streamParsedContactRows(path)) out.push(r);
      expect(out.length).toBe(3);
      expect(out[0].phoneNormalized).toBe('84908123456');
      expect(out[1].phoneNormalized).toBeNull();
      expect(out[1].phoneRaw).toBe('0201234567');
      expect(out[2].phoneNormalized).toBeNull();
    } finally {
      rmSync(path, { force: true });
    }
  });
});