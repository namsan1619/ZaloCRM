// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyễn Tiến Lộc
/**
 * master-data-routes.ts — REST API cho MasterData (danh mục dùng chung).
 *
 * Module nền cho KH + bảng hàng: nhóm danh mục (category) + mục danh mục (item)
 * theo org. Toàn bộ route đều yêu cầu auth (JWT).
 *
 * Endpoints (đường dẫn tuyệt đối, không dùng prefix ở register):
 *   GET    /api/v1/settings/master-data/categories
 *          → { categories: [{ id, orgId, key, label, icon, sortOrder, isSystem, createdAt, updatedAt }] }
 *          Lazy-ensure: tự seed 10 nhóm mặc định nếu org chưa có.
 *
 *   GET    /api/v1/settings/master-data/items?categoryKey=&q=&activeOnly=1
 *          → { items: [{ id, orgId, categoryId, code, label, parentCode, sortOrder, color, isActive, metadata, createdAt, updatedAt }] }
 *          categoryKey: lọc theo key nhóm; q: tìm theo code/label; activeOnly=1: chỉ item isActive.
 *
 *   POST   /api/v1/settings/master-data/items          (role owner/admin)
 *          body { categoryId|categoryKey, code, label, parentCode?, sortOrder?, color?, isActive?, metadata? }
 *          → { item } ; 409 DUPLICATE_CODE; 404 CATEGORY_NOT_FOUND
 *
 *   PUT    /api/v1/settings/master-data/items/:id      (role owner/admin)
 *          body { code?, label?, parentCode?, sortOrder?, color?, isActive?, metadata? }
 *          → { item } ; 404 ITEM_NOT_FOUND; 409 DUPLICATE_CODE
 *
 *   DELETE /api/v1/settings/master-data/items/:id      (role owner/admin)
 *          Chặn khi metadata.usedBy != null → 400 ITEM_IN_USE, hoặc còn mục con → 400 HAS_CHILDREN.
 *          → { deleted: true }
 *
 *   POST   /api/v1/settings/master-data/reorder        (role owner/admin)
 *          body { items: [{ id, sortOrder }] }
 *          → { updated: n }
 *
 * Mọi mutation ghi activity log fire-and-forget (master_data_created /
 * master_data_updated / master_data_deleted).
 *
 * RBAC: đọc cho mọi user đã đăng ký; ghi yêu cầu role owner/admin (chưa có
 * resource `master_data` trong permission-types.ts — khi thêm grant resource thì
 * thay check role bằng requireGrant('master_data', ...)).
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authMiddleware } from '../auth/auth-middleware.js';
import { logActivity } from '../activity/activity-logger.js';
import { logger } from '../../shared/utils/logger.js';
import { seedMasterDataCategories, seedMasterDataItems } from './master-data-seed.js';
import {
  listCategories,
  listItems,
  createItem,
  updateItem,
  deleteItem,
  reorderItems,
  MasterDataError,
  type CreateItemPayload,
  type UpdateItemPayload,
} from './master-data-service.js';

function isMasterDataError(err: unknown): err is MasterDataError {
  return err instanceof MasterDataError;
}

/** Chỉ owner/admin được ghi (thay requireRole — pattern status-routes). */
function assertWritable(user: { role?: string }): void {
  if (!['owner', 'admin'].includes(user.role ?? '')) {
    throw new MasterDataError(403, 'RBAC_FORBIDDEN', 'Chỉ owner/admin được thực hiện thao tác này');
  }
}

