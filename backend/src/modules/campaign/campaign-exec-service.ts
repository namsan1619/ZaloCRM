// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyen Tien Loc
/**
 * campaign-exec-service.ts — Nghiệp vụ "đợt chạy chiến dịch thật" (CampaignRun).
 *
 * Đây là tầng business logic cho BE chạy chiến dịch kết bạn / chăm sóc thật
 * (Agent E). Khác với `campaign-tracker-service` (chiến dịch marketing KHÔNG gửi),
 * CampaignRun có state machine riêng và worker nền gửi thật:
 *
 *   DRAFT → RUNNING ⇄ PAUSED → DONE | CANCELLED | FAILED
 *
 * State machine qua endpoints:
 *   POST /api/v1/campaigns/:campaignId/runs        — tạo run (DRAFT) + snapshot script
 *   POST /api/v1/campaign-runs/:id/start           — DRAFT → RUNNING + FILL CampaignContact
 *   POST /api/v1/campaign-runs/:id/pause           — RUNNING → PAUSED (pausedAt)
 *   POST /api/v1/campaign-runs/:id/resume          — PAUSED → RUNNING (pausedAt=null)
 *   POST /api/v1/campaign-runs/:id/cancel          — DRAFT|RUNNING|PAUSED → CANCELLED (finishedAt)
 *   GET  /api/v1/campaign-runs/:id                 — { run, counts.byState, nickBudget[] }
 *   GET  /api/v1/campaign-runs/:id/contacts        — phân trang contact của run
 *   GET  /api/v1/campaigns/:campaignId/runs        — list run của campaign
 *
 * Worker nền (campaign-exec-worker.ts) tự chuyển RUNNING → DONE/PAUSED khi không
 * còn việc hoặc hết budget nick trong ngày.
 *
 * Quy ước:
 *   - mọi query scope theo orgId (multi-tenant).
 *   - lỗi nghiệp vụ ném CampaignExecError(status, code, message) — route map sang HTTP.
 *   - snapshot greeting script → greetingScriptText lúc TẠO run (sửa script sau
 *     không ảnh hưởng run đang chạy).
 */
import { prisma } from '../../shared/database/prisma-client.js';
import { getEffectiveLimit } from '../zalo/sdk-limit-service.js';

/* ── State constants (canonical nguồn cho cả worker) ────────────────────── */
export const RUN_STATUS = {
  DRAFT: 'DRAFT',
  RUNNING: 'RUNNING',
  PAUSED: 'PAUSED',
  DONE: 'DONE',
  CANCELLED: 'CANCELLED',
  FAILED: 'FAILED',
} as const;
export type RunStatus = (typeof RUN_STATUS)[keyof typeof RUN_STATUS];

export const RUN_MODES = ['friend_request', 'care'] as const;
export type RunMode = (typeof RUN_MODES)[number];

export const CONTACT_STATE = {
  QUEUED: 'queued',
  FRIEND_REQUEST_SENT: 'friend_request_sent',
  NO_ZALO: 'no_zalo',
  SKIPPED: 'skipped',
  FAILED: 'failed',
  FRIEND_REQUEST_ACCEPTED: 'friend_request_accepted',
  GREETING_SENT: 'greeting_sent',
  CARE_SENT: 'care_sent',
  REPLIED: 'replied',
} as const;
export type ContactState = (typeof CONTACT_STATE)[keyof typeof CONTACT_STATE];

/** Lỗi nghiệp vụ — route map `status` sang HTTP status, `code` ổn định cho FE. */
export class CampaignExecError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CampaignExecError';
  }
}

/* ── Helpers dùng chung service + worker ─────────────────────────────────── */

/** Bắt đầu ngày hôm nay theo UTC+7 (VN) dưới dạng Date UTC. */
export function startOfDayUtc7(now: Date = new Date()): Date {
  const shifted = new Date(now.getTime() + 7 * 3600_000);
  const dayStartShifted = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
  return new Date(dayStartShifted - 7 * 3600_000);
}

