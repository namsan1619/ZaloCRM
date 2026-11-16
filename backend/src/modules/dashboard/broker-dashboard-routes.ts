// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyen Tien Loc
/**
 * broker-dashboard-routes.ts — Dashboard tổng hợp môi giới (broker summary).
 *
 * Endpoints (đường dẫn tuyệt đối):
 *   GET /api/v1/dashboard/broker/summary
 *     → { contacts: { total, newToday, byRating, withInterests },
 *         properties: { total, byStatus, byProject, byAgency },
 *         campaigns: { total, running, scheduled, completed },
 *         runs: { total, running } }
 *
 * Toàn bộ số liệu scope theo orgId của user đăng nhập (multi-tenant) — xem
 * broker-dashboard-service.ts. Endpoint đọc thuần, không ghi activity log.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authMiddleware } from '../auth/auth-middleware.js';
import { logger } from '../../shared/utils/logger.js';
import { getBrokerSummary, BrokerDashboardError } from './broker-dashboard-service.js';

function isBrokerDashboardError(err: unknown): err is BrokerDashboardError {
  return err instanceof BrokerDashboardError;
}

export async function registerBrokerDashboardRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware);

  // GET /api/v1/dashboard/broker/summary
  app.get(
    '/api/v1/dashboard/broker/summary',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { orgId } = request.user!;
        return reply.send(await getBrokerSummary(orgId));
      } catch (err) {
        if (isBrokerDashboardError(err)) {
          return reply.status(err.status).send({ error: err.message, code: err.code });
        }
        logger.error('[broker-dashboard] summary error:', err);
        return reply
          .status(500)
          .send({ error: 'Failed to fetch broker dashboard summary', code: 'BROKER_SUMMARY_FAILED' });
      }
    },
  );
}
