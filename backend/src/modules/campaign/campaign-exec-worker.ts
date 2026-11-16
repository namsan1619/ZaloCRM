// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyen Tien Loc
/**
 * campaign-exec-worker.ts — Worker nền chạy chiến dịch THẬT (Agent E).
 *
 * Quét mọi CampaignRun status=RUNNING (cross-org), tick mỗi 10s. Với mỗi run:
 *   a) PROCESS QUEUED   — gửi lời mời kết bạn cho CampaignContact state=queued
 *                         (batch 20/run), chọn nick round-robin theo budget.
 *   b) ACCEPT SCAN      — FriendshipAttempt accepted → friend_request_accepted;
 *                         nếu run có greetingScriptText → gửi tin chào 1-1 → greeting_sent.
 *   c) REPLY SCAN       — Friend.lastInboundAt > sentAt/acceptedAt → replied.
 *   d) CARE SCAN        — chuỗi careScriptIds gửi tuần tự qua 1-1 UID → care_sent.
 *   e) COUNTERS         — groupBy state → cập nhật counters lên run.
 *   f) DONE / AUTO-PAUSE— hết queued + hết friend_request_sent/accepted → DONE;
 *                         mọi nick exhausted hôm nay mà còn queued → PAUSED.
 *
 * State machine contact:
 *   queued → friend_request_sent → friend_request_accepted → greeting_sent → care_sent → replied
 *   queued → no_zalo | skipped (P2002) | failed
 *
 * Safety:
 *   - inFlight guard chống chồng tick.
 *   - Cooldown nick (60s) khi RATE_LIMITED / NOT_CONNECTED — KHÔNG đánh failed.
 *   - Mọi query org-scoped chạy trong withTenant(run.orgId) (RLS-friendly).
 *   - Care script index persist qua ActivityLog action 'campaign_run_care_sent'
 *     (không cần thêm cột schema — count log = số script đã gửi).
 *
 * App wiring: KHÔNG tự start — controller gọi startCampaignExecWorker() khi boot.
 */
import { prisma } from '../../shared/database/prisma-client.js';
import { logger } from '../../shared/utils/logger.js';
import { zaloOps } from '../../shared/zalo-operations.js';
import { withTenant, runSystemQuery } from '../../shared/tenant/tenant-context.js';
import { attemptFriendRequest, DEFAULT_REQUEST_MESSAGE } from './campaign-service.js';
import {
  CONTACT_STATE,
  RUN_STATUS,
  asStringArray,
  countAttemptsToday,
  resolveNickDailyLimit,
} from './campaign-exec-service.js';

// State constants (canonical nguồn: campaign-exec-service.ts — re-export cho rõ)
export { CONTACT_STATE, RUN_STATUS };

const TICK_INTERVAL_MS = 10_000;
const QUEUED_BATCH = 20;
const SCAN_BATCH = 100;
const NICK_COOLDOWN_MS = 60_000;
const DEFAULT_CARE_INTERVAL_DAYS = 3;

const CARE_LOG_ACTION = 'campaign_run_care_sent';

let workerTimer: NodeJS.Timeout | null = null;
let inFlight = false;

// nick → timestamp hết cooldown (skip nick tạm thời khi bị rate-limit / mất kết nối)
const nickCooldown = new Map<string, number>();
// runId → index nick round-robin tiếp theo
const nickCursor = new Map<string, number>();

/* ── In-memory state reset (dùng cho test) ─────────────────────────────── */
export function resetCampaignExecWorkerState(): void {
  nickCooldown.clear();
  nickCursor.clear();
}

/* ── Worker scheduler ───────────────────────────────────────────────────── */

export function startCampaignExecWorker(): void {
  if (workerTimer) return;
  logger.info('[campaign-exec] worker starting (tick 10s)');
  workerTimer = setInterval(() => {
    void runCampaignExecTick();
  }, TICK_INTERVAL_MS);
  if (typeof workerTimer.unref === 'function') workerTimer.unref();
}

export function stopCampaignExecWorker(): void {
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
    logger.info('[campaign-exec] worker stopped');
  }
}

