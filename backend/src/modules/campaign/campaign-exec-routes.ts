// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyen Tien Loc
/**
 * campaign-exec-routes.ts — REST API cho đợt chạy chiến dịch THẬT (CampaignRun).
 *
 * BE chạy chiến dịch kết bạn / chăm sóc (Agent E). State machine:
 *   DRAFT → RUNNING ⇄ PAUSED → DONE | CANCELLED | FAILED
 *
 * Endpoints (đường dẫn tuyệt đối, không dùng prefix ở register):
 *   POST /api/v1/campaigns/:campaignId/runs         — tạo run (DRAFT)
 *        body { name, mode?, zaloAccountIds[], dailyFriendRequestLimit?,
 *               greetingScriptId?, careScriptIds?, careIntervalDays? }
 *   GET  /api/v1/campaigns/:campaignId/runs         — list run của campaign
 *   POST /api/v1/campaign-runs/:id/start            — DRAFT → RUNNING + FILL contacts
 *   POST /api/v1/campaign-runs/:id/pause            — RUNNING → PAUSED (409 RUN_NOT_RUNNING)
 *   POST /api/v1/campaign-runs/:id/resume           — PAUSED → RUNNING (409 RUN_NOT_PAUSED)
 *   POST /api/v1/campaign-runs/:id/cancel           — hoạt động → CANCELLED
 *   GET  /api/v1/campaign-runs/:id                  — detail + counts.byState + nickBudget
 *   GET  /api/v1/campaign-runs/:id/contacts         — phân trang contact (state/page/pageSize)
 *
 * RBAC: mọi thao tác GHI yêu cầu role owner/admin (pattern assertWritable);
 * đọc cho mọi user đã đăng nhập (authMiddleware). Mọi mutation ghi activity log
 * fire-and-forget (campaign_run_created/started/paused/resumed/cancelled).
 *
 * LƯU Ý wiring: KHÔNG tự đăng ký trong app.ts — controller / agent khác sẽ gọi
 * registerCampaignExecRoutes + startCampaignExecWorker khi gộp module.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authMiddleware } from '../auth/auth-middleware.js';
import { logActivity } from '../activity/activity-logger.js';
import { logger } from '../../shared/utils/logger.js';
import {
  CampaignExecError,
  createRun,
  startRun,
  pauseRun,
  resumeRun,
  cancelRun,
  getRunDetail,
  listRunContacts,
  listCampaignRuns,
  type CreateRunPayload,
} from './campaign-exec-service.js';

function isCampaignExecError(err: unknown): err is CampaignExecError {
  return err instanceof CampaignExecError;
}

/** Chỉ owner/admin được ghi (pattern assertWritable — master-data/campaign-script). */
function assertWritable(user: { role?: string }): void {
  if (!['owner', 'admin'].includes(user.role ?? '')) {
    throw new CampaignExecError(403, 'RBAC_FORBIDDEN', 'Chỉ owner/admin được thực hiện thao tác này');
  }
}

