// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyễn Tiến Lộc
/**
 * agency-routes.ts — CRUD Đại lý (Agency) /api/v1/agencies.
 * RBAC: requireGrant('property', ...) — resource 'property' (module Nguồn hàng).
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authMiddleware } from '../auth/auth-middleware.js';
import { requireGrant } from '../rbac/rbac-middleware.js';
import { logger } from '../../shared/utils/logger.js';
import { CrmError, parseIntInput } from './property-service.js';
import {
  createAgency,
  deleteAgency,
  getAgency,
  listAgencies,
  updateAgency,
  type AgencyInput,
} from './agency-service.js';
import { logActivity } from '../activity/activity-logger.js';

function sendError(reply: FastifyReply, err: unknown, tag: string): FastifyReply {
  if (err instanceof CrmError) {
    return reply.status(err.statusCode).send({ error: err.message, ...(err.details ?? {}) });
  }
  logger.error(`[${tag}] error:`, err);
  return reply.status(500).send({ error: 'Internal error' });
}

interface AgencyBody {
  code?: string;
  name?: string;
  phone?: string | null;
  contactName?: string | null;
  note?: string | null;
}

function toInput(body: AgencyBody): AgencyInput {
  return {
    code: body.code,
    name: body.name,
    phone: body.phone ?? null,
    contactName: body.contactName ?? null,
    note: body.note ?? null,
  };
}

export async function agencyRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware);

  // List đại lý
  app.get('/api/v1/agencies', { preHandler: requireGrant('property', 'access') }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const user = request.user!;
      const q = request.query as Record<string, string | undefined>;
      const result = await listAgencies(user.orgId, {
        q: q.q,
        includeInactive: q.includeInactive === 'true',
        page: parseIntInput(q.page, 'page', { min: 1 }) ?? undefined,
        pageSize: parseIntInput(q.pageSize, 'pageSize', { min: 1 }) ?? undefined,
      });
      return reply.send(result);
    } catch (err) {
      return sendError(reply, err, 'agency-list');
    }
  });

  // Create agency
  app.post('/api/v1/agencies', { preHandler: requireGrant('property', 'create') }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const user = request.user!;
      const created = await createAgency(user.orgId, toInput((request.body || {}) as AgencyBody));
      logActivity({
        orgId: user.orgId,
        userId: user.id,
        action: 'agency_create',
        entityType: 'agency',
        entityId: (created as { id: string }).id,
        details: { code: (created as { code?: string }).code, name: (created as { name?: string }).name },
      });
      return reply.status(201).send(created);
    } catch (err) {
      return sendError(reply, err, 'agency-create');
    }
  });

  // Get one
  app.get('/api/v1/agencies/:id', { preHandler: requireGrant('property', 'access') }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const user = request.user!;
      const { id } = request.params as { id: string };
      const item = await getAgency(user.orgId, id);
      return reply.send(item);
    } catch (err) {
      return sendError(reply, err, 'agency-get');
    }
  });

  // Update
  app.put('/api/v1/agencies/:id', { preHandler: requireGrant('property', 'edit') }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const user = request.user!;
      const { id } = request.params as { id: string };
      const updated = await updateAgency(user.orgId, id, toInput((request.body || {}) as AgencyBody));
      logActivity({
        orgId: user.orgId,
        userId: user.id,
        action: 'agency_update',
        entityType: 'agency',
        entityId: id,
      });
      return reply.send(updated);
    } catch (err) {
      return sendError(reply, err, 'agency-update');
    }
  });

  // Delete (soft)
  app.delete('/api/v1/agencies/:id', { preHandler: requireGrant('property', 'delete') }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const user = request.user!;
      const { id } = request.params as { id: string };
      const result = await deleteAgency(user.orgId, id);
      logActivity({
        orgId: user.orgId,
        userId: user.id,
        action: 'agency_delete',
        entityType: 'agency',
        entityId: id,
      });
      return reply.send(result);
    } catch (err) {
      return sendError(reply, err, 'agency-delete');
    }
  });
}