/** Một tick worker: mọi run RUNNING (mọi org). Export cho test gọi trực tiếp. */
export async function runCampaignExecTick(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const runs = await runSystemQuery(() =>
      prisma.campaignRun.findMany({
        where: { status: RUN_STATUS.RUNNING },
        orderBy: { createdAt: 'asc' },
        take: 20,
      }),
    );
    for (const run of runs) {
      await processCampaignRun(run).catch((err) => {
        logger.error({ err, runId: run.id }, '[campaign-exec] process run failed');
      });
    }
  } catch (err) {
    logger.error({ err }, '[campaign-exec] tick failed');
  } finally {
    inFlight = false;
  }
}

/** Xử lý 1 run đầy đủ (a→f). Export cho test gọi trực tiếp với run fixture. */
export async function processCampaignRun(run: any): Promise<void> {
  await withTenant(run.orgId, async () => {
    const now = new Date();
    await processQueuedContacts(run, now);
    await scanAccepted(run, now);
    await scanReplies(run, now);
    await scanCare(run, now);
    await updateRunCounters(run.id);
    await finalizeRun(run, now);
  });
}

/* ── a) PROCESS QUEUED ───────────────────────────────────────────────────── */

interface NickBudget {
  zaloAccountId: string;
  usedToday: number;
  dailyLimit: number;
}

/**
 * Budget hôm nay của từng nick trong run (1 lần/tick). usedToday tăng dần
 * trong tick để không giao quá budget khi batch lớn.
 */
async function loadNickBudgets(run: any, now: Date): Promise<Map<string, NickBudget>> {
  const nicks = asStringArray(run.zaloAccountIds);
  const budgets = new Map<string, NickBudget>();
  for (const nick of nicks) {
    const [usedToday, dailyLimit] = await Promise.all([
      countAttemptsToday(nick, run.orgId, now),
      resolveNickDailyLimit(nick, run.dailyFriendRequestLimit ?? null),
    ]);
    budgets.set(nick, { zaloAccountId: nick, usedToday, dailyLimit });
  }
  return budgets;
}

/** Chọn nick round-robin có budget + không trong cooldown; null nếu hết. */
function pickNick(runId: string, budgets: Map<string, NickBudget>, now: number): string | null {
  const nicks = [...budgets.keys()];
  if (nicks.length === 0) return null;
  const start = nickCursor.get(runId) ?? 0;
  for (let i = 0; i < nicks.length; i++) {
    const idx = (start + i) % nicks.length;
    const nick = nicks[idx];
    const cooldownUntil = nickCooldown.get(nick) ?? 0;
    if (cooldownUntil > now) continue;
    const budget = budgets.get(nick)!;
    if (budget.usedToday >= budget.dailyLimit) continue;
    nickCursor.set(runId, (idx + 1) % nicks.length);
    budget.usedToday += 1;
    return nick;
  }
  return null;
}

/** Có còn nick nào khả dụng (budget + không cooldown) không. */
function anyNickAvailable(budgets: Map<string, NickBudget>, now: number): boolean {
  for (const [nick, budget] of budgets) {
    const cooldownUntil = nickCooldown.get(nick) ?? 0;
    if (cooldownUntil <= now && budget.usedToday < budget.dailyLimit) return true;
  }
  return false;
}

function isRetriableErrorCode(code?: string): boolean {
  return code === 'RATE_LIMITED' || code === 'NOT_CONNECTED';
}

function cooldownNick(zaloAccountId: string, ms: number = NICK_COOLDOWN_MS): void {
  nickCooldown.set(zaloAccountId, Date.now() + ms);
}