export async function registerCampaignExecRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware);

  // ── POST /campaigns/:campaignId/runs — tạo đợt chạy ──────────────────────
  app.post(
    '/api/v1/campaigns/:campaignId/runs',
    async (
      request: FastifyRequest<{ Params: { campaignId: string }; Body: CreateRunPayload }>,
      reply: FastifyReply,
    ) => {
      const user = request.user!;
      try {
        assertWritable(user);
        const run = await createRun({
          orgId: user.orgId,
          userId: user.id,
          campaignId: request.params.campaignId,
          payload: request.body ?? {},
        });
        logActivity({
          orgId: user.orgId,
          userId: user.id,
          action: 'campaign_run_created',
          entityType: 'campaignRun',
          entityId: run.id,
          details: { name: run.name, mode: run.mode, campaignId: run.campaignId },
        });
        return reply.status(201).send({ run });
      } catch (err) {
        if (isCampaignExecError(err)) {
          return reply.status(err.status).send({ error: err.message, code: err.code });
        }
        logger.error('[campaign-exec] create run error:', err);
        return reply.status(500).send({ error: 'create_run_failed' });
      }
    },
  );

  // ── GET /campaigns/:campaignId/runs — list run của campaign ──────────────
  app.get(
    '/api/v1/campaigns/:campaignId/runs',
    async (request: FastifyRequest<{ Params: { campaignId: string } }>, reply: FastifyReply) => {
      const user = request.user!;
      try {
        const runs = await listCampaignRuns(user.orgId, request.params.campaignId);
        return reply.send({ runs });
      } catch (err) {
        if (isCampaignExecError(err)) {
          return reply.status(err.status).send({ error: err.message, code: err.code });
        }
        logger.error('[campaign-exec] list runs error:', err);
        return reply.status(500).send({ error: 'list_runs_failed' });
      }
    },
  );

  // ── POST /campaign-runs/:id/start ────────────────────────────────────────
  app.post(
    '/api/v1/campaign-runs/:id/start',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const user = request.user!;
      try {
        assertWritable(user);
        const run = await startRun(user.orgId, request.params.id);
        logActivity({
          orgId: user.orgId,
          userId: user.id,
          action: 'campaign_run_started',
          entityType: 'campaignRun',
          entityId: run.id,
          details: { name: run.name, total: run.configuredTotal },
        });
        return reply.send({ run });
      } catch (err) {
        if (isCampaignExecError(err)) {
          return reply.status(err.status).send({ error: err.message, code: err.code });
        }
        logger.error('[campaign-exec] start run error:', err);
        return reply.status(500).send({ error: 'start_run_failed' });
      }
    },
  );

  // ── POST /campaign-runs/:id/pause ────────────────────────────────────────
  app.post(
    '/api/v1/campaign-runs/:id/pause',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const user = request.user!;
      try {
        assertWritable(user);
        const run = await pauseRun(user.orgId, request.params.id);
        logActivity({
          orgId: user.orgId,
          userId: user.id,
          action: 'campaign_run_paused',
          entityType: 'campaignRun',
          entityId: run.id,
          details: { name: run.name },
        });
        return reply.send({ run });
      } catch (err) {
        if (isCampaignExecError(err)) {
          return reply.status(err.status).send({ error: err.message, code: err.code });
        }
        logger.error('[campaign-exec] pause run error:', err);
        return reply.status(500).send({ error: 'pause_run_failed' });
      }
    },
  );

  // ── POST /campaign-runs/:id/resume ───────────────────────────────────────
  app.post(
    '/api/v1/campaign-runs/:id/resume',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const user = request.user!;
      try {
        assertWritable(user);
        const run = await resumeRun(user.orgId, request.params.id);
        logActivity({
          orgId: user.orgId,
          userId: user.id,
          action: 'campaign_run_resumed',
          entityType: 'campaignRun',
          entityId: run.id,
          details: { name: run.name },
        });
        return reply.send({ run });
      } catch (err) {
        if (isCampaignExecError(err)) {
          return reply.status(err.status).send({ error: err.message, code: err.code });
        }
        logger.error('[campaign-exec] resume run error:', err);
        return reply.status(500).send({ error: 'resume_run_failed' });
      }
    },
  );

  // ── POST /campaign-runs/:id/cancel ───────────────────────────────────────
  app.post(
    '/api/v1/campaign-runs/:id/cancel',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const user = request.user!;
      try {
        assertWritable(user);
        const run = await cancelRun(user.orgId, request.params.id);
        logActivity({
          orgId: user.orgId,
          userId: user.id,
          action: 'campaign_run_cancelled',
          entityType: 'campaignRun',
          entityId: run.id,
          details: { name: run.name },
        });
        return reply.send({ run });
      } catch (err) {
        if (isCampaignExecError(err)) {
          return reply.status(err.status).send({ error: err.message, code: err.code });
        }
        logger.error('[campaign-exec] cancel run error:', err);
        return reply.status(500).send({ error: 'cancel_run_failed' });
      }
    },
  );

  // ── GET /campaign-runs/:id — detail ──────────────────────────────────────
  app.get(
    '/api/v1/campaign-runs/:id',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const user = request.user!;
      try {
        const detail = await getRunDetail(user.orgId, request.params.id);
        return reply.send(detail);
      } catch (err) {
        if (isCampaignExecError(err)) {
          return reply.status(err.status).send({ error: err.message, code: err.code });
        }
        logger.error('[campaign-exec] get run error:', err);
        return reply.status(500).send({ error: 'get_run_failed' });
      }
    },
  );

  // ── GET /campaign-runs/:id/contacts — phân trang contact ─────────────────
  app.get(
    '/api/v1/campaign-runs/:id/contacts',
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Querystring: { state?: string; page?: string; pageSize?: string };
      }>,
      reply: FastifyReply,
    ) => {
      const user = request.user!;
      try {
        const q = request.query ?? {};
        const result = await listRunContacts(user.orgId, request.params.id, {
          state: q.state || undefined,
          page: q.page ? Number(q.page) : 1,
          pageSize: q.pageSize ? Number(q.pageSize) : 50,
        });
        return reply.send(result);
      } catch (err) {
        if (isCampaignExecError(err)) {
          return reply.status(err.status).send({ error: err.message, code: err.code });
        }
        logger.error('[campaign-exec] list run contacts error:', err);
        return reply.status(500).send({ error: 'list_contacts_failed' });
      }
    },
  );
}