// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyễn Tiến Lộc
/**
 * contact-create-code.test.ts — POST /api/v1/contacts + PUT /api/v1/contacts/:id.
 *
 * Phủ 2 hành vi mới (CRM SĐT KH 2026-11-16):
 *  1. Cấp mã KH TỰ ĐỘNG khi tạo KH tay — KH000001, KH000002... qua
 *     ContactCodeSequence (cấp dải số atomic → 2 request song song KHÔNG trùng mã).
 *  2. Nhận đánh giá tay (ratingCode/ratingNote) lúc tạo + lúc sửa.
 *     ratingCode phải là mã MasterData ACTIVE trong category TRANG_THAI_KH của org,
 *     không hợp lệ → 400 rõ ràng (KHÔNG tạo/sửa KH).
 *
 * Mock prisma-client (không cần DB thật) — theo pattern tests/master-data-routes.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { mockUser } from './test-helpers.js';

// ── Mock prisma ──────────────────────────────────────────────────────────────
// Counter giả lập ContactCodeSequence: increment DIỄN RA ĐỒNG BỘ (không await
// bên trong) → 2 request chạy song song vẫn nhận 2 số khác nhau.
let seqLastValue = 0;

const prismaMock = {
  contact: {
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  contactAccess: {
    upsert: vi.fn(),
    findMany: vi.fn(),
  },
  organization: {
    findUnique: vi.fn(),
  },
  contactCodeSequence: {
    upsert: vi.fn(async (args: any) => {
      if (!seqLastValue) seqLastValue = args.create.lastValue;
      else seqLastValue += args.update.lastValue.increment;
      return { lastValue: seqLastValue };
    }),
    update: vi.fn(async (args: any) => {
      seqLastValue += args.data.lastValue.increment;
      return { lastValue: seqLastValue };
    }),
  },
  masterData: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
  },
  status: { findFirst: vi.fn() },
  friend: { findMany: vi.fn() },
  user: { findUnique: vi.fn() },
};

vi.mock('../src/shared/database/prisma-client.js', () => ({
  prisma: prismaMock,
  tenantTransaction: async (fn: (tx: typeof prismaMock) => Promise<unknown>) => fn(prismaMock),
}));
vi.mock('../src/shared/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/modules/auth/auth-middleware.js', () => ({
  authMiddleware: async (req: any) => { req.user = mockUser(); },
}));
vi.mock('../src/modules/rbac/rbac-middleware.js', () => ({
  requireGrant: () => async () => {},
  requireAnyGrant: () => async () => {},
}));
vi.mock('../src/modules/activity/activity-logger.js', () => ({
  logActivity: vi.fn(),
  computeDiff: vi.fn(() => ({})),
}));
vi.mock('../src/modules/privacy/redact.js', () => ({
  isBlurContaminated: vi.fn(() => false),
  buildPrivacyContext: vi.fn(async () => ({})),
  shouldRedactContactPii: vi.fn(async () => false),
  redactContact: vi.fn(async (c: unknown) => c),
}));
vi.mock('../src/modules/contacts/contact-scope.js', () => ({
  getContactScope: vi.fn(async () => ({
    isOrgAdmin: true,
    accessibleContactIds: null,
    primaryContactIds: new Set<string>(),
    collaboratorContactIds: new Set<string>(),
  })),
  assertContactVisible: vi.fn(async () => true),
  attachContactCollaboratorByUser: vi.fn(async () => {}),
  assertContactEditable: vi.fn(async () => {}),
}));
vi.mock('../src/modules/contacts/merge-service.js', () => ({ mergeContacts: vi.fn() }));
vi.mock('../src/modules/contacts/contact-intelligence.js', () => ({ runContactIntelligence: vi.fn() }));
vi.mock('../src/modules/contacts/status-migration.js', () => ({ migrateStatusTable: vi.fn() }));
vi.mock('../src/modules/contacts/backfill-global-id.js', () => ({
  backfillGlobalId: vi.fn(),
  backfillOrphanFriends: vi.fn(),
}));
vi.mock('../src/modules/contacts/backfill-missing-friends.js', () => ({ backfillMissingFriends: vi.fn() }));
vi.mock('../src/modules/contacts/backfill-friend-display-name.js', () => ({ backfillFriendDisplayName: vi.fn() }));
vi.mock('../src/modules/chat/conversation-resolver.js', () => ({ findExistingUserConversation: vi.fn() }));
vi.mock('../src/modules/zalo/zalo-scope.js', () => ({ getZaloScope: vi.fn(async () => null) }));
vi.mock('../src/modules/api/webhook-service.js', () => ({ emitWebhook: vi.fn() }));
vi.mock('../src/shared/realtime/emit-chat.js', () => ({ emitChatMessage: vi.fn() }));

const { contactRoutes } = await import('../src/modules/contacts/contact-routes.js');
const { logActivity } = await import('../src/modules/activity/activity-logger.js');

function buildApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  app.register(contactRoutes);
  return app;
}

/** Row Contact tối thiểu — mọi field handler đọc đều có trong đây. */
function contactRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'contact-1',
    orgId: 'org-1',
    fullName: 'Nguyễn Văn A',
    crmName: null,
    phone: '0908123456',
    email: null,
    gender: null,
    birthDate: null,
    addressLine: null,
    occupation: null,
    source: null,
    status: 'new',
    statusId: null,
    assignedUserId: 'user-1',
    leadScore: 0,
    customerCode: 'KH000001',
    ratingCode: null,
    ratingNote: null,
    ratedById: null,
    ratedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  seqLastValue = 0;
  prismaMock.contactAccess.upsert.mockResolvedValue({});
  prismaMock.organization.findUnique.mockResolvedValue({ id: 'org-1', name: 'Org 1' });
});

