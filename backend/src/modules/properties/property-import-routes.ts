// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyễn Tiến Lộc
/**
 * property-import-routes.ts — Import bảng hàng (CSV/XLSX) cho căn hộ.
 *
 *   POST /api/v1/properties/import/dry-run  — multipart (file + optional projectId/agencyId)
 *                                             → preview KHÔNG ghi DB
 *   POST /api/v1/properties/import          — multipart → upsert thật theo
 *                                             unique(orgId, projectId, unitCode)
 *
 * Multipart: field 'file' (bắt buộc), field 'projectId' / 'agencyId' (optional —
 * nếu có sẽ ghi đè việc resolve từ cột "Dự án"/"Mã đại lý" trong file).
 * File giới hạn 20MB. Chỉ nhận .csv/.xlsx.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authMiddleware } from '../auth/auth-middleware.js';
import { requireGrant } from '../rbac/rbac-middleware.js';
import { logger } from '../../shared/utils/logger.js';
import { CrmError } from './property-service.js';
import { parseImportFile, previewImport, runImport } from './property-import-service.js';
import { logActivity } from '../activity/activity-logger.js';

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 20MB

function sendError(reply: FastifyReply, err: unknown, tag: string): FastifyReply {
  if (err instanceof CrmError) {
    return reply.status(err.statusCode).send({ error: err.message, ...(err.details ?? {}) });
  }
  logger.error(`[${tag}] error:`, err);
  return reply.status(500).send({ error: 'Internal error' });
}

/** Đọc multipart: tìm field 'file' (duy nhất) + các field text. */
async function readUpload(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<{ buffer: Buffer; filename: string; projectId?: string; agencyId?: string } | null> {
  let buffer: Buffer | null = null;
  let filename = '';
  let projectId: string | undefined;
  let agencyId: string | undefined;
  try {
    for await (const part of request.parts()) {
      if (part.type === 'field') {
        if (part.fieldname === 'projectId' && part.value) projectId = String(part.value);
        if (part.fieldname === 'agencyId' && part.value) agencyId = String(part.value);
        continue;
      }
      if (part.type !== 'file') continue;
      if (buffer) {
        return reply.status(400).send({ error: 'Chỉ nhận 1 file mỗi lần import' }) as unknown as null;
      }
      filename = part.filename || '';
      const buf = await part.toBuffer();
      if (buf.length > MAX_UPLOAD_BYTES) {
        return reply.status(413).send({ error: 'File quá lớn (tối đa 20MB)' }) as unknown as null;
      }
      buffer = buf;
    }
  } catch (err) {
    logger.error('[property-import] multipart error:', err);
    return reply.status(400).send({ error: 'Không đọc được file upload' }) as unknown as null;
  }
  if (!buffer) {
    return reply.status(400).send({ error: 'Thiếu file upload (field name "file")' }) as unknown as null;
  }
  return { buffer, filename, projectId, agencyId };
}

export async function propertyImportRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware);

  // ── Dry-run: preview, không ghi DB ──────────────────────────────────────
  app.post('/api/v1/properties/import/dry-run', { preHandler: requireGrant('property', 'access') }, async (request: FastifyRequest, reply: FastifyReply) => {
    const upload = await readUpload(request, reply);
    if (!upload) return;
    try {
      const user = request.user!;
      const parsed = await parseImportFile(upload.buffer, upload.filename);
      const preview = await previewImport(
        { orgId: user.orgId, projectId: upload.projectId, agencyId: upload.agencyId },
        parsed,
      );
      return reply.send({ ok: true, fileName: upload.filename, skippedBlankRows: parsed.skippedBlankRows, ...preview });
    } catch (err) {
      return sendError(reply, err, 'property-import-dry-run');
    }
  });

  // ── Import thật ─────────────────────────────────────────────────────────
  app.post('/api/v1/properties/import', { preHandler: requireGrant('property', 'create') }, async (request: FastifyRequest, reply: FastifyReply) => {
    const upload = await readUpload(request, reply);
    if (!upload) return;
    try {
      const user = request.user!;
      const parsed = await parseImportFile(upload.buffer, upload.filename);
      const summary = await runImport(
        { orgId: user.orgId, projectId: upload.projectId, agencyId: upload.agencyId },
        parsed,
      );
      logActivity({
        orgId: user.orgId,
        userId: user.id,
        action: 'property_import',
        entityType: 'property',
        details: { fileName: upload.filename, ...summary },
      });
      return reply.send({ ok: true, fileName: upload.filename, skippedBlankRows: parsed.skippedBlankRows, ...summary });
    } catch (err) {
      return sendError(reply, err, 'property-import');
    }
  });
}