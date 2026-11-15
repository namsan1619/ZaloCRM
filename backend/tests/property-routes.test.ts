// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyễn Tiến Lộc
/**
 * property-routes.test.ts — Test module Nguồn hàng (Property / Project / Agency + import).
 *
 * Mock ở boundary Prisma (kiểu org-branding-routes.test.ts): auth-middleware + rbac-middleware
 * + prisma-client + logger đều bị mock, handler thật chạy qua Fastify.inject().
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyMultipart from '@fastify/multipart';
import { mockUser } from './test-helpers.js';

// ── Hoisted mock state ────────────────────────────────────────────────────────
const state = vi.hoisted(() => ({
  grantAllowed: true,
  prisma: {
    property: {
      findMany: vi.fn(),
      count: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    project: {
      findMany: vi.fn(),
      count: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    agency: {
      findMany: vi.fn(),
      count: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    activityLog: { create: vi.fn().mockResolvedValue({ id: 'log-1' }) },
  },
}));

vi.mock('../src/shared/database/prisma-client.js', () => ({
  prisma: state.prisma,
  tenantTransaction: vi.fn(async (fn: (tx: typeof state.prisma) => Promise<unknown>) => fn(state.prisma)),
}));
vi.mock('../src/shared/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/modules/auth/auth-middleware.js', () => ({
  authMiddleware: async (req: any) => { req.user = mockUser(); },
}));
vi.mock('../src/modules/rbac/rbac-middleware.js', () => ({
  requireGrant: () => async (_req: any, reply: any) => {
    if (!state.grantAllowed) return reply.status(403).send({ error: 'forbidden' });
  },
}));

const { prisma } = await import('../src/shared/database/prisma-client.js');
const { propertyRoutes } = await import('../src/modules/properties/property-routes.js');
const { projectRoutes } = await import('../src/modules/properties/project-routes.js');
const { agencyRoutes } = await import('../src/modules/properties/agency-routes.js');
const {
  parsePriceText,
  parsePriceInput,
  normalizeUnitCode,
  serializeProperty,
  CrmError,
} = await import('../src/modules/properties/property-service.js');
const {
  parseCsv,
  normalizeHeader,
  mapRow,
  parseImportFile,
  previewImport,
  runImport,
} = await import('../src/modules/properties/property-import-service.js');
const { propertyImportRoutes } = await import(
  '../src/modules/properties/property-import-routes.js'
);

function buildApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  app.register(propertyRoutes);
  app.register(projectRoutes);
  app.register(agencyRoutes);
  return app;
}

/** App có multipart + import routes (Fastify.inject với multipart thật). */
function buildImportApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  app.register(fastifyMultipart);
  app.register(propertyImportRoutes);
  return app;
}

/** Dựng body multipart/form-data thủ công để inject. */
function multipartBody(
  file: { fieldname: string; filename: string; contentType: string; content: string },
  fields: Record<string, string> = {},
): { payload: string; headers: Record<string, string> } {
  const boundary = '----zaloCRMTestBoundary1234';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`,
    );
  }
  parts.push(
    `--${boundary}\r\nContent-Disposition: form-data; name="${file.fieldname}"; filename="${file.filename}"\r\n` +
      `Content-Type: ${file.contentType}\r\n\r\n${file.content}\r\n`,
  );
  parts.push(`--${boundary}--\r\n`);
  return {
    payload: parts.join(''),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.grantAllowed = true;
  (prisma.property.count as any).mockResolvedValue(0);
  (prisma.property.findMany as any).mockResolvedValue([]);
  (prisma.property.findFirst as any).mockResolvedValue(null);
  (prisma.project.findMany as any).mockResolvedValue([]);
  (prisma.project.count as any).mockResolvedValue(0);
  (prisma.project.findFirst as any).mockResolvedValue(null);
  (prisma.agency.findMany as any).mockResolvedValue([]);
  (prisma.agency.count as any).mockResolvedValue(0);
  (prisma.agency.findFirst as any).mockResolvedValue(null);
});

// ── Pure helpers ─────────────────────────────────────────────────────────────
describe('parsePriceText', () => {
  it('parses plain digits', () => {
    expect(parsePriceText('1200000000')).toBe(1_200_000_000n);
  });

  it('parses Vietnamese thousand separators', () => {
    expect(parsePriceText('1.200.000.000')).toBe(1_200_000_000n);
  });

  it('parses "tỷ" suffix', () => {
    expect(parsePriceText('2.5 tỷ')).toBe(2_500_000_000n);
  });

  it('parses attached unit ("850tr")', () => {
    expect(parsePriceText('850tr')).toBe(850_000_000n);
  });

  it('parses "triệu" suffix', () => {
    expect(parsePriceText('350 triệu')).toBe(350_000_000n);
  });

  it('does not treat ordinary words as unit', () => {
    expect(parsePriceText('abc')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(parsePriceText('')).toBeNull();
  });
});

describe('parsePriceInput', () => {
  it('accepts number', () => {
    expect(parsePriceInput(1000)).toBe(1000n);
  });

  it('accepts string', () => {
    expect(parsePriceInput('1.000')).toBe(1000n);
  });

  it('throws CrmError 400 for invalid string', () => {
    expect(() => parsePriceInput('xyz')).toThrow(CrmError);
    try {
      parsePriceInput('xyz');
    } catch (err) {
      expect((err as CrmError).statusCode).toBe(400);
    }
  });

  it('returns null for null', () => {
    expect(parsePriceInput(null)).toBeNull();
  });
});

describe('normalizeUnitCode', () => {
  it('trims and uppercases', () => {
    expect(normalizeUnitCode('  a1-101 ')).toBe('A1-101');
  });
});

describe('serializeProperty (BigInt → string)', () => {
  it('converts price fields to string', () => {
    const out = serializeProperty({ id: 'p1', priceVnd: 1200n, priceRentVnd: 300n } as any);
    expect(out.priceVnd).toBe('1200');
    expect(out.priceRentVnd).toBe('300');
  });

  it('keeps null prices as null', () => {
    const out = serializeProperty({ id: 'p1', priceVnd: null } as any);
    expect(out.priceVnd).toBeNull();
  });
});

describe('parseCsv', () => {
  it('parses simple rows', () => {
    expect(parseCsv('a,b\n1,2')).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('handles quoted fields with commas', () => {
    expect(parseCsv('a,b\n"x,y",2')).toEqual([['a', 'b'], ['x,y', '2']]);
  });

  it('handles escaped double quotes', () => {
    expect(parseCsv('a\n"he said ""hi"""')).toEqual([['a'], ['he said "hi"']]);
  });

  it('strips BOM', () => {
    expect(parseCsv('﻿a,b')[0]).toEqual(['a', 'b']);
  });
});

describe('normalizeHeader', () => {
  it('strips Vietnamese diacritics', () => {
    expect(normalizeHeader('Mã Căn')).toBe('ma can');
  });
});

describe('mapRow', () => {
  it('maps headers + parses price', () => {
    const { data, errors } = mapRow(
      ['Mã căn', 'Giá', 'Diện tích', 'Phòng ngủ'],
      ['A1-101', '2.5 tỷ', '85,5', '3'],
      2,
    );
    expect(errors).toEqual([]);
    expect(data.unitCode).toBe('A1-101');
    expect(data.priceVnd).toBe(2_500_000_000n);
    expect(data.usableAreaM2).toBe(85.5);
    expect(data.bedrooms).toBe(3);
  });

  it('errors when unit code missing', () => {
    const { errors } = mapRow(['Giá'], ['1000000'], 2);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain('mã căn');
  });

  it('errors when price unparseable', () => {
    const { errors } = mapRow(['Mã căn', 'Giá'], ['A1', 'abc'], 2);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain('priceVnd');
  });
});

// ── Property routes ──────────────────────────────────────────────────────────
describe('GET /api/v1/properties', () => {
  it('lists properties for org', async () => {
    (prisma.property.findMany as any).mockResolvedValue([
      { id: 'p1', unitCode: 'A1', priceVnd: 100n, project: { id: 'pr1', name: 'Dự án' } },
    ]);
    (prisma.property.count as any).mockResolvedValue(1);
    const res = await buildApp().inject({ method: 'GET', url: '/api/v1/properties' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.total).toBe(1);
    // BigInt phải ra string — không được throw khi JSON.stringify
    expect(body.items[0].priceVnd).toBe('100');
  });

  it('applies filters to where clause', async () => {
    const res = await buildApp().inject({
      method: 'GET',
      url: '/api/v1/properties?projectId=pr1&statusCode=AVAILABLE&q=A1',
    });
    expect(res.statusCode).toBe(200);
    const where = (prisma.property.findMany as any).mock.calls[0][0].where;
    expect(where.orgId).toBe('org-1');
    expect(where.projectId).toBe('pr1');
    expect(where.statusCode).toBe('AVAILABLE');
    expect(where.OR).toBeDefined();
  });

  it('rejects invalid priceMin with 400', async () => {
    const res = await buildApp().inject({ method: 'GET', url: '/api/v1/properties?priceMin=abc' });
    expect(res.statusCode).toBe(400);
  });

  it('returns 403 when grant denied', async () => {
    state.grantAllowed = false;
    const res = await buildApp().inject({ method: 'GET', url: '/api/v1/properties' });
    expect(res.statusCode).toBe(403);
  });
});

describe('POST /api/v1/properties', () => {
  it('creates property', async () => {
    (prisma.project.findFirst as any).mockResolvedValue({ id: 'pr1' });
    (prisma.property.create as any).mockResolvedValue({ id: 'p1', unitCode: 'A1-101', priceVnd: 1000n });
    const res = await buildApp().inject({
      method: 'POST',
      url: '/api/v1/properties',
      payload: { unitCode: 'A1-101', projectId: 'pr1', priceVnd: 1000 },
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).priceVnd).toBe('1000');
  });

  it('requires unitCode', async () => {
    const res = await buildApp().inject({
      method: 'POST',
      url: '/api/v1/properties',
      payload: { projectId: 'pr1' },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain('unitCode');
  });

  it('requires projectId', async () => {
    const res = await buildApp().inject({
      method: 'POST',
      url: '/api/v1/properties',
      payload: { unitCode: 'A1' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when project not in org', async () => {
    (prisma.project.findFirst as any).mockResolvedValue(null);
    const res = await buildApp().inject({
      method: 'POST',
      url: '/api/v1/properties',
      payload: { unitCode: 'A1', projectId: 'pr-other' },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain('Dự án');
  });

  it('returns 409 on duplicate unit code', async () => {
    (prisma.project.findFirst as any).mockResolvedValue({ id: 'pr1' });
    (prisma.property.create as any).mockRejectedValue({ code: 'P2002' });
    const res = await buildApp().inject({
      method: 'POST',
      url: '/api/v1/properties',
      payload: { unitCode: 'A1', projectId: 'pr1' },
    });
    expect(res.statusCode).toBe(409);
  });
});

describe('GET /api/v1/properties/:id', () => {
  it('returns property', async () => {
    (prisma.property.findFirst as any).mockResolvedValue({ id: 'p1', unitCode: 'A1', priceVnd: 5n });
    const res = await buildApp().inject({ method: 'GET', url: '/api/v1/properties/p1' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).priceVnd).toBe('5');
  });

  it('returns 404 when not found', async () => {
    const res = await buildApp().inject({ method: 'GET', url: '/api/v1/properties/nope' });
    expect(res.statusCode).toBe(404);
  });
});

describe('PUT /api/v1/properties/:id', () => {
  it('updates property', async () => {
    (prisma.property.findFirst as any).mockResolvedValue({ id: 'p1', unitCode: 'A1', projectId: 'pr1' });
    (prisma.property.update as any).mockResolvedValue({ id: 'p1', unitCode: 'A1', priceVnd: 9n });
    const res = await buildApp().inject({
      method: 'PUT',
      url: '/api/v1/properties/p1',
      payload: { priceVnd: 9 },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).priceVnd).toBe('9');
  });

  it('returns 404 when not found', async () => {
    const res = await buildApp().inject({ method: 'PUT', url: '/api/v1/properties/nope', payload: { note: 'x' } });
    expect(res.statusCode).toBe(404);
  });
});

describe('DELETE /api/v1/properties/:id', () => {
  it('soft deletes (isActive=false)', async () => {
    (prisma.property.findFirst as any).mockResolvedValue({ id: 'p1', unitCode: 'A1' });
    (prisma.property.update as any).mockResolvedValue({ id: 'p1', isActive: false });
    const res = await buildApp().inject({ method: 'DELETE', url: '/api/v1/properties/p1' });
    expect(res.statusCode).toBe(200);
    expect((prisma.property.update as any).mock.calls[0][0].data).toEqual({ isActive: false });
  });

  it('returns 404 when not found', async () => {
    const res = await buildApp().inject({ method: 'DELETE', url: '/api/v1/properties/nope' });
    expect(res.statusCode).toBe(404);
  });
});

// ── Compare ──────────────────────────────────────────────────────────────────
describe('GET /api/v1/properties/compare', () => {
  it('returns properties + minimal diff', async () => {
    (prisma.property.findMany as any).mockResolvedValue([
      { id: 'p1', unitCode: 'A1', priceVnd: 100n, bedrooms: 2 },
      { id: 'p2', unitCode: 'A2', priceVnd: 200n, bedrooms: 2 },
    ]);
    const res = await buildApp().inject({ method: 'GET', url: '/api/v1/properties/compare?ids=p1,p2' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.items).toHaveLength(2);
    // bedrooms giống nhau → không nằm trong diff
    expect(body.diff.map((d: any) => d.field)).toEqual(['unitCode', 'priceVnd']);
    const priceDiff = body.diff.find((d: any) => d.field === 'priceVnd');
    expect(priceDiff.values).toEqual({ p1: '100', p2: '200' });
  });

  it('requires at least 2 ids', async () => {
    const res = await buildApp().inject({ method: 'GET', url: '/api/v1/properties/compare?ids=p1' });
    expect(res.statusCode).toBe(400);
  });

  it('requires ids param', async () => {
    const res = await buildApp().inject({ method: 'GET', url: '/api/v1/properties/compare' });
    expect(res.statusCode).toBe(400);
  });
});

// ── Project routes ───────────────────────────────────────────────────────────
describe('POST /api/v1/projects', () => {
  it('creates project', async () => {
    (prisma.project.create as any).mockResolvedValue({ id: 'pr1', name: 'Dự án A' });
    const res = await buildApp().inject({
      method: 'POST',
      url: '/api/v1/projects',
      payload: { name: 'Dự án A' },
    });
    expect(res.statusCode).toBe(201);
  });

  it('requires name', async () => {
    const res = await buildApp().inject({ method: 'POST', url: '/api/v1/projects', payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it('returns 409 on duplicate name', async () => {
    (prisma.project.create as any).mockRejectedValue({ code: 'P2002' });
    const res = await buildApp().inject({
      method: 'POST',
      url: '/api/v1/projects',
      payload: { name: 'Dự án A' },
    });
    expect(res.statusCode).toBe(409);
  });
});

describe('GET /api/v1/projects', () => {
  it('lists projects', async () => {
    (prisma.project.findMany as any).mockResolvedValue([{ id: 'pr1', name: 'Dự án A' }]);
    (prisma.project.count as any).mockResolvedValue(1);
    const res = await buildApp().inject({ method: 'GET', url: '/api/v1/projects' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).total).toBe(1);
  });
});

describe('DELETE /api/v1/projects/:id', () => {
  it('soft deletes', async () => {
    (prisma.project.findFirst as any).mockResolvedValue({ id: 'pr1' });
    (prisma.project.update as any).mockResolvedValue({ id: 'pr1', isActive: false });
    const res = await buildApp().inject({ method: 'DELETE', url: '/api/v1/projects/pr1' });
    expect(res.statusCode).toBe(200);
    expect((prisma.project.update as any).mock.calls[0][0].data).toEqual({ isActive: false });
  });
});

// ── Agency routes ────────────────────────────────────────────────────────────
describe('POST /api/v1/agencies', () => {
  it('creates agency with normalized code', async () => {
    (prisma.agency.create as any).mockResolvedValue({ id: 'ag1', code: 'DL01', name: 'Đại lý 1' });
    const res = await buildApp().inject({
      method: 'POST',
      url: '/api/v1/agencies',
      payload: { code: 'dl01', name: 'Đại lý 1' },
    });
    expect(res.statusCode).toBe(201);
    expect((prisma.agency.create as any).mock.calls[0][0].data.code).toBe('DL01');
  });

  it('requires code', async () => {
    const res = await buildApp().inject({ method: 'POST', url: '/api/v1/agencies', payload: { name: 'x' } });
    expect(res.statusCode).toBe(400);
  });

  it('returns 409 on duplicate code', async () => {
    (prisma.agency.create as any).mockRejectedValue({ code: 'P2002' });
    const res = await buildApp().inject({
      method: 'POST',
      url: '/api/v1/agencies',
      payload: { code: 'DL01', name: 'x' },
    });
    expect(res.statusCode).toBe(409);
  });
});

describe('GET /api/v1/agencies', () => {
  it('lists agencies', async () => {
    (prisma.agency.findMany as any).mockResolvedValue([{ id: 'ag1', code: 'DL01' }]);
    (prisma.agency.count as any).mockResolvedValue(1);
    const res = await buildApp().inject({ method: 'GET', url: '/api/v1/agencies' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).total).toBe(1);
  });
});

// ── Import: parse file ───────────────────────────────────────────────────────
describe('parseImportFile', () => {
  it('parses CSV with header row', async () => {
    const csv = 'Mã căn,Dự án,Giá\nA1-101,Dự án A,2.5 tỷ\nA1-102,Dự án A,3 tỷ\n';
    const parsed = await parseImportFile(Buffer.from(csv, 'utf8'), 'bang-hang.csv');
    expect(parsed.headers).toEqual(['Mã căn', 'Dự án', 'Giá']);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0][0]).toBe('A1-101');
  });

  it('skips blank rows', async () => {
    const csv = 'Mã căn,Giá\nA1,1000\n,\nB2,2000\n';
    const parsed = await parseImportFile(Buffer.from(csv, 'utf8'), 'bang-hang.csv');
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.skippedBlankRows).toBe(1);
  });

  it('rejects unsupported extension', async () => {
    await expect(parseImportFile(Buffer.from('x'), 'bang-hang.pdf')).rejects.toThrow(CrmError);
  });

  it('rejects empty file', async () => {
    await expect(parseImportFile(Buffer.from(''), 'bang-hang.csv')).rejects.toThrow(CrmError);
  });
});

// ── Import: preview (dry-run, KHÔNG ghi DB) ─────────────────────────────────
describe('previewImport', () => {
  const csv = 'Mã căn,Dự án,Giá\nA1-101,Dự án A,2.5 tỷ\nA1-102,Dự án A,3 tỷ\n';

  beforeEach(() => {
    (prisma.project.findMany as any).mockResolvedValue([{ id: 'pr1', name: 'Dự án A' }]);
    (prisma.agency.findMany as any).mockResolvedValue([]);
    (prisma.property.findMany as any).mockResolvedValue([]);
  });

  it('counts willCreate without writing', async () => {
    const parsed = await parseImportFile(Buffer.from(csv, 'utf8'), 'bang-hang.csv');
    const preview = await previewImport({ orgId: 'org-1' }, parsed);
    expect(preview.totalRows).toBe(2);
    expect(preview.willCreate).toBe(2);
    expect(preview.willUpdate).toBe(0);
    expect(preview.invalidRows).toBe(0);
    // Không ghi DB
    expect(prisma.property.create).not.toHaveBeenCalled();
    expect(prisma.property.update).not.toHaveBeenCalled();
  });

  it('detects existing property as willUpdate', async () => {
    (prisma.property.findMany as any).mockResolvedValue([
      { id: 'p1', projectId: 'pr1', unitCode: 'A1-101' },
    ]);
    const parsed = await parseImportFile(Buffer.from(csv, 'utf8'), 'bang-hang.csv');
    const preview = await previewImport({ orgId: 'org-1' }, parsed);
    expect(preview.willUpdate).toBe(1);
    expect(preview.willCreate).toBe(1);
  });

  it('reports unknown project as invalid row', async () => {
    (prisma.project.findMany as any).mockResolvedValue([]);
    const parsed = await parseImportFile(Buffer.from(csv, 'utf8'), 'bang-hang.csv');
    const preview = await previewImport({ orgId: 'org-1' }, parsed);
    expect(preview.invalidRows).toBe(2);
    expect(preview.rows[0].action).toBe('error');
    expect(preview.rows[0].errors[0]).toContain('không tồn tại');
  });

  it('serializes price as string in preview rows', async () => {
    const parsed = await parseImportFile(Buffer.from(csv, 'utf8'), 'bang-hang.csv');
    const preview = await previewImport({ orgId: 'org-1' }, parsed);
    expect(preview.rows[0].priceVnd).toBe('2500000000');
  });
});

// ── Import: run (upsert theo unique org+project+unitCode) ───────────────────
describe('runImport', () => {
  const csv = 'Mã căn,Dự án,Giá\nA1-101,Dự án A,2.5 tỷ\nA1-102,Dự án A,3 tỷ\n';

  beforeEach(() => {
    (prisma.project.findMany as any).mockResolvedValue([{ id: 'pr1', name: 'Dự án A' }]);
    (prisma.agency.findMany as any).mockResolvedValue([]);
    (prisma.property.findFirst as any).mockResolvedValue(null);
    (prisma.property.create as any).mockResolvedValue({ id: 'p1' });
  });

  it('creates new properties', async () => {
    const parsed = await parseImportFile(Buffer.from(csv, 'utf8'), 'bang-hang.csv');
    const summary = await runImport({ orgId: 'org-1' }, parsed);
    expect(summary.created).toBe(2);
    expect(summary.updated).toBe(0);
    expect(summary.errorRows).toBe(0);
    // create dùng projectId resolve từ tên + unitCode normalize
    const createArg = (prisma.property.create as any).mock.calls[0][0].data;
    expect(createArg.projectId).toBe('pr1');
    expect(createArg.unitCode).toBe('A1-101');
    expect(createArg.priceVnd).toBe(2_500_000_000n);
  });

  it('updates existing property instead of duplicating', async () => {
    (prisma.property.findFirst as any).mockResolvedValue({ id: 'p-existing' });
    (prisma.property.update as any).mockResolvedValue({ id: 'p-existing' });
    const parsed = await parseImportFile(Buffer.from(csv, 'utf8'), 'bang-hang.csv');
    const summary = await runImport({ orgId: 'org-1' }, parsed);
    expect(summary.updated).toBe(2);
    expect(summary.created).toBe(0);
    expect(prisma.property.update).toHaveBeenCalled();
  });

  it('skips rows with invalid data and reports errors', async () => {
    const badCsv = 'Mã căn,Dự án,Giá\n,Dự án A,2.5 tỷ\nA1-102,Dự án A,3 tỷ\n';
    const parsed = await parseImportFile(Buffer.from(badCsv, 'utf8'), 'bang-hang.csv');
    const summary = await runImport({ orgId: 'org-1' }, parsed);
    expect(summary.errorRows).toBe(1);
    expect(summary.created).toBe(1);
    expect(summary.errors[0].rowNumber).toBe(2);
  });

  it('uses fixed projectId when provided (overrides file column)', async () => {
    const parsed = await parseImportFile(Buffer.from(csv, 'utf8'), 'bang-hang.csv');
    await runImport({ orgId: 'org-1', projectId: 'pr-fixed' }, parsed);
    expect((prisma.property.create as any).mock.calls[0][0].data.projectId).toBe('pr-fixed');
  });
});

// ── Import routes (multipart) ───────────────────────────────────────────────
describe('POST /api/v1/properties/import/dry-run', () => {
  it('returns preview without writing', async () => {
    (prisma.project.findMany as any).mockResolvedValue([{ id: 'pr1', name: 'Dự án A' }]);
    (prisma.agency.findMany as any).mockResolvedValue([]);
    (prisma.property.findMany as any).mockResolvedValue([]);
    const { payload, headers } = multipartBody({
      fieldname: 'file',
      filename: 'bang-hang.csv',
      contentType: 'text/csv',
      content: 'Mã căn,Dự án,Giá\nA1-101,Dự án A,2.5 tỷ\n',
    });
    const res = await buildImportApp().inject({
      method: 'POST',
      url: '/api/v1/properties/import/dry-run',
      payload,
      headers,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.willCreate).toBe(1);
    expect(body.rows[0].priceVnd).toBe('2500000000');
    expect(prisma.property.create).not.toHaveBeenCalled();
  });

  it('returns 400 when file missing', async () => {
    const res = await buildImportApp().inject({
      method: 'POST',
      url: '/api/v1/properties/import/dry-run',
      payload: '',
      headers: { 'content-type': 'multipart/form-data; boundary=----x' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /api/v1/properties/import', () => {
  it('imports and returns summary', async () => {
    (prisma.project.findMany as any).mockResolvedValue([{ id: 'pr1', name: 'Dự án A' }]);
    (prisma.agency.findMany as any).mockResolvedValue([]);
    (prisma.property.findFirst as any).mockResolvedValue(null);
    (prisma.property.create as any).mockResolvedValue({ id: 'p1' });
    const { payload, headers } = multipartBody({
      fieldname: 'file',
      filename: 'bang-hang.csv',
      contentType: 'text/csv',
      content: 'Mã căn,Dự án,Giá\nA1-101,Dự án A,2.5 tỷ\n',
    });
    const res = await buildImportApp().inject({
      method: 'POST',
      url: '/api/v1/properties/import',
      payload,
      headers,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.created).toBe(1);
    expect(body.errorRows).toBe(0);
  });
});
