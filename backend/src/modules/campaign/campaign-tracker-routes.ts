// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyễn Tiến Lộc
/**
 * campaign-tracker-routes.ts — Tracker chiến dịch marketing (P4, KHÔNG gửi thật).
 *
 * CRUD + stats cho model Campaign (KHÁC AutomationCampaign EE):
 *   GET    /api/v1/campaigns              — list (filter status/channelCode/q, page/limit)
 *   POST   /api/v1/campaigns              — create {name, channelCode, startAt, endAt,
 *                                            costVnd, customerListIds[], projectIds[], script, note}
 *   GET    /api/v1/campaigns/:id          — detail
 *   PUT    /api/v1/campaigns/:id          — update (partial; replace links nếu cung cấp)
 *   DELETE /api/v1/campaigns/:id          — delete (cascade links)
 *   PATCH  /api/v1/campaigns/:id/status   — body {status: DRAFT|SCHEDULED|RUNNING|PAUSED|COMPLETED}
 *   GET    /api/v1/campaigns/:id/stats    — {totalContacts, friendRequestsSent, repliedContacts, conversionRate, ...}
 *
 * RBAC: resource 'broadcast' (Chiến dịch → /marketing/broadcasts) — resource hiện có,
 * mọi nhóm mặc định đều có access/create/edit/delete nên dùng được ngay.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authMiddleware } from '../auth/auth-middleware.js';
import { requireGrant } from '../rbac/rbac-middleware.js';
import { logActivity } from '../activity/activity-logger.js';
import { logger } from '../../shared/utils/logger.js';
import {
  listCampaigns,
  getCampaign,
  createCampaign,
  updateCampaign,
  deleteCampaign,
  setCampaignStatus,
  getCampaignStats,
} from './campaign-tracker-service.js';

type DateParse = { ok: true; value: Date | null } | { ok: false };
type CostParse = { ok: true; value: bigint | null } | { ok: false };

function parseDateInput(v: unknown): DateParse {
  if (v === null || v === undefined || v === '') return { ok: true, value: null };
  const d = typeof v === 'number' ? new Date(v) : new Date(String(v));
  if (Number.isNaN(d.getTime())) return { ok: false };
  return { ok: true, value: d };
}

function parseCostVnd(v: unknown): CostParse {
  if (v === null || v === undefined || v === '') return { ok: true, value: null };
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return { ok: false };
  return { ok: true, value: BigInt(n) };
}

function toIdsArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  return v.filter((x): x is string => typeof x === 'string' && x.length > 0);
}

interface CreateBody {
  name?: string;
  channelCode?: string;
  typeCode?: string;
  startAt?: unknown;
  endAt?: unknown;
  costVnd?: unknown;
  customerListIds?: unknown;
  projectIds?: unknown;
  script?: string;
  note?: string;
}

/**
 * Validate + chuẩn hoá body chiến dịch.
 * `requireName` = true cho POST (bắt buộc có tên); false cho PUT (partial update —
 * chỉ field có trong body mới được ghi đè, field vắng mặt giữ nguyên).
 */
function parseCampaignBody(
  body: unknown,
  requireName: boolean,
): { ok: true; value: any } | { ok: false; error: string } {
  const b = (body ?? {}) as CreateBody;
  const has = (k: keyof CreateBody) => Object.prototype.hasOwnProperty.call(b, k);

  if (requireName && !b.name?.trim()) return { ok: false, error: 'name_required' };
  if (has('name') && !b.name?.trim()) return { ok: false, error: 'name_required' };

  for (const k of ['channelCode', 'typeCode', 'script', 'note'] as const) {
    const v = b[k];
    if (has(k) && v !== null && v !== undefined && typeof v !== 'string') {
      return { ok: false, error: `invalid_${k}` };
    }
  }

  const value: any = {};
  if (has('name')) value.name = b.name!.trim();
  if (has('channelCode')) value.channelCode = b.channelCode?.trim() || null;
  if (has('typeCode')) value.typeCode = b.typeCode?.trim() || null;

  if (has('startAt')) {
    const startAt = parseDateInput(b.startAt);
    if (!startAt.ok) return { ok: false, error: 'invalid_startAt' };
    value.startAt = startAt.value;
  }
  if (has('endAt')) {
    const endAt = parseDateInput(b.endAt);
    if (!endAt.ok) return { ok: false, error: 'invalid_endAt' };
    value.endAt = endAt.value;
  }
  if (has('costVnd')) {
    const costVnd = parseCostVnd(b.costVnd);
    if (!costVnd.ok) return { ok: false, error: 'invalid_costVnd' };
    value.costVnd = costVnd.value;
  }
  if (has('customerListIds')) {
    const ids = toIdsArray(b.customerListIds);
    if (ids === null) return { ok: false, error: 'invalid_customerListIds' };
    value.customerListIds = ids;
  }
  if (has('projectIds')) {
    const ids = toIdsArray(b.projectIds);
    if (ids === null) return { ok: false, error: 'invalid_projectIds' };
    value.projectIds = ids;
  }
  if (has('script')) value.script = b.script?.trim() || null;
  if (has('note')) value.note = b.note?.trim() || null;

  // Create: mặc định danh sách rỗng (không gắn list nào)
  if (requireName) {
    value.customerListIds ??= [];
    value.projectIds ??= [];
  }
  return { ok: true, value };
}

