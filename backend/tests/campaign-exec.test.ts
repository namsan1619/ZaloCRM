// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyen Tien Loc
/**
 * campaign-exec.test.ts — Tests cho CampaignRun + worker chạy chiến dịch thật (Agent E).
 *
 * Bao phủ:
 *  - POST /campaigns/:campaignId/runs: thiếu name → 400; zaloAccountIds rỗng → 400;
 *    mode=care thiếu careScriptIds → 400; mode sai → 400; greeting script được
 *    snapshot vào greetingScriptText; campaign của org khác → 404.
 *  - POST /campaign-runs/:id/start: fill CampaignContact từ customer lists của
 *    campaign (bỏ contact merged), set configuredTotal/queuedCount, status RUNNING.
 *  - State machine: pause (409 khi không RUNNING), resume (409 khi không PAUSED),
 *    cancel (409 khi đã DONE).
 *  - Worker tick: queued → attemptFriendRequest ok → friend_request_sent + attemptId;
 *    RATE_LIMITED → giữ queued + cooldown nick (nick bị skip ở tick kế tiếp);
 *    P2002 → skipped.
 *  - Accept scan: FriendshipAttempt accepted → friend_request_accepted → gửi greeting
 *    qua zaloOps.sendMessage (UID 1-1) → greeting_sent.
 *  - Counters: groupBy state → cập nhật counters lên run.
 *  - Auto-pause: mọi nick exhausted hôm nay + còn queued → status PAUSED.
 *
 * TUYỆT ĐỐI không gọi Zalo/DB thật — mock prisma-client, campaign-service,
 * zalo-operations, sdk-limit-service.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { mockUser } from './test-helpers.js';

// ── Hoisted mock state ────────────────────────────────────────────────────────
const prismaMock = {
  campaign: {
    findFirst: vi.fn(),
  },
  campaignRun: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  campaignContact: {
    findMany: vi.fn(),
    createMany: vi.fn(),
    update: vi.fn(),
    groupBy: vi.fn(),
    count: vi.fn(),
  },
  campaignCustomerList: {
    findMany: vi.fn(),
  },
  customerListEntry: {
    findMany: vi.fn(),
  },
  contact: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
  },
  campaignScript: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
  },
  friendshipAttempt: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    count: vi.fn(),
  },
  friend: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
  },
  zaloAccount: {
    findMany: vi.fn(),
  },
  activityLog: {
    count: vi.fn(),
    create: vi.fn(),
  },
};

const attemptFriendRequestMock = vi.fn();
const sendMessageMock = vi.fn();
const getEffectiveLimitMock = vi.fn();

let currentRole = 'admin';

vi.mock('../src/shared/database/prisma-client.js', () => ({
  prisma: prismaMock,
}));
vi.mock('../src/shared/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/modules/auth/auth-middleware.js', () => ({
  authMiddleware: async (req: any) => {
    req.user = mockUser({ role: currentRole });
  },
}));
vi.mock('../src/modules/activity/activity-logger.js', () => ({ logActivity: vi.fn() }));
vi.mock('../src/modules/campaign/campaign-service.js', () => ({
  attemptFriendRequest: (...args: unknown[]) => attemptFriendRequestMock(...args),
  DEFAULT_REQUEST_MESSAGE: 'Xin chào! Tôi đang phân phối dự án.',
}));
vi.mock('../src/shared/zalo-operations.js', () => ({
  zaloOps: {
    sendMessage: (...args: unknown[]) => sendMessageMock(...args),
  },
}));
vi.mock('../src/modules/zalo/sdk-limit-service.js', () => ({
  getEffectiveLimit: (...args: unknown[]) => getEffectiveLimitMock(...args),
}));

const { registerCampaignExecRoutes } = await import('../src/modules/campaign/campaign-exec-routes.js');
const {
  processCampaignRun,
  updateRunCounters,
  resetCampaignExecWorkerState,
} = await import('../src/modules/campaign/campaign-exec-worker.js');
const { logActivity } = await import('../src/modules/activity/activity-logger.js');

function buildApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  app.register(registerCampaignExecRoutes);
  return app;
}

// ── Fixtures ─────────────────────────────────────────────────────────────────
const RUN_ID = 'run-1';
const CAMPAIGN_ID = 'cmp-1';

function runRow(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    orgId: 'org-1',
    campaignId: CAMPAIGN_ID,
    name: 'Đợt 1',
    mode: 'friend_request',
    status: 'DRAFT',
    zaloAccountIds: ['nick-1'],
    dailyFriendRequestLimit: null,
    greetingScriptId: null,
    greetingScriptText: null,
    careScriptIds: [],
    careIntervalDays: null,
    configuredTotal: 0,
    queuedCount: 0,
    sentCount: 0,
    acceptedCount: 0,
    repliedCount: 0,
    noZaloCount: 0,
    failedCount: 0,
    skippedCount: 0,
    startedAt: null,
    pausedAt: null,
    finishedAt: null,
    createdById: 'user-1',
    createdAt: new Date('2026-11-16T00:00:00.000Z'),
    updatedAt: new Date('2026-11-16T00:00:00.000Z'),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  currentRole = 'admin';
  resetCampaignExecWorkerState();

  prismaMock.campaign.findFirst.mockResolvedValue({ id: CAMPAIGN_ID });
  prismaMock.campaignScript.findFirst.mockResolvedValue({ id: 'scr-1', content: 'Chào bạn, mình gửi thông tin dự án' });
  prismaMock.campaignScript.findMany.mockResolvedValue([{ id: 'scr-care', content: 'Bạn còn quan tâm dự án không?' }]);
  prismaMock.campaignRun.create.mockImplementation(async ({ data }: any) => ({ ...runRow(), ...data }));
  prismaMock.campaignRun.findFirst.mockResolvedValue(runRow());
  prismaMock.campaignRun.update.mockImplementation(async ({ data }: any) => ({ ...runRow(), ...data }));
  prismaMock.campaignContact.createMany.mockResolvedValue({ count: 0 });
  prismaMock.campaignContact.update.mockImplementation(async ({ data }: any) => ({ id: 'cc-1', ...data }));
  prismaMock.campaignContact.groupBy.mockResolvedValue([]);
  prismaMock.campaignContact.count.mockResolvedValue(0);
  prismaMock.campaignCustomerList.findMany.mockResolvedValue([{ customerListId: 'list-1' }]);
  prismaMock.customerListEntry.findMany.mockResolvedValue([
    { contactId: 'ct-1' },
    { contactId: 'ct-2' },
    { contactId: 'ct-merged' },
  ]);
  prismaMock.contact.findMany.mockResolvedValue([{ id: 'ct-1' }, { id: 'ct-2' }]);
  prismaMock.contact.findUnique.mockResolvedValue({ zaloUid: 'uid-global' });
  prismaMock.friendshipAttempt.count.mockResolvedValue(0);
  prismaMock.friendshipAttempt.findMany.mockResolvedValue([]);
  prismaMock.friendshipAttempt.findUnique.mockResolvedValue(null);
  prismaMock.friend.findMany.mockResolvedValue([]);
  prismaMock.friend.findFirst.mockResolvedValue(null);
  prismaMock.zaloAccount.findMany.mockResolvedValue([{ id: 'nick-1', displayName: 'Nick 1' }]);
  prismaMock.activityLog.count.mockResolvedValue(0);
  prismaMock.activityLog.create.mockResolvedValue({});
  getEffectiveLimitMock.mockResolvedValue({ daily: 30, burst: 8, burstWindowMs: 60_000 });
  attemptFriendRequestMock.mockResolvedValue({ attemptId: 'att-1', ok: true, state: 'sent', zaloUid: 'uid-1' });
  sendMessageMock.mockResolvedValue({ message: { msgId: 'msg-1' } });
});

// ── POST /api/v1/campaigns/:campaignId/runs ───────────────────────────────────
describe('POST /api/v1/campaigns/:campaignId/runs', () => {
  const URL = `/api/v1/campaigns/${CAMPAIGN_ID}/runs`;

  it('thiếu name → 400, không ghi DB', async () => {
    const res = await buildApp().inject({
      method: 'POST',
      url: URL,
      payload: { zaloAccountIds: ['nick-1'] },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe('NAME_REQUIRED');
    expect(prismaMock.campaignRun.create).not.toHaveBeenCalled();
  });

  it('zaloAccountIds rỗng → 400', async () => {
    const res = await buildApp().inject({
      method: 'POST',
      url: URL,
      payload: { name: 'Đợt 1', zaloAccountIds: [] },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe('ZALO_ACCOUNTS_REQUIRED');
    expect(prismaMock.campaignRun.create).not.toHaveBeenCalled();
  });

  it('mode=care mà thiếu careScriptIds → 400', async () => {
    const res = await buildApp().inject({
      method: 'POST',
      url: URL,
      payload: { name: 'Đợt 1', mode: 'care', zaloAccountIds: ['nick-1'] },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe('CARE_SCRIPTS_REQUIRED');
    expect(prismaMock.campaignRun.create).not.toHaveBeenCalled();
  });

  it('mode không hợp lệ → 400 INVALID_MODE', async () => {
    const res = await buildApp().inject({
      method: 'POST',
      url: URL,
      payload: { name: 'Đợt 1', mode: 'spam', zaloAccountIds: ['nick-1'] },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe('INVALID_MODE');
  });

  it('campaign thuộc org khác → 404', async () => {
    prismaMock.campaign.findFirst.mockResolvedValue(null);
    const res = await buildApp().inject({
      method: 'POST',
      url: URL,
      payload: { name: 'Đợt 1', zaloAccountIds: ['nick-1'] },
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).code).toBe('CAMPAIGN_NOT_FOUND');
  });

  it('greeting script được snapshot vào greetingScriptText', async () => {
    const res = await buildApp().inject({
      method: 'POST',
      url: URL,
      payload: { name: 'Đợt 1', zaloAccountIds: ['nick-1'], greetingScriptId: 'scr-1' },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.run.status).toBe('DRAFT');
    expect(body.run.greetingScriptText).toBe('Chào bạn, mình gửi thông tin dự án');
    const createData = prismaMock.campaignRun.create.mock.calls[0][0].data;
    expect(createData.greetingScriptId).toBe('scr-1');
    expect(createData.greetingScriptText).toBe('Chào bạn, mình gửi thông tin dự án');
    expect(createData.mode).toBe('friend_request');
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'campaign_run_created', entityId: RUN_ID }),
    );
  });

  it('role member → 403', async () => {
    currentRole = 'member';
    const res = await buildApp().inject({
      method: 'POST',
      url: URL,
      payload: { name: 'Đợt 1', zaloAccountIds: ['nick-1'] },
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).code).toBe('RBAC_FORBIDDEN');
  });
});

// ── POST /api/v1/campaign-runs/:id/start ─────────────────────────────────────
describe('POST /api/v1/campaign-runs/:id/start', () => {
  const URL = `/api/v1/campaign-runs/${RUN_ID}/start`;

  it('fill contact từ customer list, set configuredTotal + queuedCount, chuyển RUNNING', async () => {
    const res = await buildApp().inject({ method: 'POST', url: URL });
    expect(res.statusCode).toBe(200);

    const createManyData = prismaMock.campaignContact.createMany.mock.calls[0][0].data;
    expect(createManyData).toHaveLength(2); // ct-merged bị loại (merged)
    expect(createManyData.map((d: any) => d.contactId).sort()).toEqual(['ct-1', 'ct-2']);
    expect(createManyData[0].state).toBe('queued');
    expect(createManyData[0].runId).toBe(RUN_ID);
    expect(prismaMock.campaignContact.createMany.mock.calls[0][0].skipDuplicates).toBe(true);

    const updateData = prismaMock.campaignRun.update.mock.calls[0][0].data;
    expect(updateData.status).toBe('RUNNING');
    expect(updateData.configuredTotal).toBe(2);
    expect(updateData.queuedCount).toBe(2);
    expect(updateData.startedAt).toBeInstanceOf(Date);

    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'campaign_run_started', entityId: RUN_ID }),
    );
  });

  it('run không ở DRAFT → 409 RUN_NOT_DRAFT', async () => {
    prismaMock.campaignRun.findFirst.mockResolvedValue(runRow({ status: 'RUNNING' }));
    const res = await buildApp().inject({ method: 'POST', url: URL });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe('RUN_NOT_DRAFT');
    expect(prismaMock.campaignContact.createMany).not.toHaveBeenCalled();
  });
});

// ── State machine pause / resume / cancel ────────────────────────────────────
describe('state machine của campaign run', () => {
  it('pause từ RUNNING → PAUSED + pausedAt', async () => {
    prismaMock.campaignRun.findFirst.mockResolvedValue(runRow({ status: 'RUNNING' }));
    const res = await buildApp().inject({ method: 'POST', url: `/api/v1/campaign-runs/${RUN_ID}/pause` });
    expect(res.statusCode).toBe(200);
    const data = prismaMock.campaignRun.update.mock.calls[0][0].data;
    expect(data.status).toBe('PAUSED');
    expect(data.pausedAt).toBeInstanceOf(Date);
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'campaign_run_paused' }),
    );
  });

  it('pause từ DRAFT → 409 RUN_NOT_RUNNING', async () => {
    const res = await buildApp().inject({ method: 'POST', url: `/api/v1/campaign-runs/${RUN_ID}/pause` });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe('RUN_NOT_RUNNING');
  });

  it('resume từ PAUSED → RUNNING + pausedAt=null', async () => {
    prismaMock.campaignRun.findFirst.mockResolvedValue(runRow({ status: 'PAUSED' }));
    const res = await buildApp().inject({ method: 'POST', url: `/api/v1/campaign-runs/${RUN_ID}/resume` });
    expect(res.statusCode).toBe(200);
    const data = prismaMock.campaignRun.update.mock.calls[0][0].data;
    expect(data.status).toBe('RUNNING');
    expect(data.pausedAt).toBeNull();
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'campaign_run_resumed' }),
    );
  });

  it('resume từ DRAFT → 409 RUN_NOT_PAUSED', async () => {
    const res = await buildApp().inject({ method: 'POST', url: `/api/v1/campaign-runs/${RUN_ID}/resume` });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe('RUN_NOT_PAUSED');
  });

  it('cancel từ RUNNING → CANCELLED + finishedAt', async () => {
    prismaMock.campaignRun.findFirst.mockResolvedValue(runRow({ status: 'RUNNING' }));
    const res = await buildApp().inject({ method: 'POST', url: `/api/v1/campaign-runs/${RUN_ID}/cancel` });
    expect(res.statusCode).toBe(200);
    const data = prismaMock.campaignRun.update.mock.calls[0][0].data;
    expect(data.status).toBe('CANCELLED');
    expect(data.finishedAt).toBeInstanceOf(Date);
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'campaign_run_cancelled' }),
    );
  });

  it('cancel từ DONE → 409 RUN_NOT_CANCELLABLE', async () => {
    prismaMock.campaignRun.findFirst.mockResolvedValue(runRow({ status: 'DONE' }));
    const res = await buildApp().inject({ method: 'POST', url: `/api/v1/campaign-runs/${RUN_ID}/cancel` });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe('RUN_NOT_CANCELLABLE');
  });
});

// ── GET /api/v1/campaign-runs/:id ────────────────────────────────────────────
describe('GET /api/v1/campaign-runs/:id', () => {
  it('trả run + counts.byState + nickBudget', async () => {
    prismaMock.campaignRun.findFirst.mockResolvedValue(runRow({ status: 'RUNNING' }));
    prismaMock.campaignContact.groupBy.mockResolvedValue([
      { state: 'queued', _count: 2 },
      { state: 'replied', _count: 1 },
    ]);
    prismaMock.friendshipAttempt.count.mockResolvedValue(7);

    const res = await buildApp().inject({ method: 'GET', url: `/api/v1/campaign-runs/${RUN_ID}` });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.counts.byState).toEqual({ queued: 2, replied: 1 });
    expect(body.nickBudget).toEqual([
      { zaloAccountId: 'nick-1', displayName: 'Nick 1', usedToday: 7, dailyLimit: 30 },
    ]);
  });
});

// ── Worker tick ─────────────────────────────────────────────────────────────
describe('worker xử lý campaign run', () => {
  const run = runRow({ status: 'RUNNING', greetingScriptText: 'Chào bạn!' });

  it('queued → attemptFriendRequest ok → friend_request_sent + attemptId', async () => {
    prismaMock.campaignContact.findMany.mockImplementation(async ({ where }: any) => {
      if (where.state === 'queued') {
        return [{ id: 'cc-1', contactId: 'ct-1', contact: { phone: '0900000001' } }];
      }
      return [];
    });

    await processCampaignRun(run);

    expect(attemptFriendRequestMock).toHaveBeenCalledTimes(1);
    expect(attemptFriendRequestMock.mock.calls[0][0]).toMatchObject({
      orgId: 'org-1',
      zaloAccountId: 'nick-1',
      contactId: 'ct-1',
      phone: '0900000001',
      message: 'Chào bạn!',
    });
    const updateCall = prismaMock.campaignContact.update.mock.calls[0][0];
    expect(updateCall.where).toEqual({ id: 'cc-1' });
    expect(updateCall.data.state).toBe('friend_request_sent');
    expect(updateCall.data.attemptId).toBe('att-1');
    expect(updateCall.data.zaloAccountId).toBe('nick-1');
    expect(updateCall.data.sentAt).toBeInstanceOf(Date);
  });

  it('RATE_LIMITED → giữ queued + cooldown nick (nick bị skip cho contact sau)', async () => {
    prismaMock.campaignContact.findMany.mockImplementation(async ({ where }: any) => {
      if (where.state === 'queued') {
        return [
          { id: 'cc-1', contactId: 'ct-1', contact: { phone: '0900000001' } },
          { id: 'cc-2', contactId: 'ct-2', contact: { phone: '0900000002' } },
        ];
      }
      return [];
    });
    attemptFriendRequestMock.mockResolvedValue({
      attemptId: 'att-1',
      ok: false,
      state: 'error',
      errorCode: 'RATE_LIMITED',
      errorDetail: 'quá tần',
    });

    await processCampaignRun(run);

    // Contact KHÔNG bị đánh failed (không có update sang state lỗi).
    const failedUpdates = prismaMock.campaignContact.update.mock.calls.filter(
      (c: any) => c[0].data.state === 'failed',
    );
    expect(failedUpdates).toHaveLength(0);
    // Nick vào cooldown → contact thứ 2 không được gửi trong cùng tick.
    expect(attemptFriendRequestMock).toHaveBeenCalledTimes(1);
  });

  it('P2002 (nick đã attempt contact này) → skipped', async () => {
    prismaMock.campaignContact.findMany.mockImplementation(async ({ where }: any) => {
      if (where.state === 'queued') {
        return [{ id: 'cc-1', contactId: 'ct-1', contact: { phone: '0900000001' } }];
      }
      return [];
    });
    attemptFriendRequestMock.mockRejectedValue(
      Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }),
    );

    await processCampaignRun(run);

    const updateCall = prismaMock.campaignContact.update.mock.calls[0][0];
    expect(updateCall.data.state).toBe('skipped');
    expect(updateCall.data.errorDetail).toBe('already attempted by this nick');
  });

  it('accept scan → friend_request_accepted → gửi greeting 1-1 → greeting_sent', async () => {
    prismaMock.campaignContact.findMany.mockImplementation(async ({ where }: any) => {
      if (where.state === 'queued') return [];
      if (where.state?.in?.includes('friend_request_sent')) {
        return [
          {
            id: 'cc-1',
            contactId: 'ct-1',
            zaloAccountId: 'nick-1',
            attemptId: 'att-1',
            state: 'friend_request_sent',
            errorCode: null,
          },
        ];
      }
      return [];
    });
    prismaMock.friendshipAttempt.findMany.mockResolvedValue([
      { id: 'att-1', zaloUidFound: 'uid-1' },
    ]);

    await processCampaignRun(run);

    const states = prismaMock.campaignContact.update.mock.calls.map((c: any) => c[0].data.state);
    expect(states).toContain('friend_request_accepted');
    expect(states).toContain('greeting_sent');
    expect(sendMessageMock).toHaveBeenCalledWith('nick-1', 'uid-1', 0, { msg: 'Chào bạn!' }, null);
  });

  it('RATE_LIMITED khi gửi greeting → giữ friend_request_accepted + cooldown nick', async () => {
    prismaMock.campaignContact.findMany.mockImplementation(async ({ where }: any) => {
      if (where.state === 'queued') return [];
      if (where.state?.in?.includes('friend_request_sent')) {
        return [
          {
            id: 'cc-1',
            contactId: 'ct-1',
            zaloAccountId: 'nick-1',
            attemptId: 'att-1',
            state: 'friend_request_sent',
            errorCode: null,
          },
        ];
      }
      return [];
    });
    prismaMock.friendshipAttempt.findMany.mockResolvedValue([
      { id: 'att-1', zaloUidFound: 'uid-1' },
    ]);
    sendMessageMock.mockRejectedValue(
      Object.assign(new Error('rate limited'), { code: 'RATE_LIMITED' }),
    );

    await processCampaignRun(run);

    const states = prismaMock.campaignContact.update.mock.calls.map((c: any) => c[0].data.state);
    expect(states).toContain('friend_request_accepted');
    expect(states).not.toContain('greeting_sent');
  });

  it('reply scan → Friend.lastInboundAt > sentAt → replied', async () => {
    prismaMock.campaignContact.findMany.mockImplementation(async ({ where }: any) => {
      if (where.state === 'queued') return [];
      if (where.state?.in?.includes('greeting_sent') && !where.OR) {
        return [
          {
            id: 'cc-1',
            contactId: 'ct-1',
            zaloAccountId: 'nick-1',
            sentAt: new Date('2026-11-16T00:00:00.000Z'),
            acceptedAt: null,
            lastCareAt: null,
          },
        ];
      }
      return [];
    });
    prismaMock.friend.findMany.mockResolvedValue([
      {
        contactId: 'ct-1',
        zaloAccountId: 'nick-1',
        lastInboundAt: new Date('2026-11-16T02:00:00.000Z'),
      },
    ]);

    await processCampaignRun(run);

    const replied = prismaMock.campaignContact.update.mock.calls.find(
      (c: any) => c[0].data.state === 'replied',
    );
    expect(replied).toBeDefined();
    expect(replied![0].data.repliedAt).toBeInstanceOf(Date);
  });

  it('mọi nick exhausted hôm nay + còn queued → AUTO-PAUSE', async () => {
    prismaMock.campaignContact.findMany.mockImplementation(async ({ where }: any) => {
      if (where.state === 'queued') {
        return [{ id: 'cc-1', contactId: 'ct-1', contact: { phone: '0900000001' } }];
      }
      return [];
    });
    prismaMock.friendshipAttempt.count.mockResolvedValue(30); // đã dùng hết trần 30/ngày
    prismaMock.campaignContact.groupBy.mockResolvedValue([{ state: 'queued', _count: 1 }]);

    await processCampaignRun(run);

    expect(attemptFriendRequestMock).not.toHaveBeenCalled();
    const paused = prismaMock.campaignRun.update.mock.calls.find(
      (c: any) => c[0].data.status === 'PAUSED',
    );
    expect(paused).toBeDefined();
    expect(paused![0].data.pausedAt).toBeInstanceOf(Date);
  });

  it('hết queued + hết friend_request pending → DONE', async () => {
    prismaMock.campaignContact.findMany.mockResolvedValue([]);
    prismaMock.campaignContact.groupBy.mockResolvedValue([{ state: 'replied', _count: 2 }]);

    await processCampaignRun(run);

    const done = prismaMock.campaignRun.update.mock.calls.find(
      (c: any) => c[0].data.status === 'DONE',
    );
    expect(done).toBeDefined();
    expect(done![0].data.finishedAt).toBeInstanceOf(Date);
  });
});

// ── Counters ─────────────────────────────────────────────────────────────────
describe('updateRunCounters', () => {
  it('set counters từ groupBy state', async () => {
    prismaMock.campaignContact.groupBy.mockResolvedValue([
      { state: 'queued', _count: 2 },
      { state: 'friend_request_sent', _count: 3 },
      { state: 'greeting_sent', _count: 1 },
      { state: 'replied', _count: 4 },
      { state: 'no_zalo', _count: 5 },
      { state: 'failed', _count: 6 },
      { state: 'skipped', _count: 7 },
    ]);

    await updateRunCounters(RUN_ID);

    const data = prismaMock.campaignRun.update.mock.calls[0][0].data;
    expect(data.queuedCount).toBe(2);
    expect(data.sentCount).toBe(3 + 1 + 4); // sent + greeting + replied
    expect(data.acceptedCount).toBe(1 + 4); // greeting + replied
    expect(data.repliedCount).toBe(4);
    expect(data.noZaloCount).toBe(5);
    expect(data.failedCount).toBe(6);
    expect(data.skippedCount).toBe(7);
  });
});
