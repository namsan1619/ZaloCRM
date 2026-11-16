// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyen Tien Loc
/**
 * rating-history-routes.ts — Lịch sử đánh giá KH (RatingHistory A/B/C/D).
 *
 *   GET /api/v1/contacts/:contactId/rating-history
 *       → { history: [{ id, fromCode, toCode, reason, changedByName, changedAt }] }
 *       - Mới nhất trước (changedAt desc).
 *       - changedByName = fullName của User ghi đánh giá (join qua changedById,
 *         không có relation Prisma nên join tay). Không tìm thấy user → null.
 *       - changedAt trả ISO string.
 *       - 404 nếu contact không tồn tại trong org.
 *
 * Đọc mở cho mọi user đã đăng ký trong org (không cần role check).
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../../shared/database/prisma-client.js';
import { authMiddleware } from '../auth/auth-middleware.js';
import { logger } from '../../shared/utils/logger.js';

export async function registerRatingHistoryRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware);

  // ── GET /api/v1/contacts/:contactId/rating-history ──────────────────────
  app.get(
    '/api/v1/contacts/:contactId/rating-history',
    async (
      request: FastifyRequest<{ Params: { contactId: string } }>,
      reply: FastifyReply,
    ) => {
      const user = request.user!;
      const { contactId } = request.params;
      try {
        const contact = await prisma.contact.findFirst({
          where: { id: contactId, orgId: user.orgId },
          select: { id: true },
        });
        if (!contact) {
          return reply.status(404).send({ error: 'Contact not found', code: 'CONTACT_NOT_FOUND' });
        }

        const rows = await prisma.ratingHistory.findMany({
          where: { orgId: user.orgId, contactId },
          orderBy: { changedAt: 'desc' },
          select: {
            id: true,
            fromCode: true,
            toCode: true,
            reason: true,
            changedById: true,
            changedAt: true,
          },
        });

        // Join tay User.fullName qua changedById (RatingHistory không có relation User).
        const userIds = [...new Set(rows.map((r) => r.changedById).filter((v): v is string => !!v))];
        const users = userIds.length
          ? await prisma.user.findMany({
              where: { id: { in: userIds } },
              select: { id: true, fullName: true },
            })
          : [];
        const nameById = new Map(users.map((u) => [u.id, u.fullName]));

        return {
          history: rows.map((r) => ({
            id: r.id,
            fromCode: r.fromCode,
            toCode: r.toCode,
            reason: r.reason,
            changedByName: r.changedById ? (nameById.get(r.changedById) ?? null) : null,
            changedAt: r.changedAt.toISOString(),
          })),
        };
      } catch (err) {
        logger.error('[rating-history] Get rating history error:', err);
        return reply.status(500).send({ error: 'Failed to fetch rating history' });
      }
    },
  );
}