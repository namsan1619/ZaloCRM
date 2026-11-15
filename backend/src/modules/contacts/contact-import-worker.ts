// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyễn Tiến Lộc
/**
 * contact-import-worker.ts — Worker nền xử lý import 1 triệu SĐT KH.
 *
 * Pattern: giống list-enrichment-service.ts — setInterval tick + inFlight guard
 * + withTenant(orgId, fn) quanh mọi query org-scoped.
 *
 * Pipeline per job:
 *   1. Lấy job mới (status 'pending', thứ tự cũ trước) ở chế độ system (chưa biết org).
 *   2. Vào tenant scope: withTenant(job.orgId) → nếu chưa staged → stageImportRows()
 *      (đọc file → ContactImportRow theo lô).
 *   3. Vòng lặp theo CHUNK: lấy batch row 'pending' → dedup theo phoneNormalized
 *      với Contact hiện có → dòng mới: cấp mã KH (dải số) → createMany contact
 *      → link contactId về row → cập nhật job counters (processed/created/duplicate/invalid).
 *   4. Khi hết row pending → status 'done', finishedAt, ghi errors CSV (best-effort).
 *
 * Safety:
 *   - CHỈ 1 job xử lý tại 1 thời điểm (inFlight + activeJobIds) → tránh 2 job
 *     cùng lúc cấp dải mã KH chồng nhau (sequence vẫn atomic).
 *   - Cancel: worker check job.status mỗi chunk; 'cancelled' → dừng ngay.
 *   - Dedup trong file: first-wins theo phoneNormalized trong cùng batch.
 *   - Dedup với CRM: query existing contacts theo phoneNormalized (IN chunk).
 *   - createMany contact KHÔNG trả id → sau create, query lại theo customerCode
 *     (unique theo org) để map contactId về từng row.
 *   - Resume: tick cũng nhận job status='running' (sau crash) — tiếp tục từ row pending.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { prisma, tenantTransaction } from '../../shared/database/prisma-client.js';
import { logger } from '../../shared/utils/logger.js';
import { withTenant, runSystemQuery } from '../../shared/tenant/tenant-context.js';
import { config } from '../../config/index.js';
import { allocateCustomerCodes } from './contact-code-service.js';
import {
  IMPORT_SOURCE,
  stageImportRowsFromFile,
  buildErrorCsv,
  dedupImportRows,
  type ImportOptions,
} from './contact-import-service.js';

const CHUNK_SIZE = 500; // số row xử lý mỗi vòng lặp
const TICK_INTERVAL_MS = 5 * 1000; // 5s — job lớn cần tick nhanh hơn enrichment (30s)

let workerTimer: NodeJS.Timeout | null = null;
let inFlight = false;
const activeJobIds = new Set<string>();

/**
 * Kick worker xử lý ngay 1 job (caller: route upload sau khi tạo job).
 * Fire-and-forget — không block response.
 */
export function kickoffImportJob(jobId: string): void {
  void processImportJobById(jobId).catch((err) => {
    logger.error({ err, jobId }, '[contact-import] kickoff failed');
  });
}

/**
 * Xử lý 1 job theo id. Idempotent: gọi lại khi job đang 'running' → tiếp tục
 * từ những row còn 'pending'. Guard chống double-process cùng job.
 */
async function processImportJobById(jobId: string): Promise<void> {
  if (activeJobIds.has(jobId)) return;
  const job = await runSystemQuery(() =>
    prisma.contactImportJob.findUnique({
      where: { id: jobId },
      select: { id: true, orgId: true, status: true },
    }),
  );
  if (!job || job.status === 'done' || job.status === 'cancelled') return;

  activeJobIds.add(jobId);
  try {
    await withTenant(job.orgId, async () => {
      await processImportJobInTenant(jobId);
    });
  } finally {
    activeJobIds.delete(jobId);
  }
}

/**
 * Xử lý 1 job TRONG tenant scope. Được gọi từ kickoff hoặc worker tick.
 */
