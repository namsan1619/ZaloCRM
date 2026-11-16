// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyễn Tiến Lộc
/**
 * campaign-script-service.ts — Business logic cho kịch bản tin nhắn chiến dịch.
 *
 * Model `CampaignScript` (bảng campaign_scripts) — kịch bản tin nhắn dùng chung
 * cho các đợt chạy chiến dịch (CampaignRun):
 *   - kind: friend_request (lời mời kết bạn) | greeting (lời chào khi kết bạn
 *     thành công) | care (chuỗi chăm sóc sau khi kết bạn)
 *   - content: nội dung tin nhắn, hỗ trợ biến {{ten}} {{so_dien_thoai}} {{du_an}}
 *   - mediaUrls: fileUrls ảnh/PDF bảng hàng đính kèm theo tin nhắn
 *
 * Quy tắc:
 *   - Mọi query đều scope theo orgId (multi-tenant).
 *   - `name` unique trong 1 org (unique constraint [orgId, name]) → 409 DUPLICATE_NAME.
 *   - Delete bị chặn (409 IN_USE) nếu còn CampaignRun của org tham chiếu script:
 *     `greetingScriptId` trỏ tới script, hoặc `careScriptIds` (JSON array) chứa id.
 *   - Lazy-ensure: mỗi org có sẵn 1 kịch bản mặc định cho mỗi kind (idempotent),
 *     chạy trong GET /campaign-scripts để UI luôn có sẵn lựa chọn.
 *
 * Không dùng zod — validate tay, trả CampaignScriptError (status + code) để route
 * map sang HTTP response.
 */

import { prisma } from '../../shared/database/prisma-client.js';

/* ── Types ─────────────────────────────────────────────────────────────── */

export const SCRIPT_KINDS = ['friend_request', 'greeting', 'care'] as const;
export type CampaignScriptKind = (typeof SCRIPT_KINDS)[number];

export interface CampaignScriptRow {
  id: string;
  orgId: string;
  name: string;
  kind: string;
  content: string;
  mediaUrls: unknown;
  isActive: boolean;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Shape trả về cho FE (không lộ orgId/createdById/updatedAt). */
export interface CampaignScriptDto {
  id: string;
  name: string;
  kind: string;
  content: string;
  mediaUrls: string[];
  isActive: boolean;
  createdAt: Date;
}

export interface CreateScriptPayload {
  name?: string;
  kind?: string;
  content?: string;
  mediaUrls?: unknown;
}

export interface UpdateScriptPayload {
  name?: string;
  kind?: string;
  content?: string;
  mediaUrls?: unknown;
  isActive?: boolean;
}

export interface ListScriptsParams {
  kind?: string;
  activeOnly?: boolean;
}

/** Lỗi nghiệp vụ — route map `status` sang HTTP status code. */
export class CampaignScriptError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CampaignScriptError';
  }
}

/* ── Constants ─────────────────────────────────────────────────────────── */

const MAX_NAME_LEN = 128;
const MAX_CONTENT_LEN = 5000;

/* ── Helpers ───────────────────────────────────────────────────────────── */

function isPrismaError(err: unknown): err is { code?: string } {
  return !!err && typeof err === 'object' && 'code' in (err as Record<string, unknown>);
}

function normalizeName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new CampaignScriptError(400, 'NAME_REQUIRED', 'name là bắt buộc');
  }
  const trimmed = value.trim();
  if (!trimmed) throw new CampaignScriptError(400, 'NAME_REQUIRED', 'name là bắt buộc');
  if (trimmed.length > MAX_NAME_LEN) {
    throw new CampaignScriptError(400, 'NAME_TOO_LONG', `name tối đa ${MAX_NAME_LEN} ký tự`);
  }
  return trimmed;
}

function normalizeKind(value: unknown): CampaignScriptKind {
  if (typeof value !== 'string' || !value.trim()) {
    throw new CampaignScriptError(400, 'KIND_REQUIRED', 'kind là bắt buộc');
  }
  const trimmed = value.trim();
  if (!(SCRIPT_KINDS as readonly string[]).includes(trimmed)) {
    throw new CampaignScriptError(
      400,
      'INVALID_KIND',
      `kind phải là một trong: ${SCRIPT_KINDS.join(', ')}`,
    );
  }
  return trimmed as CampaignScriptKind;
}