/**
 * Số lời mời kết bạn nick đã XỬ LÝ (tạo FriendshipAttempt) hôm nay theo UTC+7.
 * Tính theo queuedAt (thời điểm attempt row được tạo) — kể cả attempt lỗi
 * (RATE_LIMITED...) vì chúng vẫn tiêu quota thao tác của nick.
 */
export async function countAttemptsToday(
  zaloAccountId: string,
  orgId: string,
  now: Date = new Date(),
): Promise<number> {
  return prisma.friendshipAttempt.count({
    where: { zaloAccountId, orgId, queuedAt: { gte: startOfDayUtc7(now) } },
  });
}

/**
 * Trần mời kết bạn/ngày cho 1 nick trong run.
 * run.dailyFriendRequestLimit (user tự đặt) nếu có → lấy cận dưới với SdkLimit
 * (SdkLimit là trần hệ thống, không vượt). Không đặt → đúng SdkLimit.
 */
export async function resolveNickDailyLimit(
  zaloAccountId: string,
  runDailyLimit: number | null | undefined,
): Promise<number> {
  const sdk = await getEffectiveLimit(zaloAccountId, 'friend_action');
  const sdkDaily = sdk.daily;
  if (runDailyLimit == null || runDailyLimit <= 0) return sdkDaily;
  return Math.min(runDailyLimit, sdkDaily);
}

/** Đọc JSON array field của run (zaloAccountIds / careScriptIds) an toàn. */
export function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.length > 0);
}

/* ── Types ───────────────────────────────────────────────────────────────── */

export interface CreateRunPayload {
  name?: string;
  mode?: string;
  zaloAccountIds?: unknown;
  dailyFriendRequestLimit?: number | null;
  greetingScriptId?: string | null;
  careScriptIds?: unknown;
  careIntervalDays?: number | null;
}