async function processQueuedContacts(run: any, now: Date): Promise<void> {
  const budgets = await loadNickBudgets(run, now);
  const nowMs = now.getTime();

  const queued = await prisma.campaignContact.findMany({
    where: { runId: run.id, state: CONTACT_STATE.QUEUED },
    orderBy: { createdAt: 'asc' },
    take: QUEUED_BATCH,
    include: { contact: { select: { phone: true } } },
  });

  for (const cc of queued) {
    const nick = pickNick(run.id, budgets, nowMs);
    if (!nick) {
      logger.info(`[campaign-exec] run=${run.id}: hết nick khả dụng trong tick — dừng batch`);
      break;
    }
    const phone: string | null = (cc.contact as any)?.phone ?? null;
    if (!phone) {
      await prisma.campaignContact.update({
        where: { id: cc.id },
        data: { state: CONTACT_STATE.FAILED, errorCode: 'NO_PHONE', errorDetail: 'contact thiếu số điện thoại' },
      });
      continue;
    }

    const message = run.greetingScriptText?.trim() || DEFAULT_REQUEST_MESSAGE;
    try {
      const outcome = await attemptFriendRequest({
        orgId: run.orgId,
        zaloAccountId: nick,
        contactId: cc.contactId,
        phone,
        message,
      });

      if (outcome.ok && outcome.state === 'sent') {
        await prisma.campaignContact.update({
          where: { id: cc.id },
          data: {
            state: CONTACT_STATE.FRIEND_REQUEST_SENT,
            attemptId: outcome.attemptId,
            zaloAccountId: nick,
            sentAt: now,
          },
        });
      } else if (outcome.state === 'no_zalo') {
        await prisma.campaignContact.update({
          where: { id: cc.id },
          data: {
            state: CONTACT_STATE.NO_ZALO,
            zaloAccountId: nick,
            errorDetail: (outcome as any).reason ?? 'phone_not_on_zalo',
          },
        });
      } else if (outcome.state === 'error') {
        const errorCode = (outcome as any).errorCode ?? 'UNKNOWN';
        if (isRetriableErrorCode(errorCode)) {
          // Lỗi nick — GIỮ queued + cooldown, KHÔNG đánh failed.
          cooldownNick(nick);
          logger.warn(`[campaign-exec] run=${run.id} contact=${cc.contactId} nick=${nick} ${errorCode} — giữ queued + cooldown 60s`);
        } else {
          await prisma.campaignContact.update({
            where: { id: cc.id },
            data: {
              state: CONTACT_STATE.FAILED,
              zaloAccountId: nick,
              errorCode,
              errorDetail: (outcome as any).errorDetail ?? null,
            },
          });
        }
      }
    } catch (err: any) {
      const code = err?.code ?? '';
      // unique(zalo_account_id, contact_id) — nick này ĐÃ từng attempt contact này
      if (code === 'P2002') {
        await prisma.campaignContact.update({
          where: { id: cc.id },
          data: {
            state: CONTACT_STATE.SKIPPED,
            zaloAccountId: nick,
            errorCode: 'P2002',
            errorDetail: 'already attempted by this nick',
          },
        });
      } else if (isRetriableErrorCode(code)) {
        cooldownNick(nick);
        logger.warn(`[campaign-exec] run=${run.id} contact=${cc.contactId} nick=${nick} throw ${code} — giữ queued + cooldown`);
      } else {
        const detail = String(err?.message ?? err ?? 'UNKNOWN');
        await prisma.campaignContact.update({
          where: { id: cc.id },
          data: {
            state: CONTACT_STATE.FAILED,
            zaloAccountId: nick,
            errorCode: code || 'UNKNOWN',
            errorDetail: detail,
          },
        });
      }
    }
  }
}

/* ── b) ACCEPT SCAN + greeting ───────────────────────────────────────────── */

/**
 * Duyệt contact đã gửi lời mời (friend_request_sent / friend_request_accepted):
 *  - attempt state=accepted → friend_request_accepted (+ acceptedAt).
 *  - nếu run có greetingScriptText → gửi tin chào tới UID 1-1 → greeting_sent.
 *  - RATE_LIMITED → giữ friend_request_accepted + cooldown nick (retry tick sau).
 */
