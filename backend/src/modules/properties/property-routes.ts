// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyễn Tiến Lộc
/**
 * property-routes.ts — CRUD Căn (Property) + list filter + compare.
 *
 * Endpoints:
 *   GET    /api/v1/properties           — list (filter projectId, statusCode, agencyId,
 *                                        category, transactionType, priceMin, priceMax, q,
 *                                        includeInactive, page, pageSize)
 *   POST   /api/v1/properties           — create
 *   GET    /api/v1/properties/compare   — so sánh nhiều căn (?ids=a,b,c)
 *   GET    /api/v1/properties/:id       — chi tiết (kèm media)
 *   PUT    /api/v1/properties/:id       — update
 *   DELETE /api/v1/properties/:id       — soft delete (isActive=false)
 *
 * GIÁ (BigInt): priceVnd là BigInt trong DB. Response luôn trả price dưới dạng STRING
 * (xem property-service.serializeProperty) — JSON.stringify không nhận BigInt.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authMiddleware } from '../auth/auth-middleware.js';
import { requireGrant } from '../rbac/rbac-middleware.js';
import { logger } from '../../shared/utils/logger.js';
import {
  CrmError,
  compareProperties,
  createProperty,
  deleteProperty,
  getProperty,
  listProperties,
  parseFloatInput,
  parseIntInput,
  parsePriceInput,
  updateProperty,
  type PropertyInput,
} from './property-service.js';
import { logActivity } from '../activity/activity-logger.js';

function sendError(reply: FastifyReply, err: unknown, tag: string): FastifyReply {
  if (err instanceof CrmError) {
    return reply.status(err.statusCode).send({ error: err.message, ...(err.details ?? {}) });
  }
  logger.error(`[${tag}] error:`, err);
  return reply.status(500).send({ error: 'Internal error' });
}

interface PropertyBody {
  projectId?: string;
  agencyId?: string | null;
  unitCode?: string;
  zoneName?: string | null;
  blockName?: string | null;
  propertyTypeCode?: string | null;
  category?: string | null;
  transactionType?: string | null;
  statusCode?: string | null;
  statusNote?: string | null;
  floorNo?: unknown;
  totalFloors?: unknown;
  bedrooms?: unknown;
  bathrooms?: unknown;
  priceVnd?: unknown;
  priceRentVnd?: unknown;
  priceBasisCode?: string | null;
  priceNote?: string | null;
  priceTtsVnd?: unknown;
  priceHtlsVnd?: unknown;
  unitPriceTtsVnd?: unknown;
  specialMechanismCode?: string | null;
  usableAreaM2?: unknown;
  timTuongAreaM2?: unknown;
  landAreaM2?: unknown;
  constructionAreaM2?: unknown;
  frontageM?: unknown;
  depthM?: unknown;
  roadWidthM?: unknown;
  balconyDirectionCode?: string | null;
  viewCode?: string | null;
  directionCode?: string | null;
  landDirectionCode?: string | null;
  legalCode?: string | null;
  legalNote?: string | null;
  handoverCode?: string | null;
  furnitureCode?: string | null;
  handoverYear?: unknown;
  assignedUserId?: string | null;
  note?: string | null;
  attributes?: Record<string, unknown> | null;
}

/** Map body → PropertyInput. Field không có trong body → undefined (không update). */
function toInput(body: PropertyBody): Partial<PropertyInput> {
  const input: Partial<PropertyInput> = {
    ...(body.projectId !== undefined ? { projectId: body.projectId } : {}),
    ...(body.agencyId !== undefined ? { agencyId: body.agencyId } : {}),
    ...(body.unitCode !== undefined ? { unitCode: body.unitCode } : {}),
    ...(body.zoneName !== undefined ? { zoneName: body.zoneName } : {}),
    ...(body.blockName !== undefined ? { blockName: body.blockName } : {}),
    ...(body.propertyTypeCode !== undefined ? { propertyTypeCode: body.propertyTypeCode } : {}),
    ...(body.category !== undefined ? { category: body.category } : {}),
    ...(body.transactionType !== undefined ? { transactionType: body.transactionType } : {}),
    ...(body.statusCode !== undefined ? { statusCode: body.statusCode } : {}),
    ...(body.statusNote !== undefined ? { statusNote: body.statusNote } : {}),
    ...(body.floorNo !== undefined ? { floorNo: parseIntInput(body.floorNo, 'floorNo', { min: -50 }) } : {}),
    ...(body.totalFloors !== undefined ? { totalFloors: parseIntInput(body.totalFloors, 'totalFloors', { min: 0 }) } : {}),
    ...(body.bedrooms !== undefined ? { bedrooms: parseIntInput(body.bedrooms, 'bedrooms', { min: 0 }) } : {}),
    ...(body.bathrooms !== undefined ? { bathrooms: parseIntInput(body.bathrooms, 'bathrooms', { min: 0 }) } : {}),
    ...(body.priceVnd !== undefined ? { priceVnd: parsePriceInput(body.priceVnd, 'priceVnd') } : {}),
    ...(body.priceRentVnd !== undefined ? { priceRentVnd: parsePriceInput(body.priceRentVnd, 'priceRentVnd') } : {}),
    ...(body.priceBasisCode !== undefined ? { priceBasisCode: body.priceBasisCode } : {}),
    ...(body.priceNote !== undefined ? { priceNote: body.priceNote } : {}),
    ...(body.priceTtsVnd !== undefined ? { priceTtsVnd: parsePriceInput(body.priceTtsVnd, 'priceTtsVnd') } : {}),
    ...(body.priceHtlsVnd !== undefined ? { priceHtlsVnd: parsePriceInput(body.priceHtlsVnd, 'priceHtlsVnd') } : {}),
    ...(body.unitPriceTtsVnd !== undefined ? { unitPriceTtsVnd: parsePriceInput(body.unitPriceTtsVnd, 'unitPriceTtsVnd') } : {}),
    ...(body.specialMechanismCode !== undefined ? { specialMechanismCode: body.specialMechanismCode } : {}),
    ...(body.usableAreaM2 !== undefined ? { usableAreaM2: parseFloatInput(body.usableAreaM2, 'usableAreaM2') } : {}),
    ...(body.timTuongAreaM2 !== undefined ? { timTuongAreaM2: parseFloatInput(body.timTuongAreaM2, 'timTuongAreaM2') } : {}),
    ...(body.landAreaM2 !== undefined ? { landAreaM2: parseFloatInput(body.landAreaM2, 'landAreaM2') } : {}),
    ...(body.constructionAreaM2 !== undefined ? { constructionAreaM2: parseFloatInput(body.constructionAreaM2, 'constructionAreaM2') } : {}),
    ...(body.frontageM !== undefined ? { frontageM: parseFloatInput(body.frontageM, 'frontageM') } : {}),
    ...(body.depthM !== undefined ? { depthM: parseFloatInput(body.depthM, 'depthM') } : {}),
    ...(body.roadWidthM !== undefined ? { roadWidthM: parseFloatInput(body.roadWidthM, 'roadWidthM') } : {}),
    ...(body.balconyDirectionCode !== undefined ? { balconyDirectionCode: body.balconyDirectionCode } : {}),
    ...(body.viewCode !== undefined ? { viewCode: body.viewCode } : {}),
    ...(body.directionCode !== undefined ? { directionCode: body.directionCode } : {}),
    ...(body.landDirectionCode !== undefined ? { landDirectionCode: body.landDirectionCode } : {}),
    ...(body.legalCode !== undefined ? { legalCode: body.legalCode } : {}),
    ...(body.legalNote !== undefined ? { legalNote: body.legalNote } : {}),
    ...(body.handoverCode !== undefined ? { handoverCode: body.handoverCode } : {}),
    ...(body.furnitureCode !== undefined ? { furnitureCode: body.furnitureCode } : {}),
    ...(body.handoverYear !== undefined ? { handoverYear: parseIntInput(body.handoverYear, 'handoverYear', { min: 1900, max: 2100 }) } : {}),
    ...(body.assignedUserId !== undefined ? { assignedUserId: body.assignedUserId } : {}),
    ...(body.note !== undefined ? { note: body.note } : {}),
    ...(body.attributes !== undefined ? { attributes: body.attributes } : {}),
  };
  return input;
}

