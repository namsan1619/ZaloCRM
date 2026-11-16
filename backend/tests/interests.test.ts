// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyen Tien Loc
/**
 * interests.test.ts — Tests cho ContactInterest + RatingHistory (Agent C).
 *
 * Bao phủ:
 *  - POST /contacts/:contactId/interests: thiếu cả property/project → 400;
 *    tạo OK kèm property (include project) + interestCode mặc định QUAN_TAM;
 *    upsert khi đã quan tâm căn đó (trả interest hiện có, không create mới);
 *    contact không tồn tại → 404; role member → 403.
 *  - PUT /interests/:id: đổi interestCode OK; không tồn tại → 404.
 *  - DELETE /interests/:id: OK → { deleted: true }; không tồn tại → 404.
 *  - GET /contacts/:contactId/interests/suggestions: KH có interest → tìm cùng
 *    propertyTypeCode + AVAILABLE, loại trừ căn đã quan tâm; KH chưa có interest
 *    → căn AVAILABLE mới nhất.
 *  - GET /contacts/:contactId/rating-history: trả changedByName (join User.fullName).
 *
 * TUYỆT ĐỐI không gọi Zalo/DB thật — mock prisma-client toàn bộ.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { mockUser } from './test-helpers.js';

// ── Hoisted mock state ────────────────────────────────────────────────────────
const prismaMock = {
  contact: {
    findFirst: vi.fn(),
  },
  contactInterest: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  property: {
    findMany: vi.fn(),
  },
  ratingHistory: {
    findMany: vi.fn(),
  },
  user: {
    findMany: vi.fn(),
  },
};
let currentRole = 'admin';

vi.mock('../src/shared/database/prisma-client.js', () => ({
  prisma: prismaMock,
  tenantTransaction: async (fn: (tx: typeof prismaMock) => Promise<unknown>) => fn(prismaMock),
}));
vi.mock('../src/shared/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/modules/auth/auth-middleware.js', () => ({
  authMiddleware: async (req: any) => { req.user = mockUser({ role: currentRole }); },
}));
vi.mock('../src/modules/activity/activity-logger.js', () => ({ logActivity: vi.fn() }));

const { registerInterestRoutes } = await import('../src/modules/interests/interest-routes.js');
const { registerRatingHistoryRoutes } = await import('../src/modules/contacts/rating-history-routes.js');
const { logActivity } = await import('../src/modules/activity/activity-logger.js');

function buildApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  app.register(registerInterestRoutes);
  app.register(registerRatingHistoryRoutes);
  return app;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────
const CONTACT = { id: 'c1', orgId: 'org-1' };

const PROPERTY = {
  id: 'p1',
  unitCode: 'A1-1203',
  propertyTypeCode: 'CAN_HO',
  statusCode: 'AVAILABLE',
  zoneName: null,
  blockName: 'A',
  category: 'HIGH_RISE',
  transactionType: 'SALE',
  priceVnd: 1200000000,
  priceRentVnd: null,
  usableAreaM2: 90,
  bedrooms: 3,
  bathrooms: 2,
  project: { id: 'proj-1', name: 'Vinhomes Ocean Park' },
};

const INTEREST_ROW = {
  id: 'int-1',
  orgId: 'org-1',
  contactId: 'c1',
  propertyId: 'p1',
  projectId: null,
  interestCode: 'QUAN_TAM',
  note: null,
  source: 'manual',
  createdAt: new Date('2026-11-16T00:00:00.000Z'),
  updatedAt: new Date('2026-11-16T00:00:00.000Z'),
  property: PROPERTY,
  project: null,
};

function interestWithout(overrides: Partial<typeof INTEREST_ROW>): typeof INTEREST_ROW {
  return { ...INTEREST_ROW, ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  currentRole = 'admin';
});

// ── POST /api/v1/contacts/:contactId/interests ────────────────────────────────
describe('POST /api/v1/contacts/:contactId/interests', () => {
  const URL = '/api/v1/contacts/c1/interests';

  it('thiếu cả propertyId lẫn projectId → 400 PROPERTY_OR_PROJECT_REQUIRED', async () => {
    const res = await buildApp().inject({ method: 'POST', url: URL, payload: {} });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.code).toBe('PROPERTY_OR_PROJECT_REQUIRED');
    expect(prismaMock.contactInterest.create).not.toHaveBeenCalled();
  });

  it('tạo interest mới kèm property (include project), interestCode mặc định QUAN_TAM', async () => {
    prismaMock.contact.findFirst.mockResolvedValue(CONTACT);
    prismaMock.contactInterest.findFirst.mockResolvedValue(null);
    prismaMock.contactInterest.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      interestWithout({ ...data } as Partial<typeof INTEREST_ROW>),
    );

    const res = await buildApp().inject({
      method: 'POST',
      url: URL,
      payload: { propertyId: 'p1', note: 'Khách thích tầng cao', source: 'manual' },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.interest.id).toBe('int-1');
    expect(body.interest.interestCode).toBe('QUAN_TAM');
    expect(body.interest.note).toBe('Khách thích tầng cao');
    // property kèm project
    expect(body.interest.property.id).toBe('p1');
    expect(body.interest.property.project.name).toBe('Vinhomes Ocean Park');
    // price BigInt-safe
    expect(body.interest.property.priceVnd).toBe('1200000000');

    const createArgs = prismaMock.contactInterest.create.mock.calls[0][0];
    expect(createArgs.data.orgId).toBe('org-1');
    expect(createArgs.data.contactId).toBe('c1');
    expect(createArgs.data.propertyId).toBe('p1');
    expect(createArgs.data.interestCode).toBe('QUAN_TAM');
    expect(createArgs.data.createdById).toBe('user-1');

    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'interest_created', entityId: 'int-1' }),
    );
  });

  it('upsert — đã quan tâm căn (contactId+propertyId) → trả interest hiện có, không create', async () => {
    prismaMock.contact.findFirst.mockResolvedValue(CONTACT);
    prismaMock.contactInterest.findFirst.mockResolvedValue(
      interestWithout({ note: 'note cũ', updatedAt: new Date('2026-11-15T00:00:00.000Z') }),
    );
    prismaMock.contactInterest.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      interestWithout({ ...data } as Partial<typeof INTEREST_ROW>),
    );

    const res = await buildApp().inject({
      method: 'POST',
      url: URL,
      payload: { propertyId: 'p1', note: 'note mới', interestCode: 'RAT_QUAN_TAM' },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.interest.id).toBe('int-1');
    expect(body.interest.note).toBe('note mới');
    expect(prismaMock.contactInterest.create).not.toHaveBeenCalled();

    const upsertWhere = prismaMock.contactInterest.findFirst.mock.calls[0][0].where;
    expect(upsertWhere.orgId).toBe('org-1');
    expect(upsertWhere.contactId).toBe('c1');
    expect(upsertWhere.propertyId).toBe('p1');

    const updateArgs = prismaMock.contactInterest.update.mock.calls[0][0];
    expect(updateArgs.data.note).toBe('note mới');
    expect(updateArgs.data.interestCode).toBe('RAT_QUAN_TAM');

    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'interest_updated' }),
    );
  });

  it('contact không tồn tại trong org → 404 CONTACT_NOT_FOUND', async () => {
    prismaMock.contact.findFirst.mockResolvedValue(null);
    const res = await buildApp().inject({
      method: 'POST',
      url: URL,
      payload: { propertyId: 'p1' },
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).code).toBe('CONTACT_NOT_FOUND');
  });

  it('role member → vẫn tạo được (sale thêm sản phẩm quan tâm trong tab CRM chat)', async () => {
    currentRole = 'member';
    prismaMock.contact.findFirst.mockResolvedValue({ id: 'c1' });
    prismaMock.contactInterest.findFirst.mockResolvedValue(null);
    prismaMock.contactInterest.create.mockResolvedValue(
      interestWithout({ interestCode: 'QUAN_TAM' }),
    );
    const res = await buildApp().inject({
      method: 'POST',
      url: URL,
      payload: { propertyId: 'p1' },
    });
    expect(res.statusCode).toBe(201);
  });
});

// ── PUT /api/v1/interests/:id ─────────────────────────────────────────────────
describe('PUT /api/v1/interests/:id', () => {
  const URL = '/api/v1/interests/int-1';

  it('đổi interestCode → 200, trả interest đã cập nhật', async () => {
    prismaMock.contactInterest.findFirst.mockResolvedValue({ id: 'int-1', contactId: 'c1' });
    prismaMock.contactInterest.update.mockResolvedValue(
      interestWithout({ interestCode: 'RAT_QUAN_TAM' }),
    );

    const res = await buildApp().inject({
      method: 'PUT',
      url: URL,
      payload: { interestCode: 'RAT_QUAN_TAM' },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.interest.interestCode).toBe('RAT_QUAN_TAM');
    const updateArgs = prismaMock.contactInterest.update.mock.calls[0][0];
    expect(updateArgs.where.id).toBe('int-1');
    expect(updateArgs.data.interestCode).toBe('RAT_QUAN_TAM');
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'interest_updated', entityId: 'int-1' }),
    );
  });

  it('interest không tồn tại → 404 INTEREST_NOT_FOUND', async () => {
    prismaMock.contactInterest.findFirst.mockResolvedValue(null);
    const res = await buildApp().inject({
      method: 'PUT',
      url: '/api/v1/interests/unknown',
      payload: { interestCode: 'RAT_QUAN_TAM' },
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).code).toBe('INTEREST_NOT_FOUND');
  });
});

// ── DELETE /api/v1/interests/:id ──────────────────────────────────────────────
describe('DELETE /api/v1/interests/:id', () => {
  const URL = '/api/v1/interests/int-1';

  it('xóa OK → { deleted: true }', async () => {
    prismaMock.contactInterest.findFirst.mockResolvedValue({ id: 'int-1', contactId: 'c1' });
    prismaMock.contactInterest.delete.mockResolvedValue({ id: 'int-1' });

    const res = await buildApp().inject({ method: 'DELETE', url: URL });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ deleted: true });
    expect(prismaMock.contactInterest.delete).toHaveBeenCalledWith({ where: { id: 'int-1' } });
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'interest_deleted', entityId: 'int-1' }),
    );
  });

  it('interest không tồn tại → 404 INTEREST_NOT_FOUND', async () => {
    prismaMock.contactInterest.findFirst.mockResolvedValue(null);
    const res = await buildApp().inject({ method: 'DELETE', url: URL });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).code).toBe('INTEREST_NOT_FOUND');
  });
});

// ── GET /api/v1/contacts/:contactId/interests ─────────────────────────────────
describe('GET /api/v1/contacts/:contactId/interests', () => {
  it('trả danh sách interest kèm property + project, mới nhất trước', async () => {
    prismaMock.contact.findFirst.mockResolvedValue(CONTACT);
    prismaMock.contactInterest.findMany.mockResolvedValue([
      interestWithout({ id: 'int-2' }),
      interestWithout({ id: 'int-1' }),
    ]);

    const res = await buildApp().inject({ method: 'GET', url: '/api/v1/contacts/c1/interests' });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.interests).toHaveLength(2);
    expect(body.interests[0].id).toBe('int-2');
    expect(body.interests[0].property.project.name).toBe('Vinhomes Ocean Park');
    const findArgs = prismaMock.contactInterest.findMany.mock.calls[0][0];
    expect(findArgs.where).toEqual({ orgId: 'org-1', contactId: 'c1' });
    expect(findArgs.orderBy).toEqual({ createdAt: 'desc' });
  });

  it('contact không tồn tại → 404', async () => {
    prismaMock.contact.findFirst.mockResolvedValue(null);
    const res = await buildApp().inject({ method: 'GET', url: '/api/v1/contacts/nope/interests' });
    expect(res.statusCode).toBe(404);
  });
});

// ── GET /api/v1/contacts/:contactId/interests/suggestions ─────────────────────
describe('GET /api/v1/contacts/:contactId/interests/suggestions', () => {
  const URL = '/api/v1/contacts/c1/interests/suggestions';

  it('KH có interest → tìm cùng propertyTypeCode + AVAILABLE, loại trừ căn đã quan tâm', async () => {
    prismaMock.contact.findFirst.mockResolvedValue(CONTACT);
    prismaMock.contactInterest.findMany.mockResolvedValue([
      { propertyId: 'p1', property: { propertyTypeCode: 'CAN_HO' } },
      { propertyId: null, property: null },
    ]);
    prismaMock.property.findMany.mockResolvedValue([
      { ...PROPERTY, id: 'p2', unitCode: 'B2-1801', priceVnd: 1500000000 },
    ]);

    const res = await buildApp().inject({ method: 'GET', url: URL });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.suggestions).toHaveLength(1);
    expect(body.suggestions[0].id).toBe('p2');
    expect(body.suggestions[0].project.name).toBe('Vinhomes Ocean Park');
    expect(body.suggestions[0].priceVnd).toBe('1500000000');

    const where = prismaMock.property.findMany.mock.calls[0][0].where;
    expect(where.orgId).toBe('org-1');
    expect(where.statusCode).toBe('AVAILABLE');
    expect(where.propertyTypeCode).toEqual({ in: ['CAN_HO'] });
    expect(where.id).toEqual({ notIn: ['p1'] });
    const order = prismaMock.property.findMany.mock.calls[0][0].orderBy;
    expect(order).toEqual({ updatedAt: 'desc' });
  });

  it('KH chưa có interest → căn AVAILABLE mới nhất (không lọc propertyTypeCode)', async () => {
    prismaMock.contact.findFirst.mockResolvedValue(CONTACT);
    prismaMock.contactInterest.findMany.mockResolvedValue([]);
    prismaMock.property.findMany.mockResolvedValue([
      { ...PROPERTY, id: 'p3', unitCode: 'C3-0504' },
    ]);

    const res = await buildApp().inject({ method: 'GET', url: `${URL}?limit=3` });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.suggestions).toHaveLength(1);
    expect(body.suggestions[0].id).toBe('p3');

    const findArgs = prismaMock.property.findMany.mock.calls[0][0];
    expect(findArgs.where).toEqual({ orgId: 'org-1', statusCode: 'AVAILABLE', isActive: true });
    expect(findArgs.where.propertyTypeCode).toBeUndefined();
    expect(findArgs.take).toBe(3);
  });

  it('contact không tồn tại → 404', async () => {
    prismaMock.contact.findFirst.mockResolvedValue(null);
    const res = await buildApp().inject({ method: 'GET', url: URL });
    expect(res.statusCode).toBe(404);
  });
});

// ── GET /api/v1/contacts/:contactId/rating-history ────────────────────────────
describe('GET /api/v1/contacts/:contactId/rating-history', () => {
  const URL = '/api/v1/contacts/c1/rating-history';

  it('trả history kèm changedByName (join User.fullName), changedAt ISO, mới nhất trước', async () => {
    prismaMock.contact.findFirst.mockResolvedValue(CONTACT);
    prismaMock.ratingHistory.findMany.mockResolvedValue([
      {
        id: 'rh-2',
        fromCode: 'A',
        toCode: 'B',
        reason: 'Khách chốt căn — nâng hạng',
        changedById: 'u1',
        changedAt: new Date('2026-11-16T09:00:00.000Z'),
      },
      {
        id: 'rh-1',
        fromCode: null,
        toCode: 'A',
        reason: null,
        changedById: 'u-ghost',
        changedAt: new Date('2026-11-15T09:00:00.000Z'),
      },
    ]);
    prismaMock.user.findMany.mockResolvedValue([{ id: 'u1', fullName: 'Nguyễn Văn A' }]);

    const res = await buildApp().inject({ method: 'GET', url: URL });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.history).toHaveLength(2);
    expect(body.history[0].id).toBe('rh-2');
    expect(body.history[0].fromCode).toBe('A');
    expect(body.history[0].toCode).toBe('B');
    expect(body.history[0].reason).toBe('Khách chốt căn — nâng hạng');
    expect(body.history[0].changedByName).toBe('Nguyễn Văn A');
    expect(body.history[0].changedAt).toBe('2026-11-16T09:00:00.000Z');
    // changedById không tìm thấy user → changedByName null (không crash)
    expect(body.history[1].changedByName).toBeNull();

    const where = prismaMock.ratingHistory.findMany.mock.calls[0][0].where;
    expect(where).toEqual({ orgId: 'org-1', contactId: 'c1' });
    const order = prismaMock.ratingHistory.findMany.mock.calls[0][0].orderBy;
    expect(order).toEqual({ changedAt: 'desc' });
    // Chỉ query user những id đã có
    const userWhere = prismaMock.user.findMany.mock.calls[0][0].where;
    expect(userWhere.id).toEqual({ in: ['u1', 'u-ghost'] });
  });

  it('contact không tồn tại trong org → 404 CONTACT_NOT_FOUND', async () => {
    prismaMock.contact.findFirst.mockResolvedValue(null);
    const res = await buildApp().inject({ method: 'GET', url: '/api/v1/contacts/nope/rating-history' });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).code).toBe('CONTACT_NOT_FOUND');
  });
});