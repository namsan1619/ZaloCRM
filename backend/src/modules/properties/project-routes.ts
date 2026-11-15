// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyễn Tiến Lộc
/**
 * project-routes.ts — CRUD Dự án (Project) /api/v1/projects.
 * RBAC: requireGrant('property', ...) — resource 'property' (phân quyền module Nguồn hàng).
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authMiddleware } from '../auth/auth-middleware.js';
import { requireGrant } from '../rbac/rbac-middleware.js';
import { logger } from '../../shared/utils/logger.js';
import {
  CrmError,
  parseIntInput,
} from './property-service.js';
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  parseHandoverYear,
  updateProject,
  type ProjectInput,
} from './project-service.js';
import { logActivity } from '../activity/activity-logger.js';

function sendError(reply: FastifyReply, err: unknown, tag: string): FastifyReply {
  if (err instanceof CrmError) {
    return reply.status(err.statusCode).send({ error: err.message, ...(err.details ?? {}) });
  }
  logger.error(`[${tag}] error:`, err);
  return reply.status(500).send({ error: 'Internal error' });
}

interface ProjectBody {
  name?: string;
  developer?: string | null;
  province?: string | null;
  district?: string | null;
  address?: string | null;
  handoverYear?: unknown;
  note?: string | null;
}

function toInput(body: ProjectBody): ProjectInput {
  return {
    name: body.name,
    developer: body.developer ?? null,
    province: body.province ?? null,
    district: body.district ?? null,
    address: body.address ?? null,
    handoverYear: parseHandoverYear(body.handoverYear),
    note: body.note ?? null,
  };
}

export async function projectRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware);

  // List dự án
  app.get('/api/v1/projects', { preHandler: requireGrant('property', 'access') }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const user = request.user!;
      const q = request.query as Record<string, string | undefined>;
      const result = await listProjects(user.orgId, {
        q: q.q,
        includeInactive: q.includeInactive === 'true',
        page: parseIntInput(q.page, 'page', { min: 1 }) ?? undefined,
        pageSize: parseIntInput(q.pageSize, 'pageSize', { min: 1 }) ?? undefined,
      });
      return reply.send(result);
    } catch (err) {
      return sendError(reply, err, 'project-list');
    }
  });

  // Create project
  app.post('/api/v1/projects', { preHandler: requireGrant('property', 'create') }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const user = request.user!;
      const created = await createProject(user.orgId, toInput((request.body || {}) as ProjectBody));
      logActivity({
        orgId: user.orgId,
        userId: user.id,
        action: 'project_create',
        entityType: 'project',
        entityId: (created as { id: string }).id,
        details: { name: (created as { name?: string }).name },
      });
      return reply.status(201).send(created);
    } catch (err) {
      return sendError(reply, err, 'project-create');
    }
  });

  // Get one
  app.get('/api/v1/projects/:id', { preHandler: requireGrant('property', 'access') }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const user = request.user!;
      const { id } = request.params as { id: string };
      const item = await getProject(user.orgId, id);
      return reply.send(item);
    } catch (err) {
      return sendError(reply, err, 'project-get');
    }
  });

  // Update
  app.put('/api/v1/projects/:id', { preHandler: requireGrant('property', 'edit') }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const user = request.user!;
      const { id } = request.params as { id: string };
      const updated = await updateProject(user.orgId, id, toInput((request.body || {}) as ProjectBody));
      logActivity({
        orgId: user.orgId,
        userId: user.id,
        action: 'project_update',
        entityType: 'project',
        entityId: id,
        details: { name: (request.body as ProjectBody)?.name ?? undefined },
      });
      return reply.send(updated);
    } catch (err) {
      return sendError(reply, err, 'project-update');
    }
  });

  // Delete (soft)
  app.delete('/api/v1/projects/:id', { preHandler: requireGrant('property', 'delete') }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const user = request.user!;
      const { id } = request.params as { id: string };
      const result = await deleteProject(user.orgId, id);
      logActivity({
        orgId: user.orgId,
        userId: user.id,
        action: 'project_delete',
        entityType: 'project',
        entityId: id,
      });
      return reply.send(result);
    } catch (err) {
      return sendError(reply, err, 'project-delete');
    }
  });
}