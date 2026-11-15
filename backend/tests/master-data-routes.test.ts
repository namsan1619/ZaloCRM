/**
 * master-data-routes.test.ts — Tests cho MasterData (danh mục dùng chung).
 *
 * Bao phủ:
 *  - GET /categories: lazy-seed 10 nhóm mặc định + trả danh sách nhóm.
 *  - GET /items: lọc categoryKey/qu activeOnly, category key không tồn tại → [].
 *  - POST /items: tạo OK, thiếu code/label → 400, category không tồn tại → 404,
 *    trùng code → 409, role member → 403.
 *  - PUT /items/:id: update OK, không tồn tại → 404.
 *  - DELETE /items/:id: metadata.usedBy != null → 400 ITEM_IN_USE,
 *    còn mục con → 400 HAS_CHILDREN, xóa OK → { deleted: true }.
 *  - POST /reorder: update sortOrder hàng loạt, body sai → 400.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { mockUser } from './test-helpers.js';

// ── Hoisted mock state ────────────────────────────────────────────────────────
const prismaMock = {
  masterDataCategory: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
  },
  masterData: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    delete: vi.fn(),
    count: vi.fn(),
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

const { registerMasterDataRoutes } = await import('../src/modules/master-data/master-data-routes.js');
const { DEFAULT_MASTER_DATA_CATEGORIES } = await import('../src/modules/master-data/master-data-seed.js');
const { logActivity } = await import('../src/modules/activity/activity-logger.js');

function buildApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  app.register(registerMasterDataRoutes);
  return app;
}

const CATEGORY = {
  id: 'cat-1', orgId: 'org-1', key: 'NGUON_KH', label: 'Nguồn KH',
  icon: 'mdi-account-network-outline', sortOrder: 10, isSystem: true,
  createdAt: new Date('2026-11-15T00:00:00.000Z'),
  updatedAt: new Date('2026-11-15T00:00:00.000Z'),
};

const ITEM = {
  id: 'item-1', orgId: 'org-1', categoryId: 'cat-1', code: 'FACEBOOK',
  label: 'Facebook', parentCode: null, sortOrder: 0, color: null,
  isActive: true, metadata: { usedBy: null },
  createdAt: new Date('2026-11-15T00:00:00.000Z'),
  updatedAt: new Date('2026-11-15T00:00:00.000Z'),
};

beforeEach(() => {
  vi.clearAllMocks();
  currentRole = 'admin';
});

// ── GET /api/v1/settings/master-data/categories ───────────────────────────────
describe('GET /api/v1/settings/master-data/categories', () => {
  const URL = '/api/v1/settings/master-data/categories';

  it('org đã có đủ nhóm: không seed thêm, trả danh sách nhóm', async () => {
    prismaMock.masterDataCategory.findMany.mockResolvedValue(
      DEFAULT_MASTER_DATA_CATEGORIES.map((d) => ({
        id: 'cat-' + d.key, orgId: 'org-1', key: d.key, label: d.label, icon: d.icon,
        sortOrder: d.sortOrder, isSystem: true,
        createdAt: new Date('2026-11-15T00:00:00.000Z'),
        updatedAt: new Date('2026-11-15T00:00:00.000Z'),
      })),
    );

    const res = await buildApp().inject({ method: 'GET', url: URL });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.categories).toHaveLength(12);
    expect(body.categories[0].key).toBe('NGUON_KH');
    expect(prismaMock.masterDataCategory.create).not.toHaveBeenCalled();
    // Scoped theo org
    const where = prismaMock.masterDataCategory.findMany.mock.calls[0][0].where;
    expect(where.orgId).toBe('org-1');
  });

  it('org mới: lazy-seed 12 nhóm mặc định (idempotent)', async () => {
    prismaMock.masterDataCategory.findMany.mockResolvedValue([]);
    prismaMock.masterDataCategory.create.mockImplementation(async (args: any) => ({
      id: 'new-' + args.data.key, ...args.data,
      createdAt: new Date(), updatedAt: new Date(),
    }));

    const res = await buildApp().inject({ method: 'GET', url: URL });
    expect(res.statusCode).toBe(200);
    // 12 nhóm chuẩn được seed
    expect(prismaMock.masterDataCategory.create).toHaveBeenCalledTimes(12);
    const keys = prismaMock.masterDataCategory.create.mock.calls.map((c) => c[0].data.key);
    expect(keys).toEqual(
      expect.arrayContaining(['NGUON_KH', 'LOAI_CAN', 'HUONG', 'VIEW', 'BAN_GIAO', 'NOI_THAT', 'DAI_LY', 'TRANG_THAI_CAN', 'TRANG_THAI_KH', 'PHAPLY', 'CO_CHE_DAC_BIET', 'KEHOACH']),
    );
    // isSystem = true cho nhóm mặc định
    expect(prismaMock.masterDataCategory.create.mock.calls[0][0].data.isSystem).toBe(true);
  });
});

// ── GET /api/v1/settings/master-data/items ────────────────────────────────────
describe('GET /api/v1/settings/master-data/items', () => {
  it('lọc theo categoryKey + q + activeOnly', async () => {
    prismaMock.masterDataCategory.findFirst.mockResolvedValue({ id: 'cat-1' });
    prismaMock.masterData.findMany.mockResolvedValue([ITEM]);

    const res = await buildApp().inject({
      method: 'GET',
      url: '/api/v1/settings/master-data/items?categoryKey=NGUON_KH&q=face&activeOnly=1',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].code).toBe('FACEBOOK');

    const where = prismaMock.masterData.findMany.mock.calls[0][0].where;
    expect(where.orgId).toBe('org-1');
    expect(where.categoryId).toBe('cat-1');
    expect(where.isActive).toBe(true);
    expect(where.OR).toEqual([
      { code: { contains: 'face', mode: 'insensitive' } },
      { label: { contains: 'face', mode: 'insensitive' } },
    ]);
  });

  it('categoryKey không tồn tại → trả mảng rỗng, không query items', async () => {
    prismaMock.masterDataCategory.findFirst.mockResolvedValue(null);
    const res = await buildApp().inject({ method: 'GET', url: '/api/v1/settings/master-data/items?categoryKey=KHONG_CO' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).items).toEqual([]);
    expect(prismaMock.masterData.findMany).not.toHaveBeenCalled();
  });
});

// ── POST /api/v1/settings/master-data/items ───────────────────────────────────
describe('POST /api/v1/settings/master-data/items', () => {
  const URL = '/api/v1/settings/master-data/items';
  const BODY = { categoryKey: 'NGUON_KH', code: 'ZALO', label: 'Zalo' };

  it('tạo mục danh mục OK + log activity master_data_created', async () => {
    prismaMock.masterDataCategory.findFirst.mockResolvedValue({ id: 'cat-1' });
    prismaMock.masterData.findFirst.mockResolvedValue(null); // không trùng code
    prismaMock.masterData.create.mockResolvedValue({ ...ITEM, code: 'ZALO', label: 'Zalo' });

    const res = await buildApp().inject({ method: 'POST', url: URL, payload: BODY });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).item.code).toBe('ZALO');
    expect(prismaMock.masterData.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ orgId: 'org-1', categoryId: 'cat-1', code: 'ZALO', label: 'Zalo' }),
      }),
    );
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'master_data_created', entityId: 'item-1' }),
    );
  });

  it('tạo bằng categoryId thay vì categoryKey', async () => {
    prismaMock.masterDataCategory.findFirst.mockResolvedValue({ id: 'cat-1' });
    prismaMock.masterData.findFirst.mockResolvedValue(null);
    prismaMock.masterData.create.mockResolvedValue(ITEM);
    const res = await buildApp().inject({ method: 'POST', url: URL, payload: { categoryId: 'cat-1', code: 'WEB', label: 'Website' } });
    expect(res.statusCode).toBe(200);
  });

  it('thiếu code → 400 CODE_REQUIRED', async () => {
    const res = await buildApp().inject({ method: 'POST', url: URL, payload: { categoryKey: 'NGUON_KH', label: 'X' } });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe('CODE_REQUIRED');
  });

  it('thiếu label → 400 LABEL_REQUIRED', async () => {
    const res = await buildApp().inject({ method: 'POST', url: URL, payload: { categoryKey: 'NGUON_KH', code: 'X' } });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe('LABEL_REQUIRED');
  });

  it('thiếu categoryId/categoryKey → 400 CATEGORY_REQUIRED', async () => {
    const res = await buildApp().inject({ method: 'POST', url: URL, payload: { code: 'X', label: 'X' } });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe('CATEGORY_REQUIRED');
  });

  it('category không tồn tại trong org → 404 CATEGORY_NOT_FOUND', async () => {
    prismaMock.masterDataCategory.findFirst.mockResolvedValue(null);
    const res = await buildApp().inject({ method: 'POST', url: URL, payload: BODY });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).code).toBe('CATEGORY_NOT_FOUND');
  });

  it('trùng code trong cùng category → 409 DUPLICATE_CODE', async () => {
    prismaMock.masterDataCategory.findFirst.mockResolvedValue({ id: 'cat-1' });
    prismaMock.masterData.findFirst.mockResolvedValue({ id: 'item-1' });
    const res = await buildApp().inject({ method: 'POST', url: URL, payload: BODY });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe('DUPLICATE_CODE');
  });

  it('parentCode không tồn tại trong cùng category → 400 PARENT_NOT_FOUND', async () => {
    prismaMock.masterDataCategory.findFirst.mockResolvedValue({ id: 'cat-1' });
    prismaMock.masterData.findFirst.mockResolvedValue(null); // parent không có
    const res = await buildApp().inject({
      method: 'POST', url: URL,
      payload: { ...BODY, parentCode: 'KHONG_CO' },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe('PARENT_NOT_FOUND');
  });

  it('role member → 403 (chỉ owner/admin được ghi)', async () => {
    currentRole = 'member';
    prismaMock.masterDataCategory.findFirst.mockResolvedValue({ id: 'cat-1' });
    prismaMock.masterData.findFirst.mockResolvedValue(null);
    const res = await buildApp().inject({ method: 'POST', url: URL, payload: BODY });
    expect(res.statusCode).toBe(403);
    expect(prismaMock.masterData.create).not.toHaveBeenCalled();
  });
});

// ── PUT /api/v1/settings/master-data/items/:id ────────────────────────────────
describe('PUT /api/v1/settings/master-data/items/:id', () => {
  it('cập nhật label + sortOrder + log master_data_updated', async () => {
    prismaMock.masterData.findFirst.mockResolvedValue({ id: 'item-1', categoryId: 'cat-1', code: 'FACEBOOK', parentCode: null });
    prismaMock.masterData.update.mockResolvedValue({ ...ITEM, label: 'Facebook Ads', sortOrder: 5 });

    const res = await buildApp().inject({
      method: 'PUT', url: '/api/v1/settings/master-data/items/item-1',
      payload: { label: 'Facebook Ads', sortOrder: 5 },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).item.label).toBe('Facebook Ads');
    expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({ action: 'master_data_updated' }));
  });

  it('item không tồn tại trong org → 404 ITEM_NOT_FOUND', async () => {
    prismaMock.masterData.findFirst.mockResolvedValue(null);
    const res = await buildApp().inject({
      method: 'PUT', url: '/api/v1/settings/master-data/items/item-unknown',
      payload: { label: 'X' },
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).code).toBe('ITEM_NOT_FOUND');
  });
});

// ── DELETE /api/v1/settings/master-data/items/:id ─────────────────────────────
describe('DELETE /api/v1/settings/master-data/items/:id', () => {
  it('metadata.usedBy != null → 400 ITEM_IN_USE', async () => {
    prismaMock.masterData.findFirst.mockResolvedValue({
      id: 'item-1', categoryId: 'cat-1', code: 'FACEBOOK',
      metadata: { usedBy: 'contact.rating' },
    });
    const res = await buildApp().inject({ method: 'DELETE', url: '/api/v1/settings/master-data/items/item-1' });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe('ITEM_IN_USE');
    expect(prismaMock.masterData.delete).not.toHaveBeenCalled();
  });

  it('còn mục con trỏ parentCode → 400 HAS_CHILDREN', async () => {
    prismaMock.masterData.findFirst.mockResolvedValue({
      id: 'item-1', categoryId: 'cat-1', code: 'FACEBOOK', metadata: { usedBy: null },
    });
    prismaMock.masterData.count.mockResolvedValue(3);
    const res = await buildApp().inject({ method: 'DELETE', url: '/api/v1/settings/master-data/items/item-1' });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe('HAS_CHILDREN');
  });

  it('xóa OK → { deleted: true } + log master_data_deleted', async () => {
    prismaMock.masterData.findFirst.mockResolvedValue({
      id: 'item-1', categoryId: 'cat-1', code: 'FACEBOOK', metadata: { usedBy: null },
    });
    prismaMock.masterData.count.mockResolvedValue(0);
    prismaMock.masterData.delete.mockResolvedValue({ id: 'item-1' });

    const res = await buildApp().inject({ method: 'DELETE', url: '/api/v1/settings/master-data/items/item-1' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ deleted: true });
    expect(prismaMock.masterData.delete).toHaveBeenCalledWith({ where: { id: 'item-1' } });
    expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({ action: 'master_data_deleted' }));
  });
});

// ── POST /api/v1/settings/master-data/reorder ─────────────────────────────────
describe('POST /api/v1/settings/master-data/reorder', () => {
  it('update sortOrder hàng loạt, trả số lượng đã update', async () => {
    prismaMock.masterData.updateMany.mockResolvedValue({ count: 1 });
    const res = await buildApp().inject({
      method: 'POST', url: '/api/v1/settings/master-data/reorder',
      payload: { items: [{ id: 'item-1', sortOrder: 1 }, { id: 'item-2', sortOrder: 2 }] },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).updated).toBe(2);
    // Scope org khi update
    expect(prismaMock.masterData.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ orgId: 'org-1' }) }),
    );
  });

  it('body thiếu items → 400 ITEMS_REQUIRED', async () => {
    const res = await buildApp().inject({ method: 'POST', url: '/api/v1/settings/master-data/reorder', payload: {} });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe('ITEMS_REQUIRED');
  });

  it('item thiếu sortOrder → 400 INVALID_ITEM', async () => {
    const res = await buildApp().inject({
      method: 'POST', url: '/api/v1/settings/master-data/reorder',
      payload: { items: [{ id: 'item-1' }] },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe('INVALID_ITEM');
  });
});