async function processImportJobInTenant(
  jobId: string,
): Promise<{ rowsProcessed: number; created: number; duplicate: number }> {
  const start = Date.now();
  let rowsProcessed = 0;
  let created = 0;
  let duplicate = 0;

  const job = await prisma.contactImportJob.findUnique({
    where: { id: jobId },
    select: {
      id: true,
      orgId: true,
      status: true,
      options: true,
      createdById: true,
    },
  });
  if (!job || job.status === 'done' || job.status === 'cancelled') {
    return { rowsProcessed, created, duplicate };
  }

  const opts = (job.options ?? {}) as ImportOptions & { filePath?: string; staged?: boolean };

  // ── Phase 1: staging (nếu chưa) ────────────────────────────────────────────
  if (!opts.staged) {
    if (!opts.filePath) {
      await failJob(jobId, 'stage_failed: thiếu options.filePath');
      return { rowsProcessed, created, duplicate };
    }
    try {
      // Streaming: đọc file theo dòng, ghi staging theo chunk — không nạp cả file vào RAM
      const { totalRows, invalidRows } = await stageImportRowsFromFile(jobId, opts.filePath, opts.columnMap);
      await prisma.contactImportJob.update({
        where: { id: jobId },
        data: {
          status: 'running',
          startedAt: new Date(),
          totalRows,
          invalidRows,
          options: { ...opts, staged: true } as object,
        },
      });
      logger.info({ jobId, totalRows, invalidRows }, '[contact-import] staged rows');
    } catch (err) {
      await failJob(jobId, `stage_failed: ${(err as Error).message}`);
      throw err;
    }
  } else if (job.status === 'pending') {
    await prisma.contactImportJob.update({
      where: { id: jobId },
      data: { status: 'running', startedAt: new Date() },
    }).catch(() => undefined);
  }

  // ── Phase 2: xử lý từng chunk row pending ─────────────────────────────────
  await processImportChunks(jobId, job.orgId, job.createdById, opts, (stat) => {
    rowsProcessed += stat.rowsProcessed;
    created += stat.created;
    duplicate += stat.duplicate;
  });

  logger.info(
    { jobId, rowsProcessed, created, duplicate, ms: Date.now() - start },
    '[contact-import] job done',
  );
  return { rowsProcessed, created, duplicate };
}

async function failJob(jobId: string, reason: string): Promise<void> {
  try {
    await prisma.contactImportJob.update({
      where: { id: jobId },
      data: { status: 'failed', finishedAt: new Date() },
    });
  } catch (err) {
    logger.error({ err, jobId }, '[contact-import] failJob update failed');
  }
  logger.error(`[contact-import] job=${jobId} failed: ${reason}`);
}

interface ChunkStat {
  rowsProcessed: number;
  created: number;
  duplicate: number;
  invalid: number;
  error: number;
}

/** Update status+contactId cho nhiều row trong 1 câu SQL (VALUES join). */
async function bulkUpdateImportRows(
  assignments: Array<{ id: string; status: string; contactId?: string | null; errorReason?: string | null }>,
): Promise<void> {
  if (assignments.length === 0) return;
  // Bảng mới dùng TEXT PK (xem migration 2026111502) — KHÔNG cast ::uuid.
  // contactId cũng là TEXT (TEXT PK của contacts trong cùng migration family).
  const values = assignments.map((a) => {
    const esc = (s: string) => `'${s.replace(/'/g, "''")}'`;
    return `(${esc(a.id)}, ${esc(a.status)}, ${a.contactId ? esc(a.contactId) : 'NULL'}, ${a.errorReason ? esc(a.errorReason) : 'NULL'})`;
  });
  // Raw SQL KHÔNG bị RLS-setconfig extension wrap (chỉ model op) → chạy trong
  // tenantTransaction để set app.current_org trên connection (mẫu contact-autotags-dirty.ts).
  await tenantTransaction((tx) =>
    tx.$executeRawUnsafe(`
      UPDATE contact_import_rows r
         SET status = v.status,
             contact_id = v.contact_id,
             error_reason = v.error_reason
        FROM (VALUES ${values.join(',')}) AS v(id, status, contact_id, error_reason)
       WHERE r.id = v.id
    `),
  );
}

/**
 * Vòng lặp xử lý row 'pending' theo CHUNK_SIZE. Dừng khi hết row hoặc job bị cancel.
 */
