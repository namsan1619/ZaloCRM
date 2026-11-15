// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyễn Tiến Lộc
/**
 * contact-import-routes.ts — Import hàng loạt SĐT KH (staging + worker nền).
 *
 * Endpoints (đường dẫn tuyệt đối /api/v1/... — KHÔNG register prefix):
 *   POST /api/v1/contacts/import/upload
 *        multipart: field 'file' (CSV/TXT/TSV/XLSX) + optional fields:
 *          - source      : nguồn KH (mặc định 'phone_import')
 *          - columnMap   : JSON { phone?: name|index, name?: name|index }
 *          - dryRun      : 'true' → trả preview (KHÔNG tạo job)
 *          - assignToCreator: 'true' → gán ContactAccess primary cho user upload
 *        Trả về: { jobId, fileName, totalRows?, preview? }
 *   GET  /api/v1/contacts/import/:jobId
 *        Tiến độ + counters: status, totalRows, processedRows, createdRows,
 *        duplicateRows, invalidRows, errorRows, progress (0-100), startedAt, finishedAt.
 *   GET  /api/v1/contacts/import/:jobId/errors
 *        CSV lỗi (invalid/error/duplicate). Sinh từ DB rows — không phụ thuộc disk.
 *   POST /api/v1/contacts/import/:jobId/cancel
 *        Hủy job đang chạy. Worker dừng ở chunk kế, KHÔNG tạo thêm contact.
 *
 * Upload khi KHÔNG có fastify-multipart: nhận JSON { fileBase64, fileName, ... }
 * (fallback middleware kiểm tra content-type).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../../shared/database/prisma-client.js';
import { authMiddleware } from '../auth/auth-middleware.js';
import { requireGrant } from '../rbac/rbac-middleware.js';
import { logger } from '../../shared/utils/logger.js';
import { config } from '../../config/index.js';
import { logActivity } from '../activity/activity-logger.js';
import { buildErrorCsv, previewImport, type ImportOptions } from './contact-import-service.js';
import { kickoffImportJob } from './contact-import-worker.js';

const MAX_FILE_SIZE = 200 * 1024 * 1024; // 200MB — 1M SĐT CSV ~ 15-30MB
const IMPORT_DIR = () => join(config.uploadDir, 'contact-import');

interface UploadBody {
  fileBase64?: string;
  fileName?: string;
  source?: string;
  columnMap?: ImportOptions['columnMap'];
  dryRun?: boolean;
  assignToCreator?: boolean;
}

/** Lưu buffer ra IMPORT_DIR với tên jobId.ext — trả path. */
function saveUploadBuffer(buffer: Buffer, jobId: string, fileName: string): string {
  const dir = IMPORT_DIR();
  mkdirSync(dir, { recursive: true });
  const ext = (fileName.includes('.') ? fileName.split('.').pop() : 'csv') ?? 'csv';
  const path = join(dir, `${jobId}.${ext}`);
  writeFileSync(path, buffer);
  return path;
}