export async function campaignTrackerRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware);

  // ── List ────────────────────────────────────────────────────────────────
  app.get(
    '/api/v1/campaigns',
    { preHandler: requireGrant('broadcast', 'access') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user!;
      const q = request.query as Record<string, string | undefined>;
      try {
        const limit = q.limit ? Number(q.limit) : undefined;
        // Nhận cả `page` (1-based) và `offset` — FE dùng page, API chung dùng offset.
        const offset = q.offset
          ? Number(q.offset)
          : q.page && limit
            ? (Math.max(1, Number(q.page)) - 1) * limit
            : undefined;
        const result = await listCampaigns(user.orgId, {
          status: q.status || undefined,
          channelCode: q.channelCode || undefined,
          q: q.q || undefined,
          limit,
          offset,
        });
        return reply.send(result);
      } catch (err) {
        logger.error('[campaign-tracker] list error:', err);
        return reply.status(500).send({ error: 'list_failed' });
      }
    },
  );

  // ── Create ──────────────────────────────────────────────────────────────
  app.post(
    '/api/v1/campaigns',
    { preHandler: requireGrant('broadcast', 'create') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user!;
      const parsed = parseCampaignBody(request.body, true);
      if (!parsed.ok) return reply.status(400).send({ error: parsed.error });

      try {
        const result = await createCampaign({
          orgId: user.orgId,
          userId: user.id,
          payload: parsed.value,
        });
        if (!result.ok) {
          return reply.status(400).send({
            error: result.error,
            ...(result.detailIds ? { detailIds: result.detailIds } : {}),
          });
        }
        logActivity({
          orgId: user.orgId,
          userId: user.id,
          action: 'campaign_create',
          entityType: 'campaign',
          entityId: result.campaign.id,
          details: { name: result.campaign.name },
        });
        return reply.status(201).send({ campaign: result.campaign });
      } catch (err) {
        logger.error('[campaign-tracker] create error:', err);
        return reply.status(500).send({ error: 'create_failed' });
      }
    },
  );

  // ── Detail ──────────────────────────────────────────────────────────────
  app.get(
    '/api/v1/campaigns/:id',
    { preHandler: requireGrant('broadcast', 'access') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user!;
      const { id } = request.params as { id: string };
      try {
        const campaign = await getCampaign(user.orgId, id);
        if (!campaign) return reply.status(404).send({ error: 'not_found' });
        return reply.send({ campaign });
      } catch (err) {
        logger.error('[campaign-tracker] get error:', err);
        return reply.status(500).send({ error: 'get_failed' });
      }
    },
  );

  // ── Update ──────────────────────────────────────────────────────────────
  app.put(
    '/api/v1/campaigns/:id',
    { preHandler: requireGrant('broadcast', 'edit') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user!;
      const { id } = request.params as { id: string };
      const parsed = parseCampaignBody(request.body, false);
      if (!parsed.ok) return reply.status(400).send({ error: parsed.error });

      try {
        const result = await updateCampaign({ orgId: user.orgId, id, payload: parsed.value });
        if (!result.ok) {
          const status = result.error === 'not_found' ? 404 : 400;
          return reply.status(status).send({
            error: result.error,
            ...(result.detailIds ? { detailIds: result.detailIds } : {}),
          });
        }
        logActivity({
          orgId: user.orgId,
          userId: user.id,
          action: 'campaign_update',
          entityType: 'campaign',
          entityId: result.campaign.id,
          details: { name: result.campaign.name },
        });
        return reply.send({ campaign: result.campaign });
      } catch (err) {
        logger.error('[campaign-tracker] update error:', err);
        return reply.status(500).send({ error: 'update_failed' });
      }
    },
  );

  // ── Delete ──────────────────────────────────────────────────────────────
  app.delete(
    '/api/v1/campaigns/:id',
    { preHandler: requireGrant('broadcast', 'delete') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user!;
      const { id } = request.params as { id: string };
      try {
        const result = await deleteCampaign(user.orgId, id);
        if (!result.ok) return reply.status(404).send({ error: result.error });
        logActivity({
          orgId: user.orgId,
          userId: user.id,
          action: 'campaign_delete',
          entityType: 'campaign',
          entityId: id,
        });
        return reply.send({ deleted: true });
      } catch (err) {
        logger.error('[campaign-tracker] delete error:', err);
        return reply.status(500).send({ error: 'delete_failed' });
      }
    },
  );

  // ── Status ──────────────────────────────────────────────────────────────
  app.patch(
    '/api/v1/campaigns/:id/status',
    { preHandler: requireGrant('broadcast', 'edit') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user!;
      const { id } = request.params as { id: string };
      const { status } = (request.body ?? {}) as { status?: string };
      if (!status?.trim()) return reply.status(400).send({ error: 'status_required' });

      try {
        const result = await setCampaignStatus(user.orgId, id, status.trim());
        if (!result.ok) {
          const code = result.error === 'not_found' ? 404 : 400;
          return reply.status(code).send({
            error: result.error,
            ...(result.allowed ? { allowed: result.allowed } : {}),
          });
        }
        logActivity({
          orgId: user.orgId,
          userId: user.id,
          action: 'campaign_status_change',
          entityType: 'campaign',
          entityId: id,
          details: { from: result.previousStatus, to: result.campaign.status },
        });
        return reply.send({ campaign: result.campaign });
      } catch (err) {
        logger.error('[campaign-tracker] status error:', err);
        return reply.status(500).send({ error: 'status_failed' });
      }
    },
  );

  // ── Stats ───────────────────────────────────────────────────────────────
  app.get(
    '/api/v1/campaigns/:id/stats',
    { preHandler: requireGrant('broadcast', 'access') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user!;
      const { id } = request.params as { id: string };
      try {
        const stats = await getCampaignStats(user.orgId, id);
        if (!stats) return reply.status(404).send({ error: 'not_found' });
        // Phẳng (không bọc { stats }) — FE đọc data.totalContacts / data.contacts trực tiếp.
        return reply.send(stats);
      } catch (err) {
        logger.error('[campaign-tracker] stats error:', err);
        return reply.status(500).send({ error: 'stats_failed' });
      }
    },
  );
}