async function processImportChunks(
  jobId: string,
  orgId: string,
  createdById: string | null,
  opts: ImportOptions & { filePath?: string },
  onStat: (stat: ChunkStat) => void,
): Promise<void> {
  // Default Status của org (nếu có) để gắn statusId cho contact mới
  const defaultStatus = await prisma.status.findFirst({
    where: { orgId, isDefault: true },
    select: { id: true },
  }).catch(() => null);

  while (true) {
    const job = await prisma.contactImportJob.findUnique({
      where: { id: jobId },
      select: { id: true, status: true },
    });
    if (!job || job.status === 'cancelled') {
      logger.info(`[contact-import] job=${jobId} cancelled → dừng chunk loop`);
      return;
    }

    const rows = await prisma.contactImportRow.findMany({
      where: { jobId, status: 'pending' },
      orderBy: { rowIndex: 'asc' },
      take: CHUNK_SIZE,
      select: {
        id: true,
        rowIndex: true,
        phoneRaw: true,
        phoneNormalized: true,
        nameRaw: true,
        payload: true,
      },
    });
    if (rows.length === 0) break;

    const stat: ChunkStat = { rowsProcessed: rows.length, created: 0, duplicate: 0, invalid: 0, error: 0 };

    // ── 1. Tách invalid (phoneNormalized null — chỉ phòng thủ, staging đã lo) ──
    const invalidIds: string[] = [];
    const validRows = rows.filter((r) => {
      if (r.phoneNormalized) return true;
      invalidIds.push(r.id);
      stat.invalid++;
      return false;
    });
    if (invalidIds.length) {
      await prisma.contactImportRow.updateMany({
        where: { id: { in: invalidIds } },
        data: { status: 'invalid', errorReason: 'invalid_phone' },
      });
    }

    if (validRows.length > 0) {
      // ── 2+3. Dedup trong batch (first-wins) + với Contact CRM hiện có ──
      const phones = validRows.map((r) => r.phoneNormalized!).filter(Boolean);
      const existing = phones.length
        ? await prisma.contact.findMany({
            where: { orgId, phoneNormalized: { in: phones } },
            select: { id: true, phoneNormalized: true },
          })
        : [];
      const phoneToContact = new Map<string, string>();
      for (const c of existing) {
        if (c.phoneNormalized && !phoneToContact.has(c.phoneNormalized)) {
          phoneToContact.set(c.phoneNormalized, c.id);
        }
      }

      const dedup = dedupImportRows(
        validRows.map((r) => ({ id: r.id, phoneNormalized: r.phoneNormalized })),
        phoneToContact,
      );

      if (dedup.duplicatesInFile.length) {
        await prisma.contactImportRow.updateMany({
          where: { id: { in: dedup.duplicatesInFile } },
          data: { status: 'duplicate', errorReason: 'duplicate_in_file' },
        });
        stat.duplicate += dedup.duplicatesInFile.length;
      }
      if (dedup.duplicatesWithCrm.length) {
        await bulkUpdateImportRows(
          dedup.duplicatesWithCrm.map((d) => ({ id: d.id, status: 'duplicate', contactId: d.contactId, errorReason: 'duplicate_contact' })),
        );
        stat.duplicate += dedup.duplicatesWithCrm.length;
      }

      // Map id → row đầy đủ (để dựng Contact: phone, name, payload)
      const rowById = new Map(validRows.map((r) => [r.id, r]));
      const newRows = dedup.newRows
        .map((r) => rowById.get(r.id))
        .filter((r): r is NonNullable<typeof r> => Boolean(r));

      // ── 4. Tạo Contact mới: cấp mã KH theo lô + createMany ──
      if (newRows.length > 0) {
        let codes: string[] = [];
        try {
          codes = await allocateCustomerCodes(orgId, newRows.length);
        } catch (errCode) {
          // Không cấp được mã → đánh dấu error, không tạo contact thiếu mã
          await prisma.contactImportRow.updateMany({
            where: { id: { in: newRows.map((r) => r.id) } },
            data: { status: 'error', errorReason: `code_alloc_failed: ${(errCode as Error).message}` },
          });
          stat.error += newRows.length;
          onStat(stat);
          continue;
        }

        const contactsData = newRows.map((r, i) => ({
          orgId,
          phone: r.phoneRaw,
          phoneNormalized: r.phoneNormalized,
          fullName: r.nameRaw,
          source: opts.source || IMPORT_SOURCE,
          sourceDate: new Date(),
          status: 'new',
          statusId: defaultStatus?.id ?? null,
          customerCode: codes[i],
          ...(createdById ? { assignedUserId: createdById } : {}),
          metadata: {
            importJobId: jobId,
            rowIndex: r.rowIndex,
            ...((r.payload && typeof r.payload === 'object' && !Array.isArray(r.payload)
              ? (r.payload as Record<string, unknown>)
              : {})),
          },
          tags: [],
          consentStatus: 'implicit',
        }));

        // createdIds GIỮ ĐỘ DÀI bằng newRows (null = không map được) để index
        // của code tương ứng row — không filter sớm (lệch index → gắn sai contact).
        let createdIds: Array<string | null> = [];
        try {
          await tenantTransaction(async (tx) => {
            await tx.contact.createMany({ data: contactsData });
          });
          // createMany không trả id → query lại theo customerCode (unique org)
          const back = await prisma.contact.findMany({
            where: { orgId, customerCode: { in: codes } },
            select: { id: true, customerCode: true },
          });
          const codeToId = new Map(back.map((c) => [c.customerCode, c.id]));
          createdIds = codes.map((code) => codeToId.get(code) ?? null);
        } catch (errCreate) {
          await prisma.contactImportRow.updateMany({
            where: { id: { in: newRows.map((r) => r.id) } },
            data: { status: 'error', errorReason: `create_failed: ${(errCreate as Error).message}` },
          });
          stat.error += newRows.length;
          onStat(stat);
          continue;
        }

        // ── 5. Link contactId về row (1 câu SQL cho cả lô) ──
        const createdCount = createdIds.filter(Boolean).length;
        const linkAssignments = newRows.map((r, i) => {
          const contactId = createdIds[i];
          return {
            id: r.id,
            status: contactId ? ('created' as const) : ('error' as const),
            contactId: contactId ?? null,
            errorReason: contactId ? null : 'created_contact_not_found',
          };
        });
        await bulkUpdateImportRows(linkAssignments);
        stat.created += createdCount;
        stat.error += linkAssignments.length - createdCount;

        // ── 6. ContactAccess cho người tạo (nếu opts.assignToCreator) ──
        if (opts.assignToCreator && createdById && createdCount > 0) {
          await prisma.contactAccess.createMany({
            data: createdIds
              .filter((cid): cid is string => Boolean(cid))
              .map((cid) => ({
                orgId,
                contactId: cid,
                userId: createdById,
                role: 'primary' as const,
                source: 'import',
              })),
            skipDuplicates: true,
          }).catch((err) => {
            logger.warn({ err, jobId }, '[contact-import] ContactAccess createMany failed (non-blocking)');
          });
        }
      }
    }

    // ── 7. Cập nhật job counters ──
    await prisma.contactImportJob.update({
      where: { id: jobId },
      data: {
        processedRows: { increment: stat.rowsProcessed },
        createdRows: { increment: stat.created },
        duplicateRows: { increment: stat.duplicate },
        invalidRows: { increment: stat.invalid },
        errorRows: { increment: stat.error },
      },
    });

    onStat(stat);
  }

  // ── Kết thúc job ──
  await finalizeJob(jobId);
}