function normalizeContent(value: unknown): string {
  if (typeof value !== 'string') {
    throw new CampaignScriptError(400, 'CONTENT_REQUIRED', 'content là bắt buộc');
  }
  const trimmed = value.trim();
  if (!trimmed) throw new CampaignScriptError(400, 'CONTENT_REQUIRED', 'content là bắt buộc');
  if (trimmed.length > MAX_CONTENT_LEN) {
    throw new CampaignScriptError(400, 'CONTENT_TOO_LONG', `content tối đa ${MAX_CONTENT_LEN} ký tự`);
  }
  return trimmed;
}

/** mediaUrls: mảng chuỗi (URL file). undefined/null → mảng rỗng. */
function normalizeMediaUrls(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((u) => typeof u !== 'string')) {
    throw new CampaignScriptError(400, 'INVALID_MEDIA_URLS', 'mediaUrls phải là mảng chuỗi');
  }
  return (value as string[]).map((u) => u.trim()).filter((u) => u.length > 0);
}

/* ── Seed mặc định ─────────────────────────────────────────────────────── */

export interface DefaultScriptSeed {
  kind: CampaignScriptKind;
  name: string;
  content: string;
}

/**
 * 3 kịch bản mặc định — 1 cho mỗi kind. Org mới cài app có ngay nội dung dùng
 * được (UI không mở dropdown rỗng), và có thể sửa lại bất cứ lúc nào.
 */
export const DEFAULT_CAMPAIGN_SCRIPTS: DefaultScriptSeed[] = [
  {
    kind: 'friend_request',
    name: 'Mặc định - Mời kết bạn',
    content:
      'Xin chao anh/chi! Toi dang phan phoi du an Vinhomes, cho phep toi gui thong tin bang hang toi anh/chi nhe.',
  },
  {
    kind: 'greeting',
    name: 'Mặc định - Lời chào',
    content:
      'Chao anh/chi, cam on da dong y ket ban! Em la ... ben phan phoi Vinhomes. Anh/chi quan tam dong nao de em gui bang hang phu hop a?',
  },
  {
    kind: 'care',
    name: 'Mặc định - Chăm sóc',
    content: 'Chao anh/chi, em gui them thong tin du an ... de anh/chi tham khao a.',
  },
];

/**
 * Lazy-ensure kịch bản mặc định — idempotent, theo từng kind.
 * Chỉ tạo cho kind mà org chưa có kịch bản nào; không ghi đè kịch bản user
 * đã tự tạo/sửa.
 */
export async function ensureDefaultCampaignScripts(
  orgId: string,
): Promise<{ created: number; existing: number }> {
  const existing = await prisma.campaignScript.findMany({
    where: { orgId },
    select: { kind: true },
  });
  const existingKinds = new Set(existing.map((s) => s.kind));

  let created = 0;
  for (const def of DEFAULT_CAMPAIGN_SCRIPTS) {
    if (existingKinds.has(def.kind)) continue;
    await prisma.campaignScript.create({
      data: {
        orgId,
        name: def.name,
        kind: def.kind,
        content: def.content,
        mediaUrls: [],
        isActive: true,
      },
    });
    created += 1;
  }

  return { created, existing: existing.length };
}

/* ── Queries ───────────────────────────────────────────────────────────── */

/** Map row → DTO cho FE. */
export function toScriptDto(row: CampaignScriptRow): CampaignScriptDto {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    content: row.content,
    mediaUrls: Array.isArray(row.mediaUrls)
      ? (row.mediaUrls as unknown[]).filter((u): u is string => typeof u === 'string')
      : [],
    isActive: row.isActive,
    createdAt: row.createdAt,
  };
}

/**
 * Danh sách kịch bản của org.
 * - kind: lọc theo loại kịch bản (giá trị sai → 400 INVALID_KIND).
 * - activeOnly: chỉ lấy kịch bản còn active.
 * Sort: kind asc, rồi createdAt asc.
 */
export async function listScripts(
  orgId: string,
  params: ListScriptsParams = {},
): Promise<CampaignScriptDto[]> {
  const where: { orgId: string; kind?: string; isActive?: boolean } = { orgId };
  if (params.kind?.trim()) where.kind = normalizeKind(params.kind);
  if (params.activeOnly) where.isActive = true;

  const rows = (await prisma.campaignScript.findMany({
    where,
    orderBy: [{ kind: 'asc' }, { createdAt: 'asc' }],
  })) as CampaignScriptRow[];

  return rows.map(toScriptDto);
}

