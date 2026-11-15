// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyễn Tiến Lộc
/**
 * campaign-tracker.test.ts — Tracker chiến dịch marketing (P4).
 *
 * Bao phủ:
 *  - GET    /api/v1/campaigns              — list + filter + org scope
 *  - POST   /api/v1/campaigns              — validate name, tạo links, 400 khi ref sai org
 *  - GET    /api/v1/campaigns/:id          — 404 khi không thuộc org
 *  - PUT    /api/v1/campaigns/:id          — partial update, 404, replace links
 *  - DELETE /api/v1/campaigns/:id          — 404 + xoá
 *  - PATCH  /api/v1/campaigns/:id/status   — validate enum status
 *  - GET    /api/v1/campaigns/:id/stats    — totalContacts/friendRequestsSent/repliedContacts/conversionRate
 *  - Regression: 2 endpoint CE cũ (random-friend-request, contacts/:contactId/attempts) CÒN NGUYÊN.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { mockUser } from './test-helpers.js';

// ── Prisma mock ─────────────────────────────────────────────────────────────
const prismaMock = {
  campaign: {
    findMany: vi.fn(),
    count: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  campaignCustomerList: {
    findMany: vi.fn(),
    createMany: vi.fn(),
    deleteMany: vi.fn(),
  },
  campaignProject: {
    findMany: vi.fn(),
    createMany: vi.fn(),
    deleteMany: vi.fn(),
    count: vi.fn(),
  },
  customerList: { findMany: vi.fn() },
  project: { findMany: vi.fn() },
  customerListEntry: { findMany: vi.fn() },
  friendshipAttempt: { count: vi.fn(), groupBy: vi.fn(), findMany: vi.fn() },
  contact: { count: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
};

vi.mock('../src/shared/database/prisma-client.js', () => ({ prisma: prismaMock }));
vi.mock('../src/shared/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/modules/activity/activity-logger.js', () => ({ logActivity: vi.fn() }));
vi.mock('../src/modules/auth/auth-middleware.js', () => ({
  authMiddleware: async (req: any) => { req.user = mockUser(); },
}));
let grantAllowed = true;
vi.mock('../src/modules/rbac/rbac-middleware.js', () => ({
  requireGrant: () => async (_req: any, reply: any) => {
    if (!grantAllowed) return reply.status(403).send({ error: 'forbidden' });
  },
}));

// Mock 2 endpoint CE cũ để campaign-routes.ts load được (không kéo zalo SDK vào test)
vi.mock('../src/modules/zalo/zalo-route-helpers.js', () => ({
  resolveAccount: vi.fn(async () => ({ id: 'acc-1' })),
  checkAccess: vi.fn(async () => true),
  handleError: vi.fn((reply: any) => reply.status(500).send({ error: 'handle_error' })),
}));
vi.mock('../src/modules/campaign/campaign-service.js', () => ({
  executeRandomFriendRequest: vi.fn(async () => ({ picked: true, contactId: 'c-1' })),
}));

const { campaignTrackerRoutes } = await import('../src/modules/campaign/campaign-tracker-routes.js');
const { campaignRoutes } = await import('../src/modules/campaign/campaign-routes.js');
const { logActivity } = await import('../src/modules/activity/activity-logger.js');

const ORG = 'org-1';

function buildApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  app.register(campaignTrackerRoutes);
  return app;
}

function campaignRow(over: Record<string, unknown> = {}) {
  return {
    id: 'camp-1',
    orgId: ORG,
    name: 'Chiến dịch Q1',
    channelCode: 'facebook',
    typeCode: null,
    startAt: null,
    endAt: null,
    costVnd: null,
    status: 'DRAFT',
    script: null,
    note: null,
    createdById: 'user-1',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-02T00:00:00Z'),
    customerLists: [],
    projects: [],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  grantAllowed = true;
  prismaMock.campaign.findMany.mockResolvedValue([]);
  prismaMock.campaign.count.mockResolvedValue(0);
  prismaMock.campaign.findFirst.mockResolvedValue(campaignRow());
  prismaMock.campaign.create.mockImplementation(async ({ data }: any) => campaignRow({ ...data, id: 'camp-new' }));
  prismaMock.campaign.update.mockImplementation(async ({ data }: any) => campaignRow(data));
  prismaMock.campaign.delete.mockResolvedValue({});
  prismaMock.campaignCustomerList.findMany.mockResolvedValue([]);
  prismaMock.campaignCustomerList.createMany.mockResolvedValue({ count: 0 });
  prismaMock.campaignCustomerList.deleteMany.mockResolvedValue({ count: 0 });
  prismaMock.campaignProject.count.mockResolvedValue(0);
  prismaMock.campaignProject.createMany.mockResolvedValue({ count: 0 });
  prismaMock.campaignProject.deleteMany.mockResolvedValue({ count: 0 });
  prismaMock.customerList.findMany.mockResolvedValue([]);
  prismaMock.project.findMany.mockResolvedValue([]);
  prismaMock.customerListEntry.findMany.mockResolvedValue([]);
  prismaMock.friendshipAttempt.count.mockResolvedValue(0);
  prismaMock.friendshipAttempt.findMany.mockResolvedValue([]);
  prismaMock.contact.count.mockResolvedValue(0);
  prismaMock.contact.findMany.mockResolvedValue([]);
});

// ── GET /api/v1/campaigns ────────────────────────────────────────────────────
describe('GET /api/v1/campaigns (list)', () => {
  it('trả campaigns + total, scope theo orgId', async () => {
    prismaMock.campaign.findMany.mockResolvedValue([campaignRow()]);
    prismaMock.campaign.count.mockResolvedValue(1);

    const res = await buildApp().inject({ method: 'GET', url: '/api/v1/campaigns' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.campaigns).toHaveLength(1);
    expect(body.campaigns[0].name).toBe('Chiến dịch Q1');
    expect(body.total).toBe(1);

    const where = prismaMock.campaign.findMany.mock.calls[0][0].where;
    expect(where.orgId).toBe(ORG);
  });

  it('filter status/channelCode/q được truyền xuống where', async () => {
    await buildApp().inject({
      method: 'GET',
      url: '/api/v1/campaigns?status=RUNNING&channelCode=facebook&q=q1',
    });
    const where = prismaMock.campaign.findMany.mock.calls[0][0].where;
    expect(where.status).toBe('RUNNING');
    expect(where.channelCode).toBe('facebook');
    expect(where.name.contains).toBe('q1');
  });

  it('403 khi user không có grant', async () => {
    grantAllowed = false;
    const res = await buildApp().inject({ method: 'GET', url: '/api/v1/campaigns' });
    expect(res.statusCode).toBe(403);
  });

  it('page=2&limit=10 → skip=10, take=10 (FE gửi page chứ không gửi offset)', async () => {
    await buildApp().inject({ method: 'GET', url: '/api/v1/campaigns?page=2&limit=10' });
    const args = prismaMock.campaign.findMany.mock.calls[0][0];
    expect(args.skip).toBe(10);
    expect(args.take).toBe(10);
  });
});

// ── POST /api/v1/campaigns ──────────────────────────────────────────────────
describe('POST /api/v1/campaigns (create)', () => {
  it('thiếu name → 400, không gọi prisma.create', async () => {
    const res = await buildApp().inject({
      method: 'POST',
      url: '/api/v1/campaigns',
      payload: { channelCode: 'facebook' },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('name_required');
    expect(prismaMock.campaign.create).not.toHaveBeenCalled();
  });

  it('tạo campaign + link list/project, trả 201', async () => {
    prismaMock.customerList.findMany.mockResolvedValue([{ id: 'list-1' }]);
    prismaMock.project.findMany.mockResolvedValue([{ id: 'proj-1' }]);

    const res = await buildApp().inject({
      method: 'POST',
      url: '/api/v1/campaigns',
      payload: {
        name: '  Chiến dịch mới  ',
        channelCode: 'facebook',
        customerListIds: ['list-1'],
        projectIds: ['proj-1'],
      },
    });
    expect(res.statusCode).toBe(201);

    const createArg = prismaMock.campaign.create.mock.calls[0][0].data;
    expect(createArg.name).toBe('Chiến dịch mới');
    expect(createArg.orgId).toBe(ORG);
    expect(createArg.status).toBe('DRAFT');

    expect(prismaMock.campaignCustomerList.createMany).toHaveBeenCalledWith({
      data: [{ campaignId: 'camp-new', customerListId: 'list-1' }],
    });
    expect(prismaMock.campaignProject.createMany).toHaveBeenCalledWith({
      data: [{ campaignId: 'camp-new', projectId: 'proj-1' }],
    });
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'campaign_create', entityType: 'campaign' }),
    );
  });

  it('customerListId không thuộc org → 400 customer_list_not_found', async () => {
    prismaMock.customerList.findMany.mockResolvedValue([]);
    const res = await buildApp().inject({
      method: 'POST',
      url: '/api/v1/campaigns',
      payload: { name: 'X', customerListIds: ['list-khong-ton-tai'] },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('customer_list_not_found');
    expect(body.detailIds).toEqual(['list-khong-ton-tai']);
    expect(prismaMock.campaign.create).not.toHaveBeenCalled();
  });

  it('projectId không thuộc org → 400 project_not_found', async () => {
    prismaMock.project.findMany.mockResolvedValue([]);
    const res = await buildApp().inject({
      method: 'POST',
      url: '/api/v1/campaigns',
      payload: { name: 'X', projectIds: ['proj-khong-ton-tai'] },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('project_not_found');
  });

  it('startAt > endAt → 400 date_range_invalid', async () => {
    const res = await buildApp().inject({
      method: 'POST',
      url: '/api/v1/campaigns',
      payload: {
        name: 'X',
        startAt: '2026-05-10T00:00:00Z',
        endAt: '2026-05-01T00:00:00Z',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('date_range_invalid');
  });

  it('costVnd âm / không phải số nguyên → 400 invalid_costVnd', async () => {
    const res1 = await buildApp().inject({
      method: 'POST', url: '/api/v1/campaigns', payload: { name: 'X', costVnd: -5 },
    });
    expect(res1.statusCode).toBe(400);
    expect(JSON.parse(res1.body).error).toBe('invalid_costVnd');

    const res2 = await buildApp().inject({
      method: 'POST', url: '/api/v1/campaigns', payload: { name: 'X', costVnd: 1.5 },
    });
    expect(res2.statusCode).toBe(400);
  });

  it('startAt không parse được → 400 invalid_startAt', async () => {
    const res = await buildApp().inject({
      method: 'POST', url: '/api/v1/campaigns', payload: { name: 'X', startAt: 'không-phải-ngày' },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_startAt');
  });
});

// ── GET /api/v1/campaigns/:id ───────────────────────────────────────────────
describe('GET /api/v1/campaigns/:id (detail)', () => {
  it('trả campaign kèm link list/project + resolve name', async () => {
    prismaMock.campaign.findFirst.mockResolvedValue(
      campaignRow({
        customerLists: [{ id: 'cl-1', customerListId: 'list-1' }],
        projects: [{ id: 'cp-1', projectId: 'proj-1' }],
      }),
    );
    prismaMock.customerList.findMany.mockResolvedValue([{ id: 'list-1', name: 'Lead FB Q1' }]);
    prismaMock.project.findMany.mockResolvedValue([{ id: 'proj-1', name: 'Vinhomes Grand Park' }]);

    const res = await buildApp().inject({ method: 'GET', url: '/api/v1/campaigns/camp-1' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.campaign.id).toBe('camp-1');
    expect(body.campaign.customerLists[0].customerListId).toBe('list-1');
    expect(body.campaign.customerLists[0].customerList.name).toBe('Lead FB Q1');
    expect(body.campaign.projects[0].projectId).toBe('proj-1');
    expect(body.campaign.projects[0].project.name).toBe('Vinhomes Grand Park');
  });

  it('campaign không tồn tại / khác org → 404', async () => {
    prismaMock.campaign.findFirst.mockResolvedValue(null);
    const res = await buildApp().inject({ method: 'GET', url: '/api/v1/campaigns/khong-co' });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toBe('not_found');
    // query phải scope theo org
    expect(prismaMock.campaign.findFirst.mock.calls[0][0].where.orgId).toBe(ORG);
  });
});

// ── PUT /api/v1/campaigns/:id ───────────────────────────────────────────────
describe('PUT /api/v1/campaigns/:id (update)', () => {
  it('partial update — chỉ field có trong body mới được ghi', async () => {
    prismaMock.campaign.findFirst.mockResolvedValue(campaignRow());
    const res = await buildApp().inject({
      method: 'PUT',
      url: '/api/v1/campaigns/camp-1',
      payload: { note: 'ghi chú mới' },
    });
    expect(res.statusCode).toBe(200);

    const data = prismaMock.campaign.update.mock.calls[0][0].data;
    expect(data).toEqual({ note: 'ghi chú mới' });
    expect(data.name).toBeUndefined();
    expect(data.customerListIds).toBeUndefined();
  });

  it('campaign không tồn tại → 404', async () => {
    prismaMock.campaign.findFirst.mockResolvedValue(null);
    const res = await buildApp().inject({
      method: 'PUT', url: '/api/v1/campaigns/khong-co', payload: { note: 'x' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('gửi customerListIds → replace link (delete + create)', async () => {
    prismaMock.campaign.findFirst.mockResolvedValue(campaignRow());
    prismaMock.customerList.findMany.mockResolvedValue([{ id: 'list-2' }]);

    const res = await buildApp().inject({
      method: 'PUT',
      url: '/api/v1/campaigns/camp-1',
      payload: { customerListIds: ['list-2'] },
    });
    expect(res.statusCode).toBe(200);
    expect(prismaMock.campaignCustomerList.deleteMany).toHaveBeenCalledWith({
      where: { campaignId: 'camp-1' },
    });
    expect(prismaMock.campaignCustomerList.createMany).toHaveBeenCalledWith({
      data: [{ campaignId: 'camp-1', customerListId: 'list-2' }],
    });
  });

  it('không gửi customerListIds → giữ nguyên link (không delete)', async () => {
    prismaMock.campaign.findFirst.mockResolvedValue(campaignRow());
    const res = await buildApp().inject({
      method: 'PUT', url: '/api/v1/campaigns/camp-1', payload: { note: 'x' },
    });
    expect(res.statusCode).toBe(200);
    expect(prismaMock.campaignCustomerList.deleteMany).not.toHaveBeenCalled();
    expect(prismaMock.campaignProject.deleteMany).not.toHaveBeenCalled();
  });
});

// ── DELETE /api/v1/campaigns/:id ────────────────────────────────────────────
describe('DELETE /api/v1/campaigns/:id', () => {
  it('campaign không tồn tại → 404', async () => {
    prismaMock.campaign.findFirst.mockResolvedValue(null);
    const res = await buildApp().inject({ method: 'DELETE', url: '/api/v1/campaigns/khong-co' });
    expect(res.statusCode).toBe(404);
    expect(prismaMock.campaign.delete).not.toHaveBeenCalled();
  });

  it('xoá thành công → { deleted: true }', async () => {
    prismaMock.campaign.findFirst.mockResolvedValue(campaignRow());
    const res = await buildApp().inject({ method: 'DELETE', url: '/api/v1/campaigns/camp-1' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ deleted: true });
    expect(prismaMock.campaign.delete).toHaveBeenCalledWith({ where: { id: 'camp-1' } });
  });
});

// ── PATCH /api/v1/campaigns/:id/status ──────────────────────────────────────
describe('PATCH /api/v1/campaigns/:id/status', () => {
  it('status hợp lệ → cập nhật + log', async () => {
    prismaMock.campaign.findFirst.mockResolvedValue(campaignRow({ status: 'DRAFT' }));
    prismaMock.campaign.update.mockResolvedValue(campaignRow({ status: 'RUNNING' }));

    const res = await buildApp().inject({
      method: 'PATCH', url: '/api/v1/campaigns/camp-1/status', payload: { status: 'RUNNING' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).campaign.status).toBe('RUNNING');
    expect(prismaMock.campaign.update).toHaveBeenCalledWith({
      where: { id: 'camp-1' },
      data: { status: 'RUNNING' },
    });
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'campaign_status_change' }),
    );
  });

  it('status không nằm trong enum → 400 + allowed', async () => {
    prismaMock.campaign.findFirst.mockResolvedValue(campaignRow());
    const res = await buildApp().inject({
      method: 'PATCH', url: '/api/v1/campaigns/camp-1/status', payload: { status: 'KHONG_HOP_LE' },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('invalid_status');
    expect(body.allowed).toEqual(['DRAFT', 'SCHEDULED', 'RUNNING', 'PAUSED', 'COMPLETED']);
    expect(prismaMock.campaign.update).not.toHaveBeenCalled();
  });

  it('thiếu status → 400 status_required', async () => {
    const res = await buildApp().inject({
      method: 'PATCH', url: '/api/v1/campaigns/camp-1/status', payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('status_required');
  });

  it('campaign không tồn tại → 404', async () => {
    prismaMock.campaign.findFirst.mockResolvedValue(null);
    const res = await buildApp().inject({
      method: 'PATCH', url: '/api/v1/campaigns/khong-co/status', payload: { status: 'RUNNING' },
    });
    expect(res.statusCode).toBe(404);
  });
});

// ── GET /api/v1/campaigns/:id/stats ─────────────────────────────────────────
describe('GET /api/v1/campaigns/:id/stats', () => {
  it('campaign không tồn tại → 404', async () => {
    prismaMock.campaign.findFirst.mockResolvedValue(null);
    const res = await buildApp().inject({ method: 'GET', url: '/api/v1/campaigns/khong-co/stats' });
    expect(res.statusCode).toBe(404);
  });

  it('không gắn list nào → toàn bộ counter bằng 0', async () => {
    prismaMock.campaign.findFirst.mockResolvedValue(campaignRow());
    prismaMock.campaignCustomerList.findMany.mockResolvedValue([]);

    const res = await buildApp().inject({ method: 'GET', url: '/api/v1/campaigns/camp-1/stats' });
    expect(res.statusCode).toBe(200);
    const stats = JSON.parse(res.body);
    expect(stats.totalContacts).toBe(0);
    expect(stats.friendRequestsSent).toBe(0);
    expect(stats.repliedContacts).toBe(0);
    expect(stats.conversionRate).toBe(0);
    expect(stats.customerListCount).toBe(0);
    expect(stats.contacts).toEqual([]);
  });

  it('tính counter từ dữ liệu thật + conversionRate = replied/total', async () => {
    prismaMock.campaign.findFirst.mockResolvedValue(campaignRow());
    prismaMock.campaignCustomerList.findMany.mockResolvedValue([{ customerListId: 'list-1' }]);
    prismaMock.campaignProject.count.mockResolvedValue(2);
    prismaMock.customerListEntry.findMany.mockResolvedValue([
      { contactId: 'c-1' },
      { contactId: 'c-2' },
    ]);
    prismaMock.friendshipAttempt.count.mockResolvedValue(5);
    prismaMock.contact.count.mockResolvedValue(1);

    const res = await buildApp().inject({ method: 'GET', url: '/api/v1/campaigns/camp-1/stats' });
    expect(res.statusCode).toBe(200);
    const stats = JSON.parse(res.body);
    expect(stats.totalContacts).toBe(2);
    expect(stats.friendRequestsSent).toBe(5);
    expect(stats.repliedContacts).toBe(1);
    expect(stats.conversionRate).toBe(0.5);
    expect(stats.customerListCount).toBe(1);
    expect(stats.projectCount).toBe(2);
  });

  it('campaign có startAt/endAt → lọc theo khoảng thời gian', async () => {
    const start = new Date('2026-01-01T00:00:00Z');
    const end = new Date('2026-01-31T23:59:59Z');
    prismaMock.campaign.findFirst.mockResolvedValue(campaignRow({ startAt: start, endAt: end }));
    prismaMock.campaignCustomerList.findMany.mockResolvedValue([{ customerListId: 'list-1' }]);
    prismaMock.customerListEntry.findMany.mockResolvedValue([{ contactId: 'c-1' }]);
    prismaMock.friendshipAttempt.count.mockResolvedValue(1);
    prismaMock.contact.count.mockResolvedValue(0);

    await buildApp().inject({ method: 'GET', url: '/api/v1/campaigns/camp-1/stats' });

    const attemptWhere = prismaMock.friendshipAttempt.count.mock.calls[0][0].where;
    expect(attemptWhere.sentAt).toEqual({ not: null, gte: start, lte: end });
    expect(attemptWhere.orgId).toBe(ORG);

    const contactWhere = prismaMock.contact.count.mock.calls[0][0].where;
    expect(contactWhere.lastInboundAt).toEqual({ not: null, gte: start, lte: end });
  });

  it('entry không có contactId bị loại khỏi tập contact', async () => {
    prismaMock.campaign.findFirst.mockResolvedValue(campaignRow());
    prismaMock.campaignCustomerList.findMany.mockResolvedValue([{ customerListId: 'list-1' }]);
    prismaMock.customerListEntry.findMany.mockResolvedValue([
      { contactId: 'c-1' },
      { contactId: null },
    ]);
    prismaMock.friendshipAttempt.count.mockResolvedValue(0);
    prismaMock.contact.count.mockResolvedValue(0);

    await buildApp().inject({ method: 'GET', url: '/api/v1/campaigns/camp-1/stats' });

    const attemptWhere = prismaMock.friendshipAttempt.count.mock.calls[0][0].where;
    expect(attemptWhere.contactId.in).toEqual(['c-1']);
  });

  it('trả contacts rows kèm friendStatus / replyStatus', async () => {
    const start = new Date('2026-01-01T00:00:00Z');
    const end = new Date('2026-01-31T23:59:59Z');
    prismaMock.campaign.findFirst.mockResolvedValue(campaignRow({ startAt: start, endAt: end }));
    prismaMock.campaignCustomerList.findMany.mockResolvedValue([{ customerListId: 'list-1' }]);
    prismaMock.customerListEntry.findMany.mockResolvedValue([{ contactId: 'c-1' }, { contactId: 'c-2' }]);
    prismaMock.contact.count.mockResolvedValue(1);
    prismaMock.contact.findMany.mockResolvedValue([
      {
        id: 'c-1',
        fullName: 'Nguyễn A',
        crmName: null,
        phone: '0901234567',
        customerCode: 'KH000001',
        source: 'facebook',
        lastInboundAt: new Date('2026-01-15T00:00:00Z'),
      },
      {
        id: 'c-2',
        fullName: null,
        crmName: 'Khách B',
        phone: '0907654321',
        customerCode: null,
        source: null,
        lastInboundAt: null,
      },
    ]);
    // Attempt mới nhất của c-1 = accepted, của c-2 = sent
    prismaMock.friendshipAttempt.findMany.mockResolvedValue([
      { contactId: 'c-2', state: 'sent' },
      { contactId: 'c-1', state: 'accepted' },
    ]);

    const res = await buildApp().inject({ method: 'GET', url: '/api/v1/campaigns/camp-1/stats' });
    expect(res.statusCode).toBe(200);
    const { contacts } = JSON.parse(res.body);
    expect(contacts).toHaveLength(2);

    const c1 = contacts.find((c: any) => c.contactId === 'c-1');
    expect(c1.name).toBe('Nguyễn A');
    expect(c1.customerCode).toBe('KH000001');
    expect(c1.friendStatus).toBe('accepted');
    expect(c1.replyStatus).toBe('replied');
    expect(c1.source).toBe('facebook');

    const c2 = contacts.find((c: any) => c.contactId === 'c-2');
    expect(c2.name).toBe('Khách B');
    expect(c2.friendStatus).toBe('sent');
    expect(c2.replyStatus).toBe('no_reply');
  });

  it('lastInboundAt ngoài khoảng thời gian → replyStatus = no_reply', async () => {
    const start = new Date('2026-01-01T00:00:00Z');
    const end = new Date('2026-01-31T23:59:59Z');
    prismaMock.campaign.findFirst.mockResolvedValue(campaignRow({ startAt: start, endAt: end }));
    prismaMock.campaignCustomerList.findMany.mockResolvedValue([{ customerListId: 'list-1' }]);
    prismaMock.customerListEntry.findMany.mockResolvedValue([{ contactId: 'c-1' }]);
    prismaMock.contact.count.mockResolvedValue(0);
    prismaMock.contact.findMany.mockResolvedValue([
      {
        id: 'c-1',
        fullName: 'A',
        crmName: null,
        phone: '0901',
        customerCode: null,
        source: null,
        lastInboundAt: new Date('2025-12-01T00:00:00Z'), // ngoài window
      },
    ]);

    const res = await buildApp().inject({ method: 'GET', url: '/api/v1/campaigns/camp-1/stats' });
    const { contacts } = JSON.parse(res.body);
    expect(contacts[0].replyStatus).toBe('no_reply');
    expect(contacts[0].friendStatus).toBe('none');
  });
});

// ── Regression: 2 endpoint CE cũ còn nguyên ─────────────────────────────────
describe('Regression — endpoint CE cũ còn nguyên', () => {
  function buildLegacyApp(): FastifyInstance {
    const app = Fastify({ logger: false });
    app.register(campaignRoutes);
    return app;
  }

  it('POST /api/v1/campaigns/random-friend-request vẫn tồn tại', async () => {
    const res = await buildLegacyApp().inject({
      method: 'POST',
      url: '/api/v1/campaigns/random-friend-request',
      payload: { zaloAccountId: 'acc-1' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('GET /api/v1/campaigns/contacts/:contactId/attempts vẫn tồn tại', async () => {
    prismaMock.contact.findFirst.mockResolvedValue({ id: 'c-1' });
    prismaMock.friendshipAttempt.groupBy.mockResolvedValue([]);
    prismaMock.friendshipAttempt.findMany.mockResolvedValue([]);

    const res = await buildLegacyApp().inject({
      method: 'GET',
      url: '/api/v1/campaigns/contacts/c-1/attempts',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('counts');
    expect(body).toHaveProperty('attempts');
  });
});