async function scanAccepted(run: any, now: Date): Promise<void> {
  const candidates = await prisma.campaignContact.findMany({
    where: {
      runId: run.id,
      state: { in: [CONTACT_STATE.FRIEND_REQUEST_SENT, CONTACT_STATE.FRIEND_REQUEST_ACCEPTED] },
      attemptId: { not: null },
    },
    take: SCAN_BATCH,
    select: { id: true, contactId: true, zaloAccountId: true, attemptId: true, state: true, errorCode: true },
  });
  if (candidates.length === 0) return;

  const attemptIds = candidates
    .map((c) => c.attemptId)
    .filter((id): id is string => Boolean(id));
  const acceptedAttempts = await prisma.friendshipAttempt.findMany({
    where: { id: { in: attemptIds }, state: 'accepted' },
    select: { id: true, zaloUidFound: true },
  });
  const acceptedById = new Map(acceptedAttempts.map((a) => [a.id, a]));

  for (const cc of candidates) {
    const attempt = cc.attemptId ? acceptedById.get(cc.attemptId) : undefined;
    const isAccepted = Boolean(attempt);
    if (!isAccepted) continue;
    if (!cc.zaloAccountId) continue;

    let state = cc.state;
    if (state === CONTACT_STATE.FRIEND_REQUEST_SENT) {
      await prisma.campaignContact.update({
        where: { id: cc.id },
        data: { state: CONTACT_STATE.FRIEND_REQUEST_ACCEPTED, acceptedAt: now },
      });
      state = CONTACT_STATE.FRIEND_REQUEST_ACCEPTED;
    }

    const greetingText = run.greetingScriptText?.trim();
    if (!greetingText) continue;

    // Chỉ thử gửi greeting khi chưa lỗi vĩnh viễn (errorCode null hoặc retriable)
    if (cc.errorCode && !isRetriableErrorCode(cc.errorCode)) continue;

    const uid = attempt?.zaloUidFound ?? null;
    if (!uid) {
      // Chưa có UID trong nick này — giữ trạng thái, tick sau retry qua Friend lookup
      continue;
    }

    try {
      await sendToUid(cc.zaloAccountId, uid, greetingText);
      await prisma.campaignContact.update({
        where: { id: cc.id },
        data: { state: CONTACT_STATE.GREETING_SENT, errorCode: null, errorDetail: null },
      });
    } catch (err: any) {
      const code = err?.code ?? 'SEND_FAILED';
      await prisma.campaignContact.update({
        where: { id: cc.id },
        data: { errorCode: code, errorDetail: String(err?.message ?? err ?? '') },
      });
      if (isRetriableErrorCode(code)) {
        // GIỮ friend_request_accepted + cooldown nick — tick sau gửi lại greeting.
        cooldownNick(cc.zaloAccountId);
      }
    }
  }
}

/* ── c) REPLY SCAN ────────────────────────────────────────────────────────── */

/**
 * Contact đã gửi greeting/care/accepted: nếu Friend (contactId+zaloAccountId)
 * có lastInboundAt > sentAt (hoặc acceptedAt) → KH đã nhắn lại → replied.
 */
async function scanReplies(run: any, now: Date): Promise<void> {
  const candidates = await prisma.campaignContact.findMany({
    where: {
      runId: run.id,
      state: {
        in: [
          CONTACT_STATE.GREETING_SENT,
          CONTACT_STATE.CARE_SENT,
          CONTACT_STATE.FRIEND_REQUEST_ACCEPTED,
        ],
      },
      zaloAccountId: { not: null },
    },
    take: SCAN_BATCH,
    select: { id: true, contactId: true, zaloAccountId: true, sentAt: true, acceptedAt: true, lastCareAt: true },
  });
  if (candidates.length === 0) return;

  const contactIds = [...new Set(candidates.map((c) => c.contactId))];
  const nickIds = [...new Set(candidates.map((c) => c.zaloAccountId!).filter(Boolean))];
  const friends = await prisma.friend.findMany({
    where: { orgId: run.orgId, contactId: { in: contactIds }, zaloAccountId: { in: nickIds } },
    select: { contactId: true, zaloAccountId: true, lastInboundAt: true },
  });

  // Friend không unique theo (nick, contact) — lấy lastInboundAt lớn nhất mỗi cặp.
  const lastInboundByPair = new Map<string, Date | null>();
  for (const f of friends) {
    const key = `${f.zaloAccountId}:${f.contactId}`;
    const current = lastInboundByPair.get(key);
    if (!current || (f.lastInboundAt && (!current || f.lastInboundAt > current))) {
      lastInboundByPair.set(key, f.lastInboundAt);
    }
  }

  for (const cc of candidates) {
    const key = `${cc.zaloAccountId}:${cc.contactId}`;
    const lastInbound = lastInboundByPair.get(key);
    if (!lastInbound) continue;
    const baseline = cc.sentAt ?? cc.acceptedAt ?? cc.lastCareAt;
    if (!baseline || lastInbound <= baseline) continue;
    await prisma.campaignContact.update({
      where: { id: cc.id },
      data: { state: CONTACT_STATE.REPLIED, repliedAt: lastInbound },
    });
  }
}

/* ── d) CARE SCAN ─────────────────────────────────────────────────────────── */

