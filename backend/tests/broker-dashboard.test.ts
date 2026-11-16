// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyen Tien Loc
/**
 * broker-dashboard.test.ts — Tests cho dashboard tổng hợp môi giới.
 *
 * Mock toàn bộ prisma (groupBy trả mảng, count trả số) — KHÔNG gọi DB thật.
 * Bao phủ shape từng phần:
 *  - byRating luôn có 5 key, UNRATED từ ratingCode null/khác A-D.
 *  - byProject gắn projectName từ bảng Project, top 10 theo total desc.
 *  - byAgency agencyId null → bucket "Khac".
 *  - campaigns/runs: trạng thái RUNNING/SCHEDULED/COMPLETED + total.
 *  - Route GET /api/v1/dashboard/broker/summary trả 200 đúng shape, scope orgId.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mockUser } from './test-helpers.js';

// ── Hoisted mock state ────────────────────────────────────────────────────────
const prismaMock = {
  contact: { count: vi.fn(), groupBy: vi.fn() },
  contactInterest: { groupBy: vi.fn() },
  property: { count: vi.fn(), groupBy: vi.fn() },
  project: { findMany: vi.fn() },
  agency: { findMany: vi.fn() },
  campaign: { count: vi.fn(), groupBy: vi.fn() },
  campaignRun: { count: vi.fn(), groupBy: vi.fn() },
};
let currentRole = 'admin';

vi.mock('../src/shared/database/prisma-client.js', () => ({ prisma: prismaMock }));
vi.mock('../src/shared/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/modules/auth/auth-middleware.js', () => ({
  authMiddleware: async (req: any) => { req.user = mockUser({ role: currentRole }); },
}));

const { getBrokerSummary, BrokerDashboardError } = await import(
  '../src/modules/dashboard/broker-dashboard-service.js'
);
const { registerBrokerDashboardRoutes } = await import(
  '../src/modules/dashboard/broker-dashboard-routes.js'
);

function resetDefaults() {
  // contacts: 10 tổng, 2 mới hôm nay, rating A=3 + phần còn lại chưa xếp hạng
  prismaMock.contact.count.mockImplementation(async (args: any) =>
    args.where?.createdAt ? 2 : 10,
  );
  prismaMock.contact.groupBy.mockImplementation(async (args: any) => {
    if (args.by[0] === 'ratingCode') {
      return [
        { ratingCode: 'A', _count: 3 },
        { ratingCode: null, _count: 7 },
      ];
    }
    return [];
  });
  prismaMock.contactInterest.groupBy.mockImplementation(async () => [
    { contactId: 'c1', _count: 2 },
    { contactId: 'c2', _count: 1 },
  ]);
  // properties: 25 active, byStatus, byProject, byAgency fixture
  prismaMock.property.count.mockImplementation(async () => 25);
  prismaMock.property.groupBy.mockImplementation(async (args: any) => {
    if (args.by[0] === 'statusCode') {
      return [
        { statusCode: 'AVAILABLE', _count: 15 },
        { statusCode: 'ON_HOLD', _count: 5 },
        { statusCode: 'SOLD', _count: 5 },
      ];
    }
    if (args.by[0] === 'projectId') {
      return [
        { projectId: 'p1', statusCode: 'AVAILABLE', _count: 8 },
        { projectId: 'p1', statusCode: 'SOLD', _count: 2 },
        { projectId: 'p2', statusCode: 'AVAILABLE', _count: 1 },
        { projectId: 'p3', statusCode: 'ON_HOLD', _count: 3 },
      ];
    }
    // agencyId
    return [
      { agencyId: null, statusCode: 'AVAILABLE', _count: 6 },
      { agencyId: null, statusCode: 'SOLD', _count: 2 },
      { agencyId: 'ag1', statusCode: 'AVAILABLE', _count: 4 },
    ];
  });
  prismaMock.project.findMany.mockImplementation(async () => [
    { id: 'p1', name: 'Dự án Vinhomes Grand Park' },
    { id: 'p2', name: 'Dự án Sun Group' },
    { id: 'p3', name: 'Dự án Mặt Trời' },
  ]);
  prismaMock.agency.findMany.mockImplementation(async () => [
    { id: 'ag1', name: 'Đại lý Sài Gòn' },
  ]);
  // campaigns: 8 tổng (2 RUNNING, 3 SCHEDULED, 1 COMPLETED, 2 DRAFT)
  prismaMock.campaign.count.mockImplementation(async () => 8);
  prismaMock.campaign.groupBy.mockImplementation(async () => [
    { status: 'RUNNING', _count: 2 },
    { status: 'SCHEDULED', _count: 3 },
    { status: 'COMPLETED', _count: 1 },
    { status: 'DRAFT', _count: 2 },
  ]);
  // runs: 6 tổng (2 RUNNING)
  prismaMock.campaignRun.count.mockImplementation(async () => 6);
  prismaMock.campaignRun.groupBy.mockImplementation(async () => [
    { status: 'RUNNING', _count: 2 },
    { status: 'DONE', _count: 4 },
  ]);
}

beforeEach(() => {
  vi.clearAllMocks();
  currentRole = 'admin';
  resetDefaults();
});

// ── getBrokerSummary: contacts ────────────────────────────────────────────────
describe('getBrokerSummary — contacts', () => {
  it('total/newToday/withInterests + scope orgId + loại KH đã merge', async () => {
    const s = await getBrokerSummary('org-1');

    expect(s.contacts.total).toBe(10);
    expect(s.contacts.newToday).toBe(2);
    expect(s.contacts.withInterests).toBe(2); // 2 contactId distinct

    const totalCall = prismaMock.contact.count.mock.calls[0][0];
    expect(totalCall.where.orgId).toBe('org-1');
    expect(totalCall.where.mergedInto).toBeNull();
    const newTodayCall = prismaMock.contact.count.mock.calls[1][0];
    expect(newTodayCall.where.orgId).toBe('org-1');
    expect(newTodayCall.where.mergedInto).toBeNull();
    expect(newTodayCall.where.createdAt).toBeDefined();
  });

  it('byRating luôn có đủ 5 key A/B/C/D/UNRATED; null rating → UNRATED', async () => {
    const s = await getBrokerSummary('org-1');
    expect(s.contacts.byRating).toEqual({ A: 3, B: 0, C: 0, D: 0, UNRATED: 7 });
  });

  it('chỉ có rating null (không có row A-D) → UNRATED = toàn bộ total', async () => {
    prismaMock.contact.groupBy.mockImplementation(async (args: any) => {
      if (args.by[0] === 'ratingCode') return [{ ratingCode: null, _count: 10 }];
      return [];
    });
    const s = await getBrokerSummary('org-1');
    expect(s.contacts.byRating).toEqual({ A: 0, B: 0, C: 0, D: 0, UNRATED: 10 });
  });
});

// ── getBrokerSummary: properties ──────────────────────────────────────────────
describe('getBrokerSummary — properties', () => {
  it('total + byStatus từ groupBy statusCode', async () => {
    const s = await getBrokerSummary('org-1');
    expect(s.properties.total).toBe(25);
    expect(s.properties.byStatus).toEqual({ AVAILABLE: 15, ON_HOLD: 5, SOLD: 5 });
    // Scope org + isActive
    const totalCall = prismaMock.property.count.mock.calls[0][0];
    expect(totalCall.where).toEqual({ orgId: 'org-1', isActive: true });
  });

  it('byProject gắn projectName, total + available, xếp theo total desc', async () => {
    const s = await getBrokerSummary('org-1');
    expect(s.properties.byProject).toEqual([
      { projectId: 'p1', projectName: 'Dự án Vinhomes Grand Park', total: 10, available: 8 },
      { projectId: 'p3', projectName: 'Dự án Mặt Trời', total: 3, available: 0 },
      { projectId: 'p2', projectName: 'Dự án Sun Group', total: 1, available: 1 },
    ]);
    // findMany fetch name theo top 10 project
    const findManyCall = prismaMock.project.findMany.mock.calls[0][0];
    expect(findManyCall.where.orgId).toBe('org-1');
    expect(findManyCall.where.id.in).toEqual(['p1', 'p3', 'p2']);
  });

  it('byProject chỉ giữ top 10 theo total desc', async () => {
    const rows: Array<{ projectId: string; statusCode: string; _count: number }> = [];
    for (let i = 1; i <= 12; i++) {
      rows.push({ projectId: `p${i}`, statusCode: 'AVAILABLE', _count: i });
    }
    prismaMock.property.groupBy.mockImplementation(async (args: any) => {
      if (args.by[0] === 'projectId') return rows;
      return [];
    });
    prismaMock.agency.findMany.mockResolvedValue([]);
    const s = await getBrokerSummary('org-1');
    expect(s.properties.byProject).toHaveLength(10);
    expect(s.properties.byProject[0].projectId).toBe('p12'); // total 12 cao nhất
    expect(s.properties.byProject[9].projectId).toBe('p3'); // total 3
    expect(s.properties.byProject.some((r) => r.projectId === 'p1')).toBe(false);
  });

  it('byAgency agencyId null → gom vào bucket "Khac"', async () => {
    const s = await getBrokerSummary('org-1');
    expect(s.properties.byAgency).toEqual([
      { agencyId: null, agencyName: 'Khac', total: 8, available: 6 },
      { agencyId: 'ag1', agencyName: 'Đại lý Sài Gòn', total: 4, available: 4 },
    ]);
    // findMany chỉ fetch đại lý không-null
    const findManyCall = prismaMock.agency.findMany.mock.calls[0][0];
    expect(findManyCall.where.orgId).toBe('org-1');
    expect(findManyCall.where.id.in).toEqual(['ag1']);
  });
});

// ── getBrokerSummary: campaigns + runs ────────────────────────────────────────
describe('getBrokerSummary — campaigns + runs', () => {
  it('campaigns: total + running/scheduled/completed từ groupBy status', async () => {
    const s = await getBrokerSummary('org-1');
    expect(s.campaigns).toEqual({ total: 8, running: 2, scheduled: 3, completed: 1 });
    const countCall = prismaMock.campaign.count.mock.calls[0][0];
    expect(countCall.where.orgId).toBe('org-1');
  });

  it('runs: total + running', async () => {
    const s = await getBrokerSummary('org-1');
    expect(s.runs).toEqual({ total: 6, running: 2 });
    const countCall = prismaMock.campaignRun.count.mock.calls[0][0];
    expect(countCall.where.orgId).toBe('org-1');
  });

  it('thiếu RUNNING trong groupBy → running = 0', async () => {
    prismaMock.campaignRun.groupBy.mockImplementation(async () => [
      { status: 'DONE', _count: 6 },
    ]);
    const s = await getBrokerSummary('org-1');
    expect(s.runs).toEqual({ total: 6, running: 0 });
  });
});

// ── Error ─────────────────────────────────────────────────────────────────────
describe('getBrokerSummary — errors', () => {
  it('thiếu orgId → BrokerDashboardError 400 ORG_ID_REQUIRED', async () => {
    await expect(getBrokerSummary('')).rejects.toThrow(BrokerDashboardError);
    await expect(getBrokerSummary('')).rejects.toMatchObject({
      status: 400,
      code: 'ORG_ID_REQUIRED',
    });
    expect(prismaMock.contact.count).not.toHaveBeenCalled();
  });
});

// ── Route ─────────────────────────────────────────────────────────────────────
describe('GET /api/v1/dashboard/broker/summary', () => {
  function buildApp(): FastifyInstance {
    const app = Fastify({ logger: false });
    app.register(registerBrokerDashboardRoutes);
    return app;
  }

  it('trả 200 + đúng shape tổng hợp, scope orgId từ JWT', async () => {
    const res = await buildApp().inject({ method: 'GET', url: '/api/v1/dashboard/broker/summary' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    expect(body.contacts.total).toBe(10);
    expect(body.contacts.newToday).toBe(2);
    expect(body.contacts.byRating).toEqual({ A: 3, B: 0, C: 0, D: 0, UNRATED: 7 });
    expect(body.contacts.withInterests).toBe(2);

    expect(body.properties.total).toBe(25);
    expect(body.properties.byStatus.AVAILABLE).toBe(15);
    expect(body.properties.byProject[0]).toEqual({
      projectId: 'p1',
      projectName: 'Dự án Vinhomes Grand Park',
      total: 10,
      available: 8,
    });
    expect(body.properties.byAgency[0]).toEqual({
      agencyId: null,
      agencyName: 'Khac',
      total: 8,
      available: 6,
    });

    expect(body.campaigns).toEqual({ total: 8, running: 2, scheduled: 3, completed: 1 });
    expect(body.runs).toEqual({ total: 6, running: 2 });
  });

  it('prisma luôn được gọi với orgId của user (không leak cross-tenant)', async () => {
    await buildApp().inject({ method: 'GET', url: '/api/v1/dashboard/broker/summary' });
    for (const call of prismaMock.contact.count.mock.calls) {
      expect((call[0] as any).where.orgId).toBe('org-1');
    }
    for (const call of prismaMock.property.groupBy.mock.calls) {
      expect((call[0] as any).where.orgId).toBe('org-1');
    }
  });
});