export async function registerContactImportRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware);

  // ── POST /api/v1/contacts/import/upload ────────────────────────────────────
  app.post(
    '/api/v1/contacts/import/upload',
    { preHandler: requireGrant('contact', 'create') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user!;
      const userId = (user as { userId?: string }).userId ?? user.id;

      let fileName = 'contacts.csv';
      let buffer: Buffer | null = null;
      let source: string | undefined;
      let columnMap: ImportOptions['columnMap'] | undefined;
      let dryRun = false;
      let assignToCreator = false;

      try {
        const isMultipart = (request.headers['content-type'] ?? '').includes('multipart');
        if (isMultipart) {
          for await (const part of request.parts()) {
            if (part.type === 'field') {
              const val = String(part.value ?? '');
              if (part.fieldname === 'source') source = val || undefined;
              if (part.fieldname === 'columnMap' && val) {
                try { columnMap = JSON.parse(val) as ImportOptions['columnMap']; } catch { /* bỏ qua nếu JSON hỏng */ }
              }
              if (part.fieldname === 'dryRun') dryRun = val === 'true' || val === '1';
              if (part.fieldname === 'assignToCreator') assignToCreator = val === 'true' || val === '1';
              continue;
            }
            if (part.type !== 'file') continue;
            fileName = part.filename || fileName;
            const buf = await part.toBuffer();
            if (buf.length > MAX_FILE_SIZE) {
              return reply.status(413).send({ error: `File quá lớn (tối đa ${MAX_FILE_SIZE / 1024 / 1024}MB)` });
            }
            buffer = buf;
          }
        } else {
          // Fallback JSON base64 (khi không có fastify-multipart)
          const body = (request.body ?? {}) as UploadBody;
          if (typeof body.fileBase64 !== 'string' || !body.fileBase64) {
            return reply.status(400).send({ error: 'Thiếu file (multipart field "file" hoặc JSON "fileBase64")' });
          }
          buffer = Buffer.from(body.fileBase64, 'base64');
          if (buffer.length > MAX_FILE_SIZE) {
            return reply.status(413).send({ error: `File quá lớn (tối đa ${MAX_FILE_SIZE / 1024 / 1024}MB)` });
          }
          fileName = body.fileName || fileName;
          source = body.source;
          columnMap = body.columnMap;
          dryRun = body.dryRun === true;
          assignToCreator = body.assignToCreator === true;
        }
      } catch (err: any) {
        logger.error({ err }, '[contact-import] parse upload failed');
        return reply.status(400).send({ error: `Đọc file thất bại: ${err?.message ?? err}` });
      }

      if (!buffer) {
        return reply.status(400).send({ error: 'Không có file nào trong request' });
      }

      const opts: ImportOptions = {
        source,
        columnMap,
        assignToCreator,
      };

      // ── Dry-run: preview không ghi DB ──
      if (dryRun) {
        const filePath = saveUploadBuffer(buffer, `dryrun-${userId}-${Date.now()}`, fileName);
        try {
          const preview = await previewImport(filePath, user.orgId, opts);
          logActivity({
            orgId: user.orgId,
            userId,
            action: 'contact_import_preview',
            entityType: 'contact',
            details: { fileName, ...preview },
          });
          return preview;
        } catch (err: any) {
          logger.error({ err }, '[contact-import] dry-run failed');
          return reply.status(400).send({ error: `Không parse được file: ${err?.message ?? err}` });
        } finally {
          // Dọn file temp sau preview (best-effort)
          import('node:fs').then((fs) => fs.promises.unlink(filePath).catch(() => undefined));
        }
      }

      // ── Import thật: tạo job + lưu file → kick worker ──
      let jobId: string;
      try {
        const job = await prisma.contactImportJob.create({
          data: {
            orgId: user.orgId,
            fileName,
            status: 'pending',
            options: { source, columnMap, assignToCreator },
            createdById: userId,
          },
          select: { id: true },
        });
        jobId = job.id;
        // Lưu file (tên gắn jobId) rồi cập nhật options.filePath cho worker
        const finalPath = saveUploadBuffer(buffer, jobId, fileName);
        await prisma.contactImportJob.update({
          where: { id: jobId },
          data: { options: { source, columnMap, assignToCreator, filePath: finalPath } },
        });
      } catch (err: any) {
        logger.error({ err }, '[contact-import] tạo job failed');
        return reply.status(500).send({ error: `Không tạo được job: ${err?.message ?? err}` });
      }

      logActivity({
        orgId: user.orgId,
        userId,
        action: 'contact_import_upload',
        entityType: 'contact_import_job',
        entityId: jobId,
        details: { fileName, source: source ?? undefined },
      });

      kickoffImportJob(jobId); // fire-and-forget — worker xử lý ngay

      return reply.status(201).send({ jobId, fileName });
    },
  );

  // ── GET /api/v1/contacts/import/:jobId — progress + counters ──────────────
  app.get(
    '/api/v1/contacts/import/:jobId',
    { preHandler: requireGrant('contact', 'access') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user!;
      const { jobId } = request.params as { jobId: string };
      const job = await prisma.contactImportJob.findFirst({
        where: { id: jobId, orgId: user.orgId },
        select: {
          id: true,
          fileName: true,
          status: true,
          totalRows: true,
          processedRows: true,
          createdRows: true,
          duplicateRows: true,
          invalidRows: true,
          errorRows: true,
          errorFile: true,
          startedAt: true,
          finishedAt: true,
          createdAt: true,
          createdById: true,
        },
      });
      if (!job) return reply.status(404).send({ error: 'Không tìm thấy job import' });

      const progress =
        job.totalRows > 0 ? Math.round(((job.processedRows + job.invalidRows) / job.totalRows) * 100) : 0;

      return {
        ...job,
        progress: Math.min(100, Math.max(0, progress)),
        percentDone: job.status === 'done' ? 100 : progress,
      };
    },
  );

  // ── GET /api/v1/contacts/import/:jobId/errors — CSV lỗi ───────────────────
  app.get(
    '/api/v1/contacts/import/:jobId/errors',
    { preHandler: requireGrant('contact', 'access') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user!;
      const { jobId } = request.params as { jobId: string };
      const job = await prisma.contactImportJob.findFirst({
        where: { id: jobId, orgId: user.orgId },
        select: { id: true },
      });
      if (!job) return reply.status(404).send({ error: 'Không tìm thấy job import' });

      const errRows = await prisma.contactImportRow.findMany({
        where: { jobId, status: { in: ['invalid', 'error', 'duplicate'] } },
        orderBy: { rowIndex: 'asc' },
        select: { rowIndex: true, phoneRaw: true, nameRaw: true, status: true, errorReason: true },
        take: 100000,
      });
      const csv = buildErrorCsv(
        errRows.map((r) => ({
          rowIndex: r.rowIndex,
          phoneRaw: r.phoneRaw,
          nameRaw: r.nameRaw,
          status: r.status,
          errorReason: r.errorReason ?? null,
        })),
      );
      const full = errRows.length >= 100000
        ? `${csv}\n# LƯU Ý: job có hơn 100000 dòng lỗi — CSV này chỉ hiển thị 100000 dòng đầu.`
        : csv;
      reply.header('content-type', 'text/csv; charset=utf-8');
      reply.header('content-disposition', `attachment; filename="import-${jobId}-errors.csv"`);
      return full;
    },
  );

  // ── POST /api/v1/contacts/import/:jobId/cancel ────────────────────────────
  app.post(
    '/api/v1/contacts/import/:jobId/cancel',
    { preHandler: requireGrant('contact', 'edit') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user!;
      const { jobId } = request.params as { jobId: string };
      const job = await prisma.contactImportJob.findFirst({
        where: { id: jobId, orgId: user.orgId },
        select: { id: true, status: true },
      });
      if (!job) return reply.status(404).send({ error: 'Không tìm thấy job import' });
      if (job.status === 'done' || job.status === 'cancelled') {
        return { jobId, status: job.status, note: 'Job đã kết thúc, không hủy được' };
      }
      await prisma.contactImportJob.update({
        where: { id: jobId },
        data: { status: 'cancelled', finishedAt: new Date() },
      });
      logActivity({
        orgId: user.orgId,
        userId: user.id,
        action: 'contact_import_cancel',
        entityType: 'contact_import_job',
        entityId: jobId,
        details: {},
      });
      return { jobId, status: 'cancelled' };
    },
  );
}