function careIntervalMs(run: any): number {
  const days = run.careIntervalDays && run.careIntervalDays > 0 ? run.careIntervalDays : DEFAULT_CARE_INTERVAL_DAYS;
  return days * 86_400_000;
}

/** Index care script kế tiếp = số log 'campaign_run_care_sent' của contact. */
async function careSendIndex(orgId: string, contactId: string): Promise<number> {
  return prisma.activityLog.count({
    where: { orgId, action: CARE_LOG_ACTION, entityType: 'campaignContact', entityId: contactId },
  });
}

/**
 * Chuỗi chăm sóc: với contact greeting_sent|care_sent, chưa hết script và hết
 * careIntervalDays → gửi script kế tiếp qua 1-1 UID → care_sent + lastCareAt.
 * Hết chuỗi → giữ nguyên care_sent (không gửi nữa).
 */
async function scanCare(run: any, now: Date): Promise<void> {
  const careIds = asStringArray(run.careScriptIds);
  if (careIds.length === 0) return;

  const cutoff = new Date(now.getTime() - careIntervalMs(run));
  const candidates = await prisma.campaignContact.findMany({
    where: {
      runId: run.id,
      state: { in: [CONTACT_STATE.GREETING_SENT, CONTACT_STATE.CARE_SENT] },
      zaloAccountId: { not: null },
      OR: [{ lastCareAt: null }, { lastCareAt: { lte: cutoff } }],
    },
    take: SCAN_BATCH,
    select: { id: true, contactId: true, zaloAccountId: true, lastCareAt: true },
  });
  if (candidates.length === 0) return;

  const scripts = await prisma.campaignScript.findMany({
    where: { orgId: run.orgId, id: { in: careIds } },
    select: { id: true, content: true },
  });
  const contentById = new Map(scripts.map((s) => [s.id, s.content]));

  for (const cc of candidates) {
    if (!cc.zaloAccountId) continue;
    const index = await careSendIndex(run.orgId, cc.contactId);
    if (index >= careIds.length) continue; // hết chuỗi — giữ care_sent
    const scriptId = careIds[index];
    const content = contentById.get(scriptId);
    if (!content) {
      // Script đã bị xoá — chặn chết để khỏi spam mỗi tick.
      await prisma.campaignContact.update({
        where: { id: cc.id },
        data: { errorCode: 'SCRIPT_MISSING', errorDetail: `care script ${scriptId} không tồn tại` },
      });
      continue;
    }

    const uid = await resolveContactUid(run.orgId, cc.contactId, cc.zaloAccountId);
    if (!uid) continue;

    try {
      await sendToUid(cc.zaloAccountId, uid, content);
      await prisma.campaignContact.update({
        where: { id: cc.id },
        data: { state: CONTACT_STATE.CARE_SENT, lastCareAt: now, errorCode: null, errorDetail: null },
      });
      await prisma.activityLog.create({
        data: {
          orgId: run.orgId,
          actorType: 'system',
          systemSource: 'campaign_exec_worker',
          category: 'automation',
          action: CARE_LOG_ACTION,
          entityType: 'campaignContact',
          entityId: cc.contactId,
          details: { runId: run.id, scriptId, index } as object,
        },
      });
    } catch (err: any) {
      const code = err?.code ?? 'SEND_FAILED';
      await prisma.campaignContact.update({
        where: { id: cc.id },
        data: { errorCode: code, errorDetail: String(err?.message ?? err ?? '') },
      });
      if (isRetriableErrorCode(code)) {
        cooldownNick(cc.zaloAccountId);
        // giữ greeting_sent/care_sent — tick sau gửi lại
      }
    }
  }
}

/* ── UID 1-1 resolver ─────────────────────────────────────────────────────── */

/**
 * UID của contact NHÌN TỪ nick: FriendshipAttempt.zaloUidFound (chính xác nhất),
 * fallback Friend.zaloUidInNick, fallback Contact.zaloUid.
 */
