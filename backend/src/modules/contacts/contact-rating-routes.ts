// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyễn Tiến Lộc
/**
 * contact-rating-routes.ts — Đánh giá tay KH (rating A/B/C/D) cho CRM SĐT.
 *
 *   PUT /api/v1/contacts/:id/rating
 *       body: { ratingCode: string, ratingNote?: string }
 *       - ratingCode BẮT BUỘC — mã trong MasterData category TRANG_THAI_KH (cùng org).
 *       - ratingNote optional (≤ 2000 ký tự).
 *       - Ghi: ratingCode, ratingNote, ratedById=user, ratedAt=now.
 *       - RBAC: requireGrant('contact','edit') + assertContactEditable (scope sale).
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../../shared/database/prisma-client.js';
import { authMiddleware } from '../auth/auth-middleware.js';
import { requireGrant } from '../rbac/rbac-middleware.js';
import { assertContactEditable, assertContactVisible } from './contact-scope.js';
import { logActivity } from '../activity/activity-logger.js';

const MAX_NOTE_LEN = 2000;

export async function registerContactRatingRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware);

  app.put(
    '/api/v1/contacts/:id/rating',
    { preHandler: requireGrant('contact', 'edit') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user!;
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as { ratingCode?: string; ratingNote?: string };

      const ratingCode = typeof body.ratingCode === 'string' ? body.ratingCode.trim() : '';
      if (!ratingCode) {
        return reply.status(400).send({ error: 'ratingCode required' });
      }
      const ratingNote =
        body.ratingNote !== undefined && body.ratingNote !== null
          ? String(body.ratingNote).trim().slice(0, MAX_NOTE_LEN)
          : null;

      // Contact phải tồn tại trong org + user phải THẤY được
      const contact = await prisma.contact.findFirst({
        where: { id, orgId: user.orgId },
        select: { id: true },
      });
      if (!contact) {
        return reply.status(404).send({ error: 'Contact not found' });
      }
      const visible = await assertContactVisible({
        userId: user.id,
        orgId: user.orgId,
        legacyRole: user.role,
        contactId: id,
      });
      if (!visible) {
        return reply.status(404).send({ error: 'Contact not found' });
      }

      // Gate scope edit (giống PUT /contacts/:id)
      try {
        await assertContactEditable({
          userId: user.id,
          orgId: user.orgId,
          legacyRole: user.role,
          contactId: id,
        });
      } catch (permErr: any) {
        const code = permErr?.statusCode ?? 403;
        return reply.status(code).send({
          error: permErr?.code || 'CONTACT_EDIT_FORBIDDEN',
          message: permErr?.message || 'Không có quyền đánh giá KH này',
        });
      }

      // ratingCode phải là MasterData active thuộc category TRANG_THAI_KH của org
      const md = await prisma.masterData.findFirst({
        where: {
          code: ratingCode,
          isActive: true,
          category: { key: 'TRANG_THAI_KH', orgId: user.orgId },
        },
        select: { id: true, code: true, label: true },
      });
      if (!md) {
        return reply.status(400).send({
          error: 'ratingCode không hợp lệ',
          hint: 'ratingCode phải là mã đang active trong danh mục TRANG_THAI_KH (MasterData) của org',
        });
      }

      const now = new Date();
      const updated = await prisma.contact.update({
        where: { id },
        data: {
          ratingCode: md.code,
          ratingNote,
          ratedById: user.id,
          ratedAt: now,
        },
        select: {
          id: true,
          customerCode: true,
          fullName: true,
          ratingCode: true,
          ratingNote: true,
          ratedById: true,
          ratedAt: true,
        },
      });

      // Fire-and-forget log (action mới — yêu cầu register trong action-types.ts)
      logActivity({
        orgId: user.orgId,
        userId: user.id,
        action: 'contact_rating_change',
        category: 'customer_info',
        entityType: 'contact',
        entityId: id,
        details: { ratingCode: md.code, ratingNote, customerCode: updated.customerCode },
      });

      return updated;
    },
  );

  // ── GET /api/v1/contacts/:id/rating — đọc rating hiện tại (cho FE mở dialog) ──
  app.get(
    '/api/v1/contacts/:id/rating',
    { preHandler: requireGrant('contact', 'access') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user!;
      const { id } = request.params as { id: string };
      const contact = await prisma.contact.findFirst({
        where: { id, orgId: user.orgId },
        select: {
          id: true,
          customerCode: true,
          ratingCode: true,
          ratingNote: true,
          ratedById: true,
          ratedAt: true,
        },
      });
      if (!contact) return reply.status(404).send({ error: 'Contact not found' });
      return contact;
    },
  );

  // ── GET /api/v1/contacts/rating/options — danh sách mã rating hợp lệ ───────
  // Path tĩnh (2 segment) KHÔNG xung đột với /:id (1 segment) hay /:id/rating.
  app.get(
    '/api/v1/contacts/rating/options',
    { preHandler: requireGrant('contact', 'access') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user!;
      const items = await prisma.masterData.findMany({
        where: { isActive: true, category: { key: 'TRANG_THAI_KH', orgId: user.orgId } },
        select: { code: true, label: true, color: true, sortOrder: true },
        orderBy: { sortOrder: 'asc' },
      });
      return items;
    },
  );
}