/* ── Mutations ─────────────────────────────────────────────────────────── */

/** Tạo kịch bản mới. Tên phải unique trong org. */
export async function createScript(
  orgId: string,
  userId: string | undefined,
  payload: CreateScriptPayload,
): Promise<CampaignScriptRow> {
  const name = normalizeName(payload.name);
  const kind = normalizeKind(payload.kind);
  const content = normalizeContent(payload.content);
  const mediaUrls = normalizeMediaUrls(payload.mediaUrls);

  const duplicate = await prisma.campaignScript.findFirst({
    where: { orgId, name },
    select: { id: true },
  });
  if (duplicate) {
    throw new CampaignScriptError(409, 'DUPLICATE_NAME', `Kịch bản "${name}" đã tồn tại`);
  }

  try {
    return (await prisma.campaignScript.create({
      data: {
        orgId,
        name,
        kind,
        content,
        mediaUrls,
        isActive: true,
        createdById: userId ?? null,
      },
    })) as CampaignScriptRow;
  } catch (err) {
    if (isPrismaError(err) && err.code === 'P2002') {
      throw new CampaignScriptError(409, 'DUPLICATE_NAME', `Kịch bản "${name}" đã tồn tại`);
    }
    throw err;
  }
}

/** Cập nhật kịch bản. Chỉ set field được truyền vào. */
export async function updateScript(
  orgId: string,
  id: string,
  payload: UpdateScriptPayload,
): Promise<CampaignScriptRow> {
  const existing = await prisma.campaignScript.findFirst({
    where: { id, orgId },
    select: { id: true, name: true },
  });
  if (!existing) {
    throw new CampaignScriptError(404, 'SCRIPT_NOT_FOUND', 'Không tìm thấy kịch bản');
  }

  const data: {
    name?: string;
    kind?: CampaignScriptKind;
    content?: string;
    mediaUrls?: string[];
    isActive?: boolean;
  } = {};

  if (payload.name !== undefined) {
    const name = normalizeName(payload.name);
    if (name !== existing.name) {
      const duplicate = await prisma.campaignScript.findFirst({
        where: { orgId, name, id: { not: id } },
        select: { id: true },
      });
      if (duplicate) {
        throw new CampaignScriptError(409, 'DUPLICATE_NAME', `Kịch bản "${name}" đã tồn tại`);
      }
    }
    data.name = name;
  }

  if (payload.kind !== undefined) data.kind = normalizeKind(payload.kind);
  if (payload.content !== undefined) data.content = normalizeContent(payload.content);
  if (payload.mediaUrls !== undefined) data.mediaUrls = normalizeMediaUrls(payload.mediaUrls);
  if (payload.isActive !== undefined) data.isActive = payload.isActive;

  try {
    return (await prisma.campaignScript.update({
      where: { id },
      data,
    })) as CampaignScriptRow;
  } catch (err) {
    if (isPrismaError(err) && err.code === 'P2002') {
      throw new CampaignScriptError(409, 'DUPLICATE_NAME', 'Tên kịch bản đã tồn tại');
    }
    throw err;
  }
}

/**
 * Xóa kịch bản.
 * Chặn (409 IN_USE) khi còn CampaignRun của org tham chiếu script:
 *   - `greetingScriptId` = id, hoặc
 *   - `careScriptIds` (JSON array) chứa id.
 */
export async function deleteScript(orgId: string, id: string): Promise<{ id: string }> {
  const existing = await prisma.campaignScript.findFirst({
    where: { id, orgId },
    select: { id: true },
  });
  if (!existing) {
    throw new CampaignScriptError(404, 'SCRIPT_NOT_FOUND', 'Không tìm thấy kịch bản');
  }

  const usedByRun = await prisma.campaignRun.findFirst({
    where: {
      orgId,
      OR: [{ greetingScriptId: id }, { careScriptIds: { array_contains: [id] } }],
    },
    select: { id: true },
  });
  if (usedByRun) {
    throw new CampaignScriptError(
      409,
      'IN_USE',
      'Kịch bản đang được chiến dịch sử dụng, không thể xóa',
    );
  }

  try {
    await prisma.campaignScript.delete({ where: { id } });
  } catch (err) {
    if (isPrismaError(err) && err.code === 'P2003') {
      throw new CampaignScriptError(
        409,
        'IN_USE',
        'Kịch bản đang được chiến dịch sử dụng, không thể xóa',
      );
    }
    throw err;
  }

  return { id };
}