export async function registerMasterDataRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware);

  // ── GET /categories — danh sách nhóm danh mục (lazy seed) ──────────────
  app.get('/api/v1/settings/master-data/categories', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user!;
    // Lazy-ensure 10 nhóm mặc định + item mặc định — idempotent, an toàn gọi mỗi request.
    try {
      await seedMasterDataCategories(user.orgId);
      await seedMasterDataItems(user.orgId);
    } catch (err) {
      logger.error('[master-data] seed categories failed:', err);
      // Seed fail không chặn đọc — trả những gì đã có.
    }
    return reply.send({ categories: await listCategories(user.orgId) });
  });

  // ── GET /items — danh sách mục danh mục ────────────────────────────────
  app.get(
    '/api/v1/settings/master-data/items',
    async (request: FastifyRequest<{ Querystring: { categoryKey?: string; q?: string; activeOnly?: string } }>, reply: FastifyReply) => {
      const user = request.user!;
      const items = await listItems(user.orgId, {
        categoryKey: request.query.categoryKey,
        q: request.query.q,
        activeOnly: request.query.activeOnly === '1',
      });
      return reply.send({ items });
    },
  );

  // ── POST /items — tạo mục danh mục ─────────────────────────────────────
  app.post('/api/v1/settings/master-data/items', async (request: FastifyRequest<{ Body: CreateItemPayload }>, reply: FastifyReply) => {
    const user = request.user!;
    try {
      assertWritable(user);
      const item = await createItem(user.orgId, request.body ?? {});
      logActivity({
        orgId: user.orgId,
        userId: user.id,
        action: 'master_data_created',
        entityType: 'masterData',
        entityId: item.id,
        details: { code: item.code, label: item.label, categoryId: item.categoryId },
      });
      return reply.send({ item });
    } catch (err) {
      if (isMasterDataError(err)) {
        return reply.status(err.status).send({ error: err.message, code: err.code });
      }
      logger.error('[master-data] create item error:', err);
      return reply.status(500).send({ error: 'Failed to create master data item' });
    }
  });

  // ── PUT /items/:id — cập nhật mục danh mục ─────────────────────────────
  app.put('/api/v1/settings/master-data/items/:id', async (request: FastifyRequest<{ Params: { id: string }; Body: UpdateItemPayload }>, reply: FastifyReply) => {
    const user = request.user!;
    try {
      assertWritable(user);
      const item = await updateItem(user.orgId, request.params.id, request.body ?? {});
      logActivity({
        orgId: user.orgId,
        userId: user.id,
        action: 'master_data_updated',
        entityType: 'masterData',
        entityId: item.id,
        details: { code: item.code, label: item.label, categoryId: item.categoryId },
      });
      return reply.send({ item });
    } catch (err) {
      if (isMasterDataError(err)) {
        return reply.status(err.status).send({ error: err.message, code: err.code });
      }
      logger.error('[master-data] update item error:', err);
      return reply.status(500).send({ error: 'Failed to update master data item' });
    }
  });

  // ── DELETE /items/:id — xóa mục danh mục ───────────────────────────────
  app.delete('/api/v1/settings/master-data/items/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const user = request.user!;
    try {
      assertWritable(user);
      const result = await deleteItem(user.orgId, request.params.id);
      logActivity({
        orgId: user.orgId,
        userId: user.id,
        action: 'master_data_deleted',
        entityType: 'masterData',
        entityId: result.id,
        details: { itemId: result.id },
      });
      return reply.send({ deleted: true });
    } catch (err) {
      if (isMasterDataError(err)) {
        return reply.status(err.status).send({ error: err.message, code: err.code });
      }
      logger.error('[master-data] delete item error:', err);
      return reply.status(500).send({ error: 'Failed to delete master data item' });
    }
  });

  // ── POST /reorder — đổi thứ tự hiển thị ────────────────────────────────
  app.post('/api/v1/settings/master-data/reorder', async (request: FastifyRequest<{ Body: { items?: Array<{ id: string; sortOrder: number }> } }>, reply: FastifyReply) => {
    const user = request.user!;
    try {
      assertWritable(user);
      const items = request.body?.items;
      if (!Array.isArray(items) || items.length === 0) {
        return reply.status(400).send({ error: 'items array required', code: 'ITEMS_REQUIRED' });
      }
      for (const it of items) {
        if (!it || typeof it.id !== 'string' || typeof it.sortOrder !== 'number') {
          return reply.status(400).send({ error: 'items phải có id + sortOrder', code: 'INVALID_ITEM' });
        }
      }
      const updated = await reorderItems(user.orgId, items);
      return reply.send({ updated });
    } catch (err) {
      if (isMasterDataError(err)) {
        return reply.status(err.status).send({ error: err.message, code: err.code });
      }
      logger.error('[master-data] reorder error:', err);
      return reply.status(500).send({ error: 'Failed to reorder' });
    }
  });
}