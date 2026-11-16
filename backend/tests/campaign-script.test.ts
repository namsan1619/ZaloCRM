// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyễn Tiến Lộc
/**
 * campaign-script.test.ts — Tests cho CampaignScript (kịch bản tin nhắn chiến dịch).
 *
 * Bao phủ:
 *  - GET /api/v1/campaign-scripts: lazy-seed 3 kịch bản mặc định (1/kind) khi
 *    org chưa có; không seed lại khi đã đủ; chỉ seed kind còn thiếu; lọc
 *    kind + activeOnly; sort kind asc + createdAt asc; kind sai → 400.
 *  - POST /api/v1/campaign-scripts: tạo OK (mediaUrls default []), thiếu
 *    name/kind/content → 400, kind sai → 400, trùng tên → 409, role member → 403.
 *  - PUT /api/v1/campaign-scripts/:id: đổi content OK, không tồn tại → 404,
 *    trùng tên khi đổi name → 409.
 *  - DELETE /api/v1/campaign-scripts/:id: xóa OK, không tồn tại → 404,
 *    409 IN_USE khi run dùng greetingScriptId hoặc careScriptIds chứa id.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { mockUser } from './test-helpers.js';

// ── Hoisted mock state ────────────────────────────────────────────────────────
const prismaMock = {
  campaignScript: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  campaignRun: {
    findFirst: vi.fn(),
  },
};
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

const { registerCampaignScriptRoutes } = await import('../src/modules/campaign/campaign-script-routes.js');
const { DEFAULT_CAMPAIGN_SCRIPTS } = await import('../src/modules/campaign/campaign-script-service.js');
const { logActivity } = await import('../src/modules/activity/activity-logger.js');

function buildApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  app.register(registerCampaignScriptRoutes);
  return app;
}

// ── Fixtures ─────────────────────────────────────────────────────────────────
const BASE_ROW = {
  orgId: 'org-1',
  mediaUrls: [],
  isActive: true,
  createdById: null,
  createdAt: new Date('2026-11-16T00:00:00.000Z'),
  updatedAt: new Date('2026-11-16T00:00:00.000Z'),
};

function scriptRow(overrides: Record<string, unknown> = {}) {
  return { id: 'scr-fr', name: 'Mời kết bạn', kind: 'friend_request', content: 'Xin chao', ...BASE_ROW, ...overrides };
}

const SCRIPTS = [
  scriptRow({ id: 'scr-fr', kind: 'friend_request', name: 'Mời KB', createdAt: new Date('2026-11-16T01:00:00.000Z') }),
  scriptRow({ id: 'scr-greeting', kind: 'greeting', name: 'Lời chào', createdAt: new Date('2026-11-16T01:10:00.000Z') }),
  scriptRow({ id: 'scr-care', kind: 'care', name: 'Chăm sóc', createdAt: new Date('2026-11-16T01:20:00.000Z') }),
];

beforeEach(() => {
  vi.clearAllMocks();
  currentRole = 'admin';
});

// ── GET /api/v1/campaign-scripts ──────────────────────────────────────────────
describe('GET /api/v1/campaign-scripts', () => {
  const URL = '/api/v1/campaign-scripts';

  it('org mới: lazy-seed 3 kịch bản mặc định (1/kind) trước khi trả danh sách', async () => {
    prismaMock.campaignScript.findMany
      .mockResolvedValueOnce([]) // seed: org chưa có kịch bản nào
      .mockResolvedValueOnce(SCRIPTS); // list: trả 3 kịch bản
    prismaMock.campaignScript.create.mockImplementation(async ({ data }: any) => ({
      id: 'scr-' + data.kind,
      ...data,
      ...BASE_ROW,
    }));

    const res = await buildApp().inject({ method: 'GET', url: URL });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.scripts).toHaveLength(3);
    // Seed đúng 3 kịch bản — 1 cho mỗi kind, theo nội dung mặc định.
    expect(prismaMock.campaignScript.create).toHaveBeenCalledTimes(3);
    const createdKinds = prismaMock.campaignScript.create.mock.calls.map((c: any) => c[0].data.kind).sort();
    expect(createdKinds).toEqual(['care', 'friend_request', 'greeting']);
    expect(createdKinds).toEqual(DEFAULT_CAMPAIGN_SCRIPTS.map((d) => d.kind).sort());
    // Seed scoped theo org
    const seedWhere = prismaMock.campaignScript.findMany.mock.calls[0][0].where;
    expect(seedWhere).toEqual({ orgId: 'org-1' });
  });

  it('org đã có đủ kind: không seed lại, chỉ trả danh sách', async () => {
    prismaMock.campaignScript.findMany
      .mockResolvedValueOnce([{ kind: 'friend_request' }, { kind: 'greeting' }, { kind: 'care' }])
      .mockResolvedValueOnce(SCRIPTS);

    const res = await buildApp().inject({ method: 'GET', url: URL });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).scripts).toHaveLength(3);
    expect(prismaMock.campaignScript.create).not.toHaveBeenCalled();
  });

  it('org có một phần: chỉ seed kind còn thiếu', async () => {
    prismaMock.campaignScript.findMany
      .mockResolvedValueOnce([{ kind: 'friend_request' }]) // đã có kịch bản mời KB
      .mockResolvedValueOnce(SCRIPTS);
    prismaMock.campaignScript.create.mockImplementation(async ({ data }: any) => ({
      id: 'scr-' + data.kind,
      ...data,
      ...BASE_ROW,
    }));

    const res = await buildApp().inject({ method: 'GET', url: URL });
    expect(res.statusCode).toBe(200);
    const createdKinds = prismaMock.campaignScript.create.mock.calls.map((c: any) => c[0].data.kind).sort();
    expect(createdKinds).toEqual(['care', 'greeting']);
  });

  it('lọc theo kind + activeOnly, sort kind asc + createdAt asc', async () => {
    prismaMock.campaignScript.findMany
      .mockResolvedValueOnce([{ kind: 'friend_request' }, { kind: 'greeting' }, { kind: 'care' }])
      .mockResolvedValueOnce([SCRIPTS[0]]);

    const res = await buildApp().inject({ method: 'GET', url: `${URL}?kind=friend_request&activeOnly=1` });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.scripts).toHaveLength(1);
    expect(body.scripts[0].id).toBe('scr-fr');
    const where = prismaMock.campaignScript.findMany.mock.calls[1][0].where;
    expect(where).toMatchObject({ orgId: 'org-1', kind: 'friend_request', isActive: true });
    const orderBy = prismaMock.campaignScript.findMany.mock.calls[1][0].orderBy;
    expect(orderBy).toEqual([{ kind: 'asc' }, { createdAt: 'asc' }]);
  });

  it('trả mediaUrls như đã lưu (dạng array)', async () => {
    prismaMock.campaignScript.findMany
      .mockResolvedValueOnce([{ kind: 'care' }])
      .mockResolvedValueOnce([
        scriptRow({
          id: 'scr-care',
          kind: 'care',
          mediaUrls: ['https://example.com/bang-hang.pdf'],
        }),
      ]);

    const res = await buildApp().inject({ method: 'GET', url: `${URL}?kind=care` });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).scripts[0].mediaUrls).toEqual(['https://example.com/bang-hang.pdf']);
  });

  it('kind không hợp lệ → 400 INVALID_KIND', async () => {
    prismaMock.campaignScript.findMany.mockResolvedValue([]);
    prismaMock.campaignScript.create.mockResolvedValue({});

    const res = await buildApp().inject({ method: 'GET', url: `${URL}?kind=khong-hop-le` });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe('INVALID_KIND');
  });
});

// ── POST /api/v1/campaign-scripts ─────────────────────────────────────────────
describe('POST /api/v1/campaign-scripts', () => {
  const URL = '/api/v1/campaign-scripts';

  it('tạo kịch bản hợp lệ, mediaUrls mặc định []', async () => {
    prismaMock.campaignScript.findFirst.mockResolvedValue(null); // không trùng tên
    prismaMock.campaignScript.create.mockImplementation(async ({ data }: any) => ({
      id: 'scr-new',
      ...data,
      ...BASE_ROW,
    }));

    const res = await buildApp().inject({
      method: 'POST',
      url: URL,
      payload: { name: 'Mời kết bạn 02', kind: 'friend_request', content: 'Xin chao anh/chi!' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.script.name).toBe('Mời kết bạn 02');
    expect(body.script.kind).toBe('friend_request');
    expect(body.script.content).toBe('Xin chao anh/chi!');
    expect(body.script.isActive).toBe(true);
    expect(body.script.mediaUrls).toEqual([]);
    // payload xuống DB: mediaUrls [] + gán createdById = user hiện tại
    const createArgs = prismaMock.campaignScript.create.mock.calls[0][0];
    expect(createArgs.data.orgId).toBe('org-1');
    expect(createArgs.data.mediaUrls).toEqual([]);
    expect(createArgs.data.isActive).toBe(true);
    expect(createArgs.data.createdById).toBe('user-1');
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'campaign_script_created',
        entityType: 'campaignScript',
        entityId: 'scr-new',
      }),
    );
  });

  it('thiếu name / kind / content → 400, không ghi DB', async () => {
    prismaMock.campaignScript.findFirst.mockResolvedValue(null);
    const badPayloads: Array<Record<string, unknown>> = [
      {},
      { kind: 'greeting', content: 'x' },
      { name: 'x', content: 'x' },
      { name: 'x', kind: 'greeting' },
      { name: 'x', kind: 'greeting', content: '   ' },
    ];
    for (const payload of badPayloads) {
      const res = await buildApp().inject({ method: 'POST', url: URL, payload });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).code).toBeDefined();
    }
    expect(prismaMock.campaignScript.create).not.toHaveBeenCalled();
  });

  it('kind không hợp lệ → 400 INVALID_KIND', async () => {
    const res = await buildApp().inject({
      method: 'POST',
      url: URL,
      payload: { name: 'x', kind: 'spam', content: 'x' },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe('INVALID_KIND');
  });

  it('trùng tên trong org → 409 DUPLICATE_NAME', async () => {
    prismaMock.campaignScript.findFirst.mockResolvedValue({ id: 'other' });

    const res = await buildApp().inject({
      method: 'POST',
      url: URL,
      payload: { name: 'Mời kết bạn', kind: 'greeting', content: 'x' },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe('DUPLICATE_NAME');
    // khóa tìm trùng scoped theo orgId + name
    const where = prismaMock.campaignScript.findFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({ orgId: 'org-1', name: 'Mời kết bạn' });
    expect(prismaMock.campaignScript.create).not.toHaveBeenCalled();
  });

  it('role member → 403 RBAC_FORBIDDEN', async () => {
    currentRole = 'member';
    const res = await buildApp().inject({
      method: 'POST',
      url: URL,
      payload: { name: 'x', kind: 'care', content: 'x' },
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).code).toBe('RBAC_FORBIDDEN');
    expect(prismaMock.campaignScript.create).not.toHaveBeenCalled();
  });
});

// ── PUT /api/v1/campaign-scripts/:id ──────────────────────────────────────────
describe('PUT /api/v1/campaign-scripts/:id', () => {
  const URL = (id: string) => `/api/v1/campaign-scripts/${id}`;

  it('đổi content + isActive, giữ các field còn lại', async () => {
    prismaMock.campaignScript.findFirst.mockResolvedValue({ id: 'scr-1', name: 'Mời KB' });
    prismaMock.campaignScript.update.mockResolvedValue(
      scriptRow({ id: 'scr-1', name: 'Mời KB', content: 'Nội dung mới', isActive: false }),
    );

    const res = await buildApp().inject({
      method: 'PUT',
      url: URL('scr-1'),
      payload: { content: 'Nội dung mới', isActive: false },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.script.content).toBe('Nội dung mới');
    expect(body.script.isActive).toBe(false);
    // chỉ set field được truyền vào — update gọi đúng payload
    expect(prismaMock.campaignScript.update).toHaveBeenCalledWith({
      where: { id: 'scr-1' },
      data: { content: 'Nội dung mới', isActive: false },
    });
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'campaign_script_updated', entityId: 'scr-1' }),
    );
  });

  it('không tồn tại → 404 SCRIPT_NOT_FOUND', async () => {
    prismaMock.campaignScript.findFirst.mockResolvedValue(null);

    const res = await buildApp().inject({
      method: 'PUT',
      url: URL('scr-x'),
      payload: { content: 'x' },
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).code).toBe('SCRIPT_NOT_FOUND');
    expect(prismaMock.campaignScript.update).not.toHaveBeenCalled();
  });

  it('đổi tên trùng với kịch bản khác của org → 409 DUPLICATE_NAME', async () => {
    prismaMock.campaignScript.findFirst
      .mockResolvedValueOnce({ id: 'scr-1', name: 'Cũ' }) // kịch bản hiện tại
      .mockResolvedValueOnce({ id: 'scr-2' }); // kịch bản khác đã chiếm tên
    prismaMock.campaignScript.update.mockResolvedValue({});

    const res = await buildApp().inject({
      method: 'PUT',
      url: URL('scr-1'),
      payload: { name: 'Mới' },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe('DUPLICATE_NAME');
    // tìm trùng loại trừ chính nó, trong org
    const dupWhere = prismaMock.campaignScript.findFirst.mock.calls[1][0].where;
    expect(dupWhere).toMatchObject({ orgId: 'org-1', name: 'Mới', id: { not: 'scr-1' } });
    expect(prismaMock.campaignScript.update).not.toHaveBeenCalled();
  });
});

// ── DELETE /api/v1/campaign-scripts/:id ───────────────────────────────────────
describe('DELETE /api/v1/campaign-scripts/:id', () => {
  const URL = (id: string) => `/api/v1/campaign-scripts/${id}`;

  it('xóa OK khi không chiến dịch nào dùng script', async () => {
    prismaMock.campaignScript.findFirst.mockResolvedValue({ id: 'scr-1' });
    prismaMock.campaignRun.findFirst.mockResolvedValue(null);
    prismaMock.campaignScript.delete.mockResolvedValue({ id: 'scr-1' });

    const res = await buildApp().inject({ method: 'DELETE', url: URL('scr-1') });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ deleted: true });
    // lookup scoped theo org
    const where = prismaMock.campaignScript.findFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({ id: 'scr-1', orgId: 'org-1' });
    expect(prismaMock.campaignScript.delete).toHaveBeenCalledWith({ where: { id: 'scr-1' } });
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'campaign_script_deleted', entityId: 'scr-1' }),
    );
  });

  it('không tồn tại → 404 SCRIPT_NOT_FOUND', async () => {
    prismaMock.campaignScript.findFirst.mockResolvedValue(null);

    const res = await buildApp().inject({ method: 'DELETE', url: URL('scr-x') });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).code).toBe('SCRIPT_NOT_FOUND');
    expect(prismaMock.campaignScript.delete).not.toHaveBeenCalled();
  });

  it('409 IN_USE khi run dùng greetingScriptId', async () => {
    prismaMock.campaignScript.findFirst.mockResolvedValue({ id: 'scr-1' });
    prismaMock.campaignRun.findFirst.mockResolvedValue({ id: 'run-1' });

    const res = await buildApp().inject({ method: 'DELETE', url: URL('scr-1') });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe('IN_USE');
    expect(prismaMock.campaignScript.delete).not.toHaveBeenCalled();
    // query run scoped org, check cả greetingScriptId lẫn careScriptIds
    const runWhere = prismaMock.campaignRun.findFirst.mock.calls[0][0].where;
    expect(runWhere.orgId).toBe('org-1');
    expect(runWhere.OR).toContainEqual({ greetingScriptId: 'scr-1' });
  });

  it('409 IN_USE khi careScriptIds chứa id', async () => {
    prismaMock.campaignScript.findFirst.mockResolvedValue({ id: 'scr-1' });
    prismaMock.campaignRun.findFirst.mockResolvedValue({ id: 'run-9' });

    const res = await buildApp().inject({ method: 'DELETE', url: URL('scr-1') });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe('IN_USE');
    const runWhere = prismaMock.campaignRun.findFirst.mock.calls[0][0].where;
    expect(runWhere.orgId).toBe('org-1');
    expect(runWhere.OR).toContainEqual({ careScriptIds: { array_contains: ['scr-1'] } });
    expect(prismaMock.campaignScript.delete).not.toHaveBeenCalled();
  });
});