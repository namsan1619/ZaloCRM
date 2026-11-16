// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyen Tien Loc
/**
 * interest-routes.ts — REST API cho ContactInterest (sản phẩm KH quan tâm).
 *
 * Endpoints (đường dẫn tuyệt đối):
 *   GET    /api/v1/contacts/:contactId/interests
 *          → { interests: [...] }  kèm property (kèm project) + project; mới nhất trước.
 *
 *   GET    /api/v1/contacts/:contactId/interests/suggestions?limit=5
 *          → { suggestions: [...] }  gợi ý căn (cùng loại + AVAILABLE, hoặc AVAILABLE
 *            mới nhất khi KH chưa quan tâm căn nào). Mỗi căn kèm project.name.
 *
 *   POST   /api/v1/contacts/:contactId/interests
 *          body { propertyId?, projectId?, interestCode?, note?, source? }
 *          → 201 { interest } khi tạo mới; 200 { interest } khi upsert (đã quan tâm căn đó).
 *          400 PROPERTY_OR_PROJECT_REQUIRED (thiếu cả propertyId lẫn projectId);
 *          404 CONTACT_NOT_FOUND.
 *
 *   PUT    /api/v1/interests/:id
 *          body { interestCode?, note? } → { interest } ; 404 INTEREST_NOT_FOUND.
 *
 *   DELETE /api/v1/interests/:id
 *          → { deleted: true } ; 404 INTEREST_NOT_FOUND.
 *
 * Mọi mutation ghi activity log fire-and-forget (interest_created / interest_updated /
 * interest_deleted). Ghi KHÔNG giới hạn role — sale thêm sản phẩm quan tâm ngay trong
 * tab CRM chat (đồng cấp với notes/tags CE), chỉ cần user đã đăng nhập trong org.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authMiddleware } from '../auth/auth-middleware.js';
import { logActivity } from '../activity/activity-logger.js';
import { logger } from '../../shared/utils/logger.js';
import {
  listInterests,
  createInterest,
  updateInterest,
  deleteInterest,
  suggestInterests,
  InterestError,
  SUGGEST_LIMIT_DEFAULT,
  type CreateInterestPayload,
  type UpdateInterestPayload,
} from './interest-service.js';

function isInterestError(err: unknown): err is InterestError {
  return err instanceof InterestError;
}

function parseLimit(raw: unknown): number {
  const parsed = typeof raw === 'string' ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(parsed) || parsed < 1) return SUGGEST_LIMIT_DEFAULT;
  return parsed;
}

export async function registerInterestRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware);

  // ── GET /api/v1/contacts/:contactId/interests ───────────────────────────
  app.get(
    '/api/v1/contacts/:contactId/interests',
    async (request: FastifyRequest<{ Params: { contactId: string } }>, reply: FastifyReply) => {
      const user = request.user!;
      const { contactId } = request.params;
      try {
        const interests = await listInterests(user.orgId, contactId);
        return reply.send({ interests });
      } catch (err) {
        if (isInterestError(err)) {
          return reply.status(err.status).send({ error: err.message, code: err.code });
        }
        logger.error('[interests] list error:', err);
        return reply.status(500).send({ error: 'Failed to list interests' });
      }
    },
  );

  // ── GET /api/v1/contacts/:contactId/interests/suggestions ───────────────
  app.get(
    '/api/v1/contacts/:contactId/interests/suggestions',
    async (
      request: FastifyRequest<{ Params: { contactId: string }; Querystring: { limit?: string } }>,
      reply: FastifyReply,
    ) => {
      const user = request.user!;
      const { contactId } = request.params;
      try {
        const suggestions = await suggestInterests(user.orgId, contactId, parseLimit(request.query.limit));
        return reply.send({ suggestions });
      } catch (err) {
        if (isInterestError(err)) {
          return reply.status(err.status).send({ error: err.message, code: err.code });
        }
        logger.error('[interests] suggestions error:', err);
        return reply.status(500).send({ error: 'Failed to build interest suggestions' });
      }
    },
  );

  // ── POST /api/v1/contacts/:contactId/interests ──────────────────────────
  app.post(
    '/api/v1/contacts/:contactId/interests',
    async (
      request: FastifyRequest<{ Params: { contactId: string }; Body: CreateInterestPayload }>,
      reply: FastifyReply,
    ) => {
      const user = request.user!;
      const { contactId } = request.params;
      try {
        const { interest, created } = await createInterest(
          user.orgId,
          contactId,
          user.id,
          request.body ?? {},
        );
        const row = interest as { id?: string; interestCode?: string; propertyId?: string | null; projectId?: string | null };
        logActivity({
          orgId: user.orgId,
          userId: user.id,
          action: created ? 'interest_created' : 'interest_updated',
          entityType: 'contactInterest',
          entityId: row.id ?? null,
          details: {
            contactId,
            propertyId: row.propertyId ?? null,
            projectId: row.projectId ?? null,
            interestCode: row.interestCode ?? null,
          },
        });
        return reply.status(created ? 201 : 200).send({ interest });
      } catch (err) {
        if (isInterestError(err)) {
          return reply.status(err.status).send({ error: err.message, code: err.code });
        }
        logger.error('[interests] create error:', err);
        return reply.status(500).send({ error: 'Failed to create interest' });
      }
    },
  );

  // ── PUT /api/v1/interests/:id ──────────────────────────────────────────
  app.put(
    '/api/v1/interests/:id',
    async (
      request: FastifyRequest<{ Params: { id: string }; Body: UpdateInterestPayload }>,
      reply: FastifyReply,
    ) => {
      const user = request.user!;
      const { id } = request.params;
      try {
        const interest = await updateInterest(user.orgId, id, request.body ?? {});
        const row = interest as { id?: string; interestCode?: string };
        logActivity({
          orgId: user.orgId,
          userId: user.id,
          action: 'interest_updated',
          entityType: 'contactInterest',
          entityId: row.id ?? id,
          details: { interestCode: row.interestCode ?? null },
        });
        return reply.send({ interest });
      } catch (err) {
        if (isInterestError(err)) {
          return reply.status(err.status).send({ error: err.message, code: err.code });
        }
        logger.error('[interests] update error:', err);
        return reply.status(500).send({ error: 'Failed to update interest' });
      }
    },
  );

  // ── DELETE /api/v1/interests/:id ───────────────────────────────────────
  app.delete(
    '/api/v1/interests/:id',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const user = request.user!;
      const { id } = request.params;
      try {
        const result = await deleteInterest(user.orgId, id);
        logActivity({
          orgId: user.orgId,
          userId: user.id,
          action: 'interest_deleted',
          entityType: 'contactInterest',
          entityId: id,
          details: { contactId: result.contactId },
        });
        return reply.send({ deleted: true });
      } catch (err) {
        if (isInterestError(err)) {
          return reply.status(err.status).send({ error: err.message, code: err.code });
        }
        logger.error('[interests] delete error:', err);
        return reply.status(500).send({ error: 'Failed to delete interest' });
      }
    },
  );
}