export interface RunDto {
  id: string;
  orgId: string;
  campaignId: string;
  name: string;
  mode: string;
  status: string;
  zaloAccountIds: string[];
  dailyFriendRequestLimit: number | null;
  greetingScriptId: string | null;
  greetingScriptText: string | null;
  careScriptIds: string[];
  careIntervalDays: number | null;
  configuredTotal: number;
  queuedCount: number;
  sentCount: number;
  acceptedCount: number;
  repliedCount: number;
  noZaloCount: number;
  failedCount: number;
  skippedCount: number;
  startedAt: Date | null;
  pausedAt: Date | null;
  finishedAt: Date | null;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ContactRowDto {
  id: string;
  state: string;
  zaloAccountId: string | null;
  attemptId: string | null;
  sentAt: Date | null;
  acceptedAt: Date | null;
  repliedAt: Date | null;
  lastCareAt: Date | null;
  errorCode: string | null;
  errorDetail: string | null;
  contact: { id: string; fullName: string | null; phone: string | null } | null;
}

/** Serialize row CampaignRun → DTO (JSON field thành array, không lộ thừa). */
export function toRunDto(run: any): RunDto {
  return {
    id: run.id,
    orgId: run.orgId,
    campaignId: run.campaignId,
    name: run.name,
    mode: run.mode,
    status: run.status,
    zaloAccountIds: asStringArray(run.zaloAccountIds),
    dailyFriendRequestLimit: run.dailyFriendRequestLimit ?? null,
    greetingScriptId: run.greetingScriptId ?? null,
    greetingScriptText: run.greetingScriptText ?? null,
    careScriptIds: asStringArray(run.careScriptIds),
    careIntervalDays: run.careIntervalDays ?? null,
    configuredTotal: run.configuredTotal,
    queuedCount: run.queuedCount,
    sentCount: run.sentCount,
    acceptedCount: run.acceptedCount,
    repliedCount: run.repliedCount,
    noZaloCount: run.noZaloCount,
    failedCount: run.failedCount,
    skippedCount: run.skippedCount,
    startedAt: run.startedAt ?? null,
    pausedAt: run.pausedAt ?? null,
    finishedAt: run.finishedAt ?? null,
    createdById: run.createdById ?? null,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

/* ── Mutations ───────────────────────────────────────────────────────────── */

/** Validate + tạo run ở trạng thái DRAFT. */
export async function createRun(args: {
  orgId: string;
  userId: string | null;
  campaignId: string;
  payload: CreateRunPayload;
}): Promise<RunDto> {
  const { orgId, userId, campaignId, payload } = args;

  const name = typeof payload.name === 'string' ? payload.name.trim() : '';
  if (!name) throw new CampaignExecError(400, 'NAME_REQUIRED', 'name là bắt buộc');

  const campaign = await prisma.campaign.findFirst({
    where: { id: campaignId, orgId },
    select: { id: true },
  });
  if (!campaign) throw new CampaignExecError(404, 'CAMPAIGN_NOT_FOUND', 'Không tìm thấy chiến dịch');

  const zaloAccountIds = asStringArray(payload.zaloAccountIds);
  if (zaloAccountIds.length === 0) {
    throw new CampaignExecError(400, 'ZALO_ACCOUNTS_REQUIRED', 'zaloAccountIds phải là mảng không rỗng');
  }

  const mode = (typeof payload.mode === 'string' && payload.mode.trim()) || 'friend_request';
  if (!(RUN_MODES as readonly string[]).includes(mode)) {
    throw new CampaignExecError(400, 'INVALID_MODE', `mode phải là một trong: ${RUN_MODES.join(', ')}`);
  }

  const careScriptIds = asStringArray(payload.careScriptIds);
  if (mode === 'care' && careScriptIds.length === 0) {
    throw new CampaignExecError(400, 'CARE_SCRIPTS_REQUIRED', 'mode=care yêu cầu careScriptIds không rỗng');
  }

  // Snapshot greeting script (cùng org) → greetingScriptText.
  let greetingScriptId: string | null = null;
  let greetingScriptText: string | null = null;
  if (payload.greetingScriptId) {
    const script = await prisma.campaignScript.findFirst({
      where: { id: payload.greetingScriptId, orgId },
      select: { id: true, content: true },
    });
    if (!script) throw new CampaignExecError(404, 'SCRIPT_NOT_FOUND', 'Không tìm thấy kịch bản');
    greetingScriptId = script.id;
    greetingScriptText = script.content;
  }

  // Care script ids phải thuộc org — worker sẽ đọc nội dung theo id sau này.
  if (careScriptIds.length > 0) {
    const scripts = await prisma.campaignScript.findMany({
      where: { orgId, id: { in: careScriptIds } },
      select: { id: true },
    });
    const found = new Set(scripts.map((s) => s.id));
    const missing = careScriptIds.filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw new CampaignExecError(404, 'SCRIPT_NOT_FOUND', `Kịch bản chăm sóc không tồn tại: ${missing.join(', ')}`);
    }
  }

  let dailyFriendRequestLimit: number | null = null;
  const rawLimit: unknown = payload.dailyFriendRequestLimit;
  if (rawLimit != null && rawLimit !== '') {
    const n = Number(rawLimit);
    if (!Number.isInteger(n) || n <= 0) {
      throw new CampaignExecError(400, 'INVALID_LIMIT', 'dailyFriendRequestLimit phải là số nguyên dương');
    }
    dailyFriendRequestLimit = n;
  }

  let careIntervalDays: number | null = null;
  const rawInterval: unknown = payload.careIntervalDays;
  if (rawInterval != null && rawInterval !== '') {
    const n = Number(rawInterval);
    if (!Number.isInteger(n) || n <= 0) {
      throw new CampaignExecError(400, 'INVALID_INTERVAL', 'careIntervalDays phải là số nguyên dương');
    }
    careIntervalDays = n;
  }

  const created = await prisma.campaignRun.create({
    data: {
      orgId,
      campaignId,
      name,
      mode,
      status: RUN_STATUS.DRAFT,
      zaloAccountIds,
      dailyFriendRequestLimit,
      greetingScriptId,
      greetingScriptText,
      careScriptIds,
      careIntervalDays,
      createdById: userId,
    },
  });
  return toRunDto(created);
}

/** Load run thuộc org; 404 nếu không tồn tại. */
export async function getOwnedRun(orgId: string, runId: string): Promise<RunDto> {
  const run = await prisma.campaignRun.findFirst({
    where: { id: runId, orgId },
  });
  if (!run) throw new CampaignExecError(404, 'RUN_NOT_FOUND', 'Không tìm thấy đợt chạy');
  return toRunDto(run);
}

/**
 * DRAFT → RUNNING: FILL CampaignContact từ customer lists của campaign.
 *  - CampaignCustomerList → CustomerList.id → CustomerListEntry.contactId NOT NULL
 *  - loại contact đã merged (mergedInto NOT NULL)
 *  - createMany (skipDuplicates) state=queued; set configuredTotal + queuedCount; startedAt.
 */
export async function startRun(orgId: string, runId: string): Promise<RunDto> {
  const run = await getOwnedRun(orgId, runId);
  if (run.status !== RUN_STATUS.DRAFT) {
    throw new CampaignExecError(409, 'RUN_NOT_DRAFT', `Chỉ run DRAFT mới start được (hiện tại: ${run.status})`);
  }

  const links = await prisma.campaignCustomerList.findMany({
    where: { campaignId: run.campaignId },
    select: { customerListId: true },
  });
  const listIds = links.map((l) => l.customerListId);

  let contactIds: string[] = [];
  if (listIds.length > 0) {
    const entries = await prisma.customerListEntry.findMany({
      where: { customerListId: { in: listIds }, contactId: { not: null } },
      select: { contactId: true },
      distinct: ['contactId'],
    });
    const raw = entries.map((e) => e.contactId).filter((c): c is string => c !== null);
    if (raw.length > 0) {
      const contacts = await prisma.contact.findMany({
        where: { orgId, id: { in: raw }, mergedInto: null },
        select: { id: true },
      });
      contactIds = contacts.map((c) => c.id);
    }
  }

  const now = new Date();
  if (contactIds.length > 0) {
    await prisma.campaignContact.createMany({
      data: contactIds.map((contactId) => ({
        orgId,
        campaignId: run.campaignId,
        runId: run.id,
        contactId,
        state: CONTACT_STATE.QUEUED,
      })),
      skipDuplicates: true,
    });
  }

  const updated = await prisma.campaignRun.update({
    where: { id: run.id },
    data: {
      status: RUN_STATUS.RUNNING,
      startedAt: now,
      configuredTotal: contactIds.length,
      queuedCount: contactIds.length,
    },
  });
  return toRunDto(updated);
}

/** RUNNING → PAUSED (pausedAt). */
export async function pauseRun(orgId: string, runId: string): Promise<RunDto> {
  const run = await getOwnedRun(orgId, runId);
  if (run.status !== RUN_STATUS.RUNNING) {
    throw new CampaignExecError(409, 'RUN_NOT_RUNNING', `Chỉ run RUNNING mới pause được (hiện tại: ${run.status})`);
  }
  const updated = await prisma.campaignRun.update({
    where: { id: run.id },
    data: { status: RUN_STATUS.PAUSED, pausedAt: new Date() },
  });
  return toRunDto(updated);
}

/** PAUSED → RUNNING (pausedAt=null). */
export async function resumeRun(orgId: string, runId: string): Promise<RunDto> {
  const run = await getOwnedRun(orgId, runId);
  if (run.status !== RUN_STATUS.PAUSED) {
    throw new CampaignExecError(409, 'RUN_NOT_PAUSED', `Chỉ run PAUSED mới resume được (hiện tại: ${run.status})`);
  }
  const updated = await prisma.campaignRun.update({
    where: { id: run.id },
    data: { status: RUN_STATUS.RUNNING, pausedAt: null },
  });
  return toRunDto(updated);
}

/** DRAFT | RUNNING | PAUSED → CANCELLED (finishedAt). */
export async function cancelRun(orgId: string, runId: string): Promise<RunDto> {
  const run = await getOwnedRun(orgId, runId);
  const cancellable: string[] = [RUN_STATUS.DRAFT, RUN_STATUS.RUNNING, RUN_STATUS.PAUSED];
  if (!cancellable.includes(run.status)) {
    throw new CampaignExecError(409, 'RUN_NOT_CANCELLABLE', `Run ${run.status} không thể cancel`);
  }
  const updated = await prisma.campaignRun.update({
    where: { id: run.id },
    data: { status: RUN_STATUS.CANCELLED, finishedAt: new Date() },
  });
  return toRunDto(updated);
}

/* ── Queries ─────────────────────────────────────────────────────────────── */

export interface RunDetail {
  run: RunDto;
  counts: { byState: Record<string, number> };
  nickBudget: Array<{
    zaloAccountId: string;
    displayName: string | null;
    usedToday: number;
    dailyLimit: number;
  }>;
}

/** GET /campaign-runs/:id — run + phân bổ trạng thái contact + budget từng nick. */
export async function getRunDetail(orgId: string, runId: string): Promise<RunDetail> {
  const run = await getOwnedRun(orgId, runId);

  const [grouped, nicks] = await Promise.all([
    prisma.campaignContact.groupBy({
      by: ['state'],
      where: { runId: run.id },
      _count: true,
    }),
    prisma.zaloAccount.findMany({
      where: { id: { in: run.zaloAccountIds }, orgId },
      select: { id: true, displayName: true },
    }),
  ]);

  const byState: Record<string, number> = {};
  for (const g of grouped) byState[g.state] = g._count;

  const displayNameById = new Map(nicks.map((n) => [n.id, n.displayName]));
  const now = new Date();

  const nickBudget = await Promise.all(
    run.zaloAccountIds.map(async (nick) => {
      const [usedToday, dailyLimit] = await Promise.all([
        countAttemptsToday(nick, orgId, now),
        resolveNickDailyLimit(nick, run.dailyFriendRequestLimit),
      ]);
      return {
        zaloAccountId: nick,
        displayName: displayNameById.get(nick) ?? null,
        usedToday,
        dailyLimit,
      };
    }),
  );

  return { run, counts: { byState }, nickBudget };
}

/** GET /campaign-runs/:id/contacts — phân trang contact của run (kèm Contact join). */
export async function listRunContacts(
  orgId: string,
  runId: string,
  opts: { state?: string; page?: number; pageSize?: number },
): Promise<{ contacts: ContactRowDto[]; total: number }> {
  await getOwnedRun(orgId, runId);

  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, opts.pageSize ?? 50));
  const where: any = { runId, contact: { mergedInto: null } };
  if (opts.state) where.state = opts.state;