async function resolveContactUid(
  orgId: string,
  contactId: string,
  zaloAccountId: string,
): Promise<string | null> {
  const attempt = await prisma.friendshipAttempt.findUnique({
    where: { zaloAccountId_contactId: { zaloAccountId, contactId } },
    select: { zaloUidFound: true },
  });
  if (attempt?.zaloUidFound) return attempt.zaloUidFound;
  const friend = await prisma.friend.findFirst({
    where: { orgId, contactId, zaloAccountId },
    select: { zaloUidInNick: true },
    orderBy: [{ becameFriendAt: 'desc' }] as any,
  });
  if (friend?.zaloUidInNick) return friend.zaloUidInNick;
  const contact = await prisma.contact.findUnique({
    where: { id: contactId },
    select: { zaloUid: true },
  });
  return contact?.zaloUid ?? null;
}

/** Gửi tin nhắn text tới UID 1-1 (threadType=0) — pattern appointment-zalo-service. */
async function sendToUid(zaloAccountId: string, uid: string, text: string): Promise<void> {
  await zaloOps.sendMessage(zaloAccountId, uid, 0, { msg: text }, null);
}

/* ── e) COUNTERS ──────────────────────────────────────────────────────────── */

/**
 * Update counters lên run từ groupBy state. Funnel cộng dồn để số không tụt
 * khi contact tiến sâu (sent → accepted → greeting → care → replied):
 *   sentCount     = friend_request_sent + accepted + greeting + care + replied
 *   acceptedCount = accepted + greeting + care + replied
 */
export async function updateRunCounters(runId: string): Promise<void> {
  const grouped = await prisma.campaignContact.groupBy({
    by: ['state'],
    where: { runId },
    _count: true,
  });
  const counts: Record<string, number> = {};
  for (const g of grouped) counts[g.state] = g._count;

  const queued = counts[CONTACT_STATE.QUEUED] ?? 0;
  const reqSent = counts[CONTACT_STATE.FRIEND_REQUEST_SENT] ?? 0;
  const accepted = counts[CONTACT_STATE.FRIEND_REQUEST_ACCEPTED] ?? 0;
  const greeting = counts[CONTACT_STATE.GREETING_SENT] ?? 0;
  const care = counts[CONTACT_STATE.CARE_SENT] ?? 0;
  const replied = counts[CONTACT_STATE.REPLIED] ?? 0;

  await prisma.campaignRun.update({
    where: { id: runId },
    data: {
      queuedCount: queued,
      sentCount: reqSent + accepted + greeting + care + replied,
      acceptedCount: accepted + greeting + care + replied,
      repliedCount: replied,
      noZaloCount: counts[CONTACT_STATE.NO_ZALO] ?? 0,
      failedCount: counts[CONTACT_STATE.FAILED] ?? 0,
      skippedCount: counts[CONTACT_STATE.SKIPPED] ?? 0,
    },
  });
}

/* ── f) DONE / AUTO-PAUSE ─────────────────────────────────────────────────── */

/**
 * DONE khi hết việc: không còn queued, không còn friend_request_sent/accepted
 * (mọi lời mời đã được xử lý tới trạng thái cuối hoặc đã greeting).
 * AUTO-PAUSE khi còn queued nhưng MỌI nick đều exhausted/cooldown hôm nay —
 * run dừng chờ hết hạn quota; user resume sau.
 */
async function finalizeRun(run: any, now: Date): Promise<void> {
  const grouped = await prisma.campaignContact.groupBy({
    by: ['state'],
    where: { runId: run.id },
    _count: true,
  });
  const counts: Record<string, number> = {};
  for (const g of grouped) counts[g.state] = g._count;

  const queued = counts[CONTACT_STATE.QUEUED] ?? 0;
  const pendingActive =
    (counts[CONTACT_STATE.FRIEND_REQUEST_SENT] ?? 0) +
    (counts[CONTACT_STATE.FRIEND_REQUEST_ACCEPTED] ?? 0);

  if (queued === 0 && pendingActive === 0) {
    await prisma.campaignRun.update({
      where: { id: run.id },
      data: { status: RUN_STATUS.DONE, finishedAt: now },
    });
    logger.info(`[campaign-exec] run=${run.id} DONE`);
    return;
  }

  if (queued > 0) {
    const budgets = await loadNickBudgets(run, now);
    if (!anyNickAvailable(budgets, now.getTime())) {
      await prisma.campaignRun.update({
        where: { id: run.id },
        data: { status: RUN_STATUS.PAUSED, pausedAt: now },
      });
      logger.info(`[campaign-exec] run=${run.id} AUTO-PAUSE — mọi nick exhausted hôm nay`);
    }
  }
}