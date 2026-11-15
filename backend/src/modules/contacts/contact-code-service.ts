// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyễn Tiến Lộc
/**
 * contact-code-service.ts — Sinh mã KH kinh doanh (KH000001...) cho CRM SĐT.
 *
 * Nguồn số: bảng ContactCodeSequence (1 row / org, cột lastValue là số cuối đã cấp).
 *
 * Mô hình cấp dải số (range allocation):
 *   - Khách hàng import 1M SĐT: cấp TỪNG LÔ 1 lần (vd 500 mã/lô) thay vì 1 triệu lần
 *     update sequence → giảm hàng triệu round-trip DB.
 *   - reserveCustomerCodeRange(orgId, n) → { start, end }: atomically increment
 *     lastValue += n, dải dùng được là [lastValue - n + 1, lastValue].
 *   - Transaction-safe: native upsert `ON CONFLICT (org_id) DO UPDATE SET
 *     last_value = last_value + n` chạy trong 1 câu SQL → không bao giờ 2 lô trùng số,
 *     kể cả khi nhiều worker chạy song song.
 *
 * Format: "KH" + số đệm 0 đủ 6 chữ số (KH000001..KH999999, tự đẩy lên 7+ chữ số khi vượt).
 */

import { prisma } from '../../shared/database/prisma-client.js';
import { logger } from '../../shared/utils/logger.js';

export const CUSTOMER_CODE_PREFIX = 'KH';
export const CUSTOMER_CODE_PAD = 6;

/**
 * Format 1 số thứ tự → mã KH. KH000001, KH100000, ... (tự nới khi > pad).
 */
export function formatCustomerCode(seq: number): string {
  return `${CUSTOMER_CODE_PREFIX}${String(seq).padStart(CUSTOMER_CODE_PAD, '0')}`;
}

/**
 * Format 1 dải [start..end] → mảng mã. Guard: start/end phải hợp lệ.
 */
export function formatCustomerCodeRange(start: number, end: number): string[] {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start > end) {
    throw new Error(`Dải mã KH không hợp lệ: [${start}..${end}]`);
  }
  const codes: string[] = [];
  for (let i = start; i <= end; i++) codes.push(formatCustomerCode(i));
  return codes;
}

function isP2002(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === 'P2002'
  );
}

/**
 * Cấp 1 dải `count` số thứ tự liên tiếp cho org — atomic + race-safe.
 *
 * Native upsert có thể fallback về read-then-create ở một số path của Prisma;
 * nếu gặp P2002 (đúng lúc 2 tiến trình cùng tạo row đầu tiên) → thử lại đường
 * update thuần. Nếu sau retry vẫn P2002 → throw (caller giữ nguyên job, không
 * nhét contact thiếu mã).
 */
export async function reserveCustomerCodeRange(
  orgId: string,
  count: number,
): Promise<{ start: number; end: number }> {
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error('reserveCustomerCodeRange: count phải là số nguyên dương');
  }

  async function run(): Promise<{ start: number; end: number }> {
    const row = await prisma.contactCodeSequence.upsert({
      where: { orgId },
      create: { orgId, lastValue: count },
      update: { lastValue: { increment: count } },
      select: { lastValue: true },
    });
    const end = row.lastValue;
    return { start: end - count + 1, end };
  }

  try {
    return await run();
  } catch (err) {
    if (!isP2002(err)) throw err;
    logger.warn(`[contact-code] upsert race P2002 org=${orgId} → retry update path`);
    const row = await prisma.contactCodeSequence.update({
      where: { orgId },
      data: { lastValue: { increment: count } },
      select: { lastValue: true },
    });
    return { start: row.lastValue - count + 1, end: row.lastValue };
  }
}

/**
 * Cấp `count` mã KH đã format sẵn (dùng cho worker import nhồi từng lô).
 */
export async function allocateCustomerCodes(orgId: string, count: number): Promise<string[]> {
  const { start, end } = await reserveCustomerCodeRange(orgId, count);
  return formatCustomerCodeRange(start, end);
}