  const [rows, total] = await Promise.all([
    prisma.campaignContact.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        contact: { select: { id: true, fullName: true, phone: true } },
      },
    }),
    prisma.campaignContact.count({ where }),
  ]);

  return {
    contacts: rows.map((r: any) => ({
      id: r.id,
      state: r.state,
      zaloAccountId: r.zaloAccountId ?? null,
      attemptId: r.attemptId ?? null,
      sentAt: r.sentAt ?? null,
      acceptedAt: r.acceptedAt ?? null,
      repliedAt: r.repliedAt ?? null,
      lastCareAt: r.lastCareAt ?? null,
      errorCode: r.errorCode ?? null,
      errorDetail: r.errorDetail ?? null,
      contact: r.contact ? { id: r.contact.id, fullName: r.contact.fullName, phone: r.contact.phone } : null,
    })),
    total,
  };
}

/** GET /campaigns/:campaignId/runs — list run của campaign, mới nhất trước. */
export async function listCampaignRuns(orgId: string, campaignId: string): Promise<RunDto[]> {
  const campaign = await prisma.campaign.findFirst({
    where: { id: campaignId, orgId },
    select: { id: true },
  });
  if (!campaign) throw new CampaignExecError(404, 'CAMPAIGN_NOT_FOUND', 'Không tìm thấy chiến dịch');

  const runs = await prisma.campaignRun.findMany({
    where: { campaignId, orgId },
    orderBy: { createdAt: 'desc' },
  });
  return runs.map(toRunDto);
}