// ── POST /api/v1/contacts — cấp mã KH tự động ────────────────────────────────
describe('POST /api/v1/contacts — cấp mã KH tự động', () => {
  const URL = '/api/v1/contacts';

  it('KH tạo tay đầu tiên của org → customerCode KH000001 + log customer_create', async () => {
    prismaMock.contact.create.mockImplementation(async (args: any) =>
      contactRow({ id: 'contact-1', customerCode: args.data.customerCode }),
    );

    const res = await buildApp().inject({
      method: 'POST', url: URL, payload: { fullName: 'Nguyễn Văn A', phone: '0908123456' },
    });

    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).customerCode).toBe('KH000001');
    expect(prismaMock.contact.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ orgId: 'org-1', customerCode: 'KH000001' }),
      }),
    );
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'customer_create',
        entityId: 'contact-1',
        details: { customerCode: 'KH000001' },
      }),
    );
  });

  it('các KH tạo liên tiếp → mã KH liên tục, KHÔNG trùng', async () => {
    let n = 0;
    prismaMock.contact.create.mockImplementation(async (args: any) => {
      n += 1;
      return contactRow({ id: `contact-${n}`, customerCode: args.data.customerCode });
    });

    const app = buildApp();
    const first = await app.inject({ method: 'POST', url: URL, payload: { fullName: 'KH 1' } });
    const second = await app.inject({ method: 'POST', url: URL, payload: { fullName: 'KH 2' } });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(JSON.parse(first.body).customerCode).toBe('KH000001');
    expect(JSON.parse(second.body).customerCode).toBe('KH000002');
  });

  it('2 request song song → mã KH phân biệt (cấp dải số atomic)', async () => {
    prismaMock.contact.create.mockImplementation(async (args: any) =>
      contactRow({ id: `contact-${args.data.customerCode}`, customerCode: args.data.customerCode }),
    );

    const app = buildApp();
    const [a, b] = await Promise.all([
      app.inject({ method: 'POST', url: URL, payload: { fullName: 'KH song song 1' } }),
      app.inject({ method: 'POST', url: URL, payload: { fullName: 'KH song song 2' } }),
    ]);

    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    const codes = [JSON.parse(a.body).customerCode, JSON.parse(b.body).customerCode];
    expect(new Set(codes).size).toBe(2);
    expect(codes.sort()).toEqual(['KH000001', 'KH000002']);
  });
});

// ── POST /api/v1/contacts — đánh giá tay ─────────────────────────────────────
describe('POST /api/v1/contacts — đánh giá tay (ratingCode/ratingNote)', () => {
  const URL = '/api/v1/contacts';

  it('ratingCode hợp lệ → tạo KH kèm rating + log contact_rating_change', async () => {
    prismaMock.masterData.findFirst.mockResolvedValue({ code: 'A' });
    prismaMock.contact.create.mockImplementation(async (args: any) =>
      contactRow({
        id: 'contact-1',
        customerCode: args.data.customerCode,
        ratingCode: args.data.ratingCode,
        ratingNote: args.data.ratingNote,
        ratedById: args.data.ratedById,
        ratedAt: args.data.ratedAt,
      }),
    );

    const res = await buildApp().inject({
      method: 'POST', url: URL,
      payload: { fullName: 'KH VIP', ratingCode: 'A', ratingNote: 'khách ưu tiên' },
    });

    expect(res.statusCode).toBe(201);
    const data = prismaMock.contact.create.mock.calls[0][0].data;
    expect(data.ratingCode).toBe('A');
    expect(data.ratingNote).toBe('khách ưu tiên');
    expect(data.ratedById).toBe('user-1');
    expect(data.ratedAt).toBeInstanceOf(Date);

    // MasterData phải được lọc đúng category TRANG_THAI_KH + org + isActive
    expect(prismaMock.masterData.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          code: 'A',
          isActive: true,
          category: { key: 'TRANG_THAI_KH', orgId: 'org-1' },
        }),
      }),
    );
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'contact_rating_change',
        details: { old: null, new: 'A', customerCode: 'KH000001' },
      }),
    );
  });

  it('ratingCode không hợp lệ → 400, KHÔNG tạo contact, KHÔNG đốt mã KH', async () => {
    prismaMock.masterData.findFirst.mockResolvedValue(null);

    const res = await buildApp().inject({
      method: 'POST', url: URL, payload: { fullName: 'KH lỗi', ratingCode: 'KHONG_CO' },
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('ratingCode không hợp lệ');
    expect(prismaMock.contact.create).not.toHaveBeenCalled();
    expect(prismaMock.contactCodeSequence.upsert).not.toHaveBeenCalled();
  });

  it('không gửi ratingCode → KHÔNG query MasterData, KHÔNG ghi field rating', async () => {
    prismaMock.contact.create.mockImplementation(async (args: any) =>
      contactRow({ id: 'contact-1', customerCode: args.data.customerCode }),
    );

    const res = await buildApp().inject({
      method: 'POST', url: URL, payload: { fullName: 'KH không rating' },
    });

    expect(res.statusCode).toBe(201);
    expect(prismaMock.masterData.findFirst).not.toHaveBeenCalled();
    const data = prismaMock.contact.create.mock.calls[0][0].data;
    expect(data.ratingCode).toBeUndefined();
    expect(data.ratingNote).toBeUndefined();
    // Mã KH vẫn được cấp bình thường
    expect(data.customerCode).toBe('KH000001');
  });
});