/** Ghi errors CSV xuống UPLOAD_DIR (best-effort) + set errorFile. */
async function finalizeJob(jobId: string): Promise<void> {
  const job = await prisma.contactImportJob.findUnique({
    where: { id: jobId },
    select: { id: true, status: true, orgId: true },
  });
  if (!job || job.status === 'cancelled') return;

  const errRows = await prisma.contactImportRow.findMany({
    where: { jobId, status: { in: ['invalid', 'error', 'duplicate'] } },
    orderBy: { rowIndex: 'asc' },
    select: { rowIndex: true, phoneRaw: true, nameRaw: true, status: true, errorReason: true },
    take: 100000, // cap 100k dòng lỗi trong preview CSV; route có thể gen đầy đủ
  });
  const csv = buildErrorCsv(errRows.map((r) => ({ ...r, errorReason: r.errorReason ?? null, nameRaw: r.nameRaw ?? null })));

  // Ghi file (nếu thư mục tạo được) — route GET errors vẫn tự gen CSV từ rows
  let errorFile: string | null = null;
  if (errRows.length > 0) {
    try {
      const dir = join(config.uploadDir, 'contact-import');
      mkdirSync(dir, { recursive: true });
      const filePath = join(dir, `${jobId}-errors.csv`);
      writeFileSync(filePath, csv, 'utf8');
      errorFile = filePath;
    } catch (err) {
      logger.warn({ err, jobId }, '[contact-import] ghi errors CSV file thất bại (fallback route gen từ rows)');
    }
  }

  await prisma.contactImportJob.update({
    where: { id: jobId },
    data: { status: 'done', finishedAt: new Date(), errorFile },
  });
  logger.info(
    { jobId, errorRows: errRows.length, orgId: job.orgId },
    '[contact-import] job finalized',
  );
}

/**
 * Worker tick — quét job 'pending'/'running' cross-org (system), xử lý lần lượt.
 * Nhận cả 'running' để resume sau crash (activeJobIds chống double-process).
 */
async function backgroundTick(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const candidates = await runSystemQuery(() =>
      prisma.contactImportJob.findMany({
        where: { status: { in: ['pending', 'running'] } },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
        take: 5,
      }),
    );
    for (const j of candidates) {
      if (!activeJobIds.has(j.id)) {
        await processImportJobById(j.id);
      }
    }
  } catch (err) {
    logger.error({ err }, '[contact-import] tick failed');
  } finally {
    inFlight = false;
  }
}

/**
 * Start worker scheduler. Idempotent. Gọi tại app boot (bên cạnh startListEnrichmentWorker).
 */
export function startContactImportWorker(): void {
  if (workerTimer) return;
  logger.info('[contact-import] worker starting (tick 5s)');
  workerTimer = setInterval(() => {
    void backgroundTick();
  }, TICK_INTERVAL_MS);
}

export function stopContactImportWorker(): void {
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
    logger.info('[contact-import] worker stopped');
  }
}