export async function propertyRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware);

  // ── List + filter ───────────────────────────────────────────────────────
  app.get('/api/v1/properties', { preHandler: requireGrant('property', 'access') }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const user = request.user!;
      const q = request.query as Record<string, string | undefined>;
      const result = await listProperties(user.orgId, {
        projectId: q.projectId,
        statusCode: q.statusCode,
        agencyId: q.agencyId,
        category: q.category,
        transactionType: q.transactionType,
        priceMin: q.priceMin ? parsePriceInput(q.priceMin, 'priceMin') ?? undefined : undefined,
        priceMax: q.priceMax ? parsePriceInput(q.priceMax, 'priceMax') ?? undefined : undefined,
        q: q.q,
        includeInactive: q.includeInactive === 'true',
        page: parseIntInput(q.page, 'page', { min: 1 }) ?? undefined,
        pageSize: parseIntInput(q.pageSize, 'pageSize', { min: 1 }) ?? undefined,
      });
      return reply.send(result);
    } catch (err) {
      return sendError(reply, err, 'property-list');
    }
  });

  // ── Compare (đăng ký TRƯỚC /:id để không bị bắt nhầm param) ─────────────
  app.get('/api/v1/properties/compare', { preHandler: requireGrant('property', 'access') }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const user = request.user!;
      const q = request.query as Record<string, string | undefined>;
      const ids = String(q.ids ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (ids.length === 0) {
        return reply.status(400).send({ error: 'ids required (vd: ?ids=a,b,c)' });
      }
      const result = await compareProperties(user.orgId, ids);
      return reply.send(result);
    } catch (err) {
      return sendError(reply, err, 'property-compare');
    }
  });

  // ── Create ──────────────────────────────────────────────────────────────
  app.post('/api/v1/properties', { preHandler: requireGrant('property', 'create') }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const user = request.user!;
      const body = (request.body || {}) as PropertyBody;
      if (!body.unitCode?.trim()) return reply.status(400).send({ error: 'unitCode (mã căn) required' });
      if (!body.projectId) return reply.status(400).send({ error: 'projectId required' });
      const created = await createProperty(user.orgId, toInput(body) as PropertyInput);
      logActivity({
        orgId: user.orgId,
        userId: user.id,
        action: 'property_create',
        entityType: 'property',
        entityId: (created as { id: string }).id,
        details: { unitCode: (created as { unitCode?: string }).unitCode, projectId: body.projectId },
      });
      return reply.status(201).send(created);
    } catch (err) {
      return sendError(reply, err, 'property-create');
    }
  });

  // ── Get one ─────────────────────────────────────────────────────────────
  app.get('/api/v1/properties/:id', { preHandler: requireGrant('property', 'access') }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const user = request.user!;
      const { id } = request.params as { id: string };
      const item = await getProperty(user.orgId, id);
      return reply.send(item);
    } catch (err) {
      return sendError(reply, err, 'property-get');
    }
  });

  // ── Update ─────────────────────────────────────────────────────────────
  app.put('/api/v1/properties/:id', { preHandler: requireGrant('property', 'edit') }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const user = request.user!;
      const { id } = request.params as { id: string };
      const updated = await updateProperty(user.orgId, id, toInput((request.body || {}) as PropertyBody));
      logActivity({
        orgId: user.orgId,
        userId: user.id,
        action: 'property_update',
        entityType: 'property',
        entityId: id,
      });
      return reply.send(updated);
    } catch (err) {
      return sendError(reply, err, 'property-update');
    }
  });

  // ── Delete (soft) ───────────────────────────────────────────────────────
  app.delete('/api/v1/properties/:id', { preHandler: requireGrant('property', 'delete') }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const user = request.user!;
      const { id } = request.params as { id: string };
      const result = await deleteProperty(user.orgId, id);
      logActivity({
        orgId: user.orgId,
        userId: user.id,
        action: 'property_delete',
        entityType: 'property',
        entityId: id,
      });
      return reply.send(result);
    } catch (err) {
      return sendError(reply, err, 'property-delete');
    }
  });
}