// ── PUT /api/v1/contacts/:id — đánh giá tay ───────────────────────────────────
describe('PUT /api/v1/contacts/:id — đánh giá tay (ratingCode/ratingNote)', () => {
  const URL = '/api/v1/contacts/contact-1';

  it('ratingCode hợp lệ → cập nhật rating + log contact_rating_change (old → new)', async () => {
    prismaMock.contact.findFirst.mockResolvedValue(
      contactRow({ customerCode: 'KH000042', ratingCode: null, ratingNote: null }),
    );
    prismaMock.masterData.findFirst.mockResolvedValue({ code: 'B' });
    prismaMock.contact.update.mockImplementation(async (args: any) =>
      contactRow({
        ...contactRow(),
        customerCode: 'KH000042',
        ratingCode: args.data.ratingCode,
        ratingNote: args.data.ratingNote,
        ratedById: args.data.ratedById,
        ratedAt: args.data.ratedAt,
      }),
    );

    const res = await buildApp().inject({
      method: 'PUT', url: URL, payload: { ratingCode: 'B', ratingNote: 'rất ổn' },
    });

    expect(res.statusCode).toBe(200);
    const data = prismaMock.contact.update.mock.calls[0][0].data;
    expect(data.ratingCode).toBe('B');
    expect(data.ratingNote).toBe('rất ổn');
    expect(data.ratedById).toBe('user-1');
    expect(data.ratedAt).toBeInstanceOf(Date);

    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'contact_rating_change',
        details: { old: null, new: 'B', customerCode: 'KH000042' },
      }),
    );
  });

  it('ratingCode không hợp lệ → 400, KHÔNG update contact', async () => {
    prismaMock.contact.findFirst.mockResolvedValue(contactRow({ customerCode: 'KH000042' }));
    prismaMock.masterData.findFirst.mockResolvedValue(null);

    const res = await buildApp().inject({
      method: 'PUT', url: URL, payload: { fullName: 'Tên mới', ratingCode: 'KHONG_CO' },
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('ratingCode không hợp lệ');
    expect(prismaMock.contact.update).not.toHaveBeenCalled();
  });

  it('ratingCode rỗng → tháo đánh giá (set null)', async () => {
    prismaMock.contact.findFirst.mockResolvedValue(
      contactRow({ customerCode: 'KH000042', ratingCode: 'A', ratingNote: 'ghi chú cũ' }),
    );
    prismaMock.contact.update.mockResolvedValue(
      contactRow({ customerCode: 'KH000042', ratingCode: null, ratingNote: null, ratedById: null, ratedAt: null }),
    );

    const res = await buildApp().inject({
      method: 'PUT', url: URL, payload: { ratingCode: '' },
    });

    expect(res.statusCode).toBe(200);
    const data = prismaMock.contact.update.mock.calls[0][0].data;
    expect(data.ratingCode).toBeNull();
    expect(data.ratingNote).toBeNull();
    expect(data.ratedById).toBeNull();
    expect(data.ratedAt).toBeNull();

    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'contact_rating_change',
        details: { old: 'A', new: null, customerCode: 'KH000042' },
      }),
    );
  });

  it('không gửi ratingCode → KHÔNG query MasterData, KHÔNG đụng rating, update vẫn chạy', async () => {
    prismaMock.contact.findFirst.mockResolvedValue(
      contactRow({ customerCode: 'KH000042', ratingCode: 'A', ratingNote: 'giữ nguyên' }),
    );
    prismaMock.contact.update.mockImplementation(async (args: any) =>
      contactRow({ ...contactRow(), customerCode: 'KH000042', ratingCode: 'A', ratingNote: 'giữ nguyên' }),
    );

    const res = await buildApp().inject({
      method: 'PUT', url: URL, payload: { fullName: 'Tên mới' },
    });

    expect(res.statusCode).toBe(200);
    expect(prismaMock.masterData.findFirst).not.toHaveBeenCalled();
    const data = prismaMock.contact.update.mock.calls[0][0].data;
    expect(data.ratingCode).toBeUndefined();
    expect(data.fullName).toBe('Tên mới');
    // Không đổi rating → không log rating
    expect(logActivity).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'contact_rating_change' }),
    );
  });
});
