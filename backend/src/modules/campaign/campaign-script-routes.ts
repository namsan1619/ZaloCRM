// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyễn Tiến Lộc
/**
 * campaign-script-routes.ts — REST API cho kịch bản tin nhắn chiến dịch.
 *
 * Kịch bản (CampaignScript) dùng cho 3 bước của chiến dịch: mời kết bạn →
 * lời chào khi kết bạn thành công → chuỗi chăm sóc. Mỗi đợt chạy
 * (CampaignRun) trỏ tới kịch bản qua `greetingScriptId` / `careScriptIds`.
 *
 * Endpoints (đường dẫn tuyệt đối, không dùng prefix ở register):
 *   GET    /api/v1/campaign-scripts?kind=&activeOnly=1
 *          → { scripts: [{ id, name, kind, content, mediaUrls, isActive, createdAt }] }
 *          Lazy-ensure: tự seed 3 kịch bản mặc định (1/kind) nếu org chưa có.
 *
 *   POST   /api/v1/campaign-scripts          (role owner/admin)
 *          body { name, kind, content, mediaUrls? }
 *          → { script } ; 400 (thiếu/sai field); 409 DUPLICATE_NAME
 *
 *   PUT    /api/v1/campaign-scripts/:id      (role owner/admin)
 *          body { name?, kind?, content?, mediaUrls?, isActive? }
 *          → { script } ; 404 SCRIPT_NOT_FOUND; 409 DUPLICATE_NAME
 *
 *   DELETE /api/v1/campaign-scripts/:id      (role owner/admin)
 *          → { deleted: true } ; 404 SCRIPT_NOT_FOUND; 409 IN_USE
 *          (IN_USE khi CampaignRun của org còn tham chiếu script)
 *
 * Mọi mutation ghi activity log fire-and-forget (campaign_script_created /
 * campaign_script_updated / campaign_script_deleted).
 *
 * RBAC: đọc cho mọi user đã đăng ký; ghi yêu cầu role owner/admin (pattern
 * assertWritable — như master-data; chưa có resource `campaign_script` trong
 * permission-types.ts nên check role trực tiếp).
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authMiddleware } from '../auth/auth-middleware.js';
import { logActivity } from '../activity/activity-logger.js';
import { logger } from '../../shared/utils/logger.js';
import {
  CampaignScriptError,
  ensureDefaultCampaignScripts,
  listScripts,
  createScript,
  updateScript,
  deleteScript,
  toScriptDto,
  type CreateScriptPayload,
  type UpdateScriptPayload,
} from './campaign-script-service.js';

function isCampaignScriptError(err: unknown): err is CampaignScriptError {
  return err instanceof CampaignScriptError;
}

/** Chỉ owner/admin được ghi (pattern assertWritable — master-data/status-routes). */
function assertWritable(user: { role?: string }): void {
  if (!['owner', 'admin'].includes(user.role ?? '')) {
    throw new CampaignScriptError(403, 'RBAC_FORBIDDEN', 'Chỉ owner/admin được thực hiện thao tác này');
  }
}

export async function registerCampaignScriptRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware);

  // ── GET /campaign-scripts — danh sách kịch bản (lazy seed mặc định) ─────
  app.get(
    '/api/v1/campaign-scripts',
    async (
      request: FastifyRequest<{ Querystring: { kind?: string; activeOnly?: string } }>,
      reply: FastifyReply,
    ) => {
      const user = request.user!;
      // Lazy-ensure 3 kịch bản mặc định (1/kind) — idempotent, an toàn gọi mỗi request.
      try {
        await ensureDefaultCampaignScripts(user.orgId);
      } catch (err) {
        logger.error('[campaign-script] seed default scripts failed:', err);
        // Seed fail không chặn đọc — trả những gì đã có.
      }
      try {
        const scripts = await listScripts(user.orgId, {
          kind: request.query.kind,
          activeOnly: request.query.activeOnly === '1',
        });
        return reply.send({ scripts });
      } catch (err) {
        if (isCampaignScriptError(err)) {
          return reply.status(err.status).send({ error: err.message, code: err.code });
        }
        logger.error('[campaign-script] list error:', err);
        return reply.status(500).send({ error: 'Failed to list campaign scripts' });
      }
    },
  );

  // ── POST /campaign-scripts — tạo kịch bản ────────────────────────────────
  app.post(
    '/api/v1/campaign-scripts',
    async (request: FastifyRequest<{ Body: CreateScriptPayload }>, reply: FastifyReply) => {
      const user = request.user!;
      try {
        assertWritable(user);
        const script = await createScript(user.orgId, user.id, request.body ?? {});
        logActivity({
          orgId: user.orgId,
          userId: user.id,
          action: 'campaign_script_created',
          entityType: 'campaignScript',
          entityId: script.id,
          details: { name: script.name, kind: script.kind },
        });
        return reply.send({ script: toScriptDto(script) });
      } catch (err) {
        if (isCampaignScriptError(err)) {
          return reply.status(err.status).send({ error: err.message, code: err.code });
        }
        logger.error('[campaign-script] create error:', err);
        return reply.status(500).send({ error: 'Failed to create campaign script' });
      }
    },
  );

  // ── PUT /campaign-scripts/:id — cập nhật kịch bản ───────────────────────
  app.put(
    '/api/v1/campaign-scripts/:id',
    async (
      request: FastifyRequest<{ Params: { id: string }; Body: UpdateScriptPayload }>,
      reply: FastifyReply,
    ) => {
      const user = request.user!;
      try {
        assertWritable(user);
        const script = await updateScript(user.orgId, request.params.id, request.body ?? {});
        logActivity({
          orgId: user.orgId,
          userId: user.id,
          action: 'campaign_script_updated',
          entityType: 'campaignScript',
          entityId: script.id,
          details: { name: script.name, kind: script.kind },
        });
        return reply.send({ script: toScriptDto(script) });
      } catch (err) {
        if (isCampaignScriptError(err)) {
          return reply.status(err.status).send({ error: err.message, code: err.code });
        }
        logger.error('[campaign-script] update error:', err);
        return reply.status(500).send({ error: 'Failed to update campaign script' });
      }
    },
  );

  // ── DELETE /campaign-scripts/:id — xóa kịch bản ──────────────────────────
  app.delete(
    '/api/v1/campaign-scripts/:id',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const user = request.user!;
      try {
        assertWritable(user);
        const result = await deleteScript(user.orgId, request.params.id);
        logActivity({
          orgId: user.orgId,
          userId: user.id,
          action: 'campaign_script_deleted',
          entityType: 'campaignScript',
          entityId: result.id,
          details: { scriptId: result.id },
        });
        return reply.send({ deleted: true });
      } catch (err) {
        if (isCampaignScriptError(err)) {
          return reply.status(err.status).send({ error: err.message, code: err.code });
        }
        logger.error('[campaign-script] delete error:', err);
        return reply.status(500).send({ error: 'Failed to delete campaign script' });
      }
    },
  );
}
