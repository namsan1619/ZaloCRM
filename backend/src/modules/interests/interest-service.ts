// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyen Tien Loc
/**
 * interest-service.ts — Business logic cho ContactInterest (sản phẩm KH quan tâm).
 *
 * Dùng cho CRM môi giới: gắn "căn / dự án khách quan tâm" vào 1 Contact.
 *   - Mỗi interest trỏ tới propertyId HOẶC projectId (1 trong 2, phải có ít nhất 1).
 *   - interestCode mặc định QUAN_TAM (MasterData category TRANG_THAI_QUAN_TAM).
 *   - Chống trùng theo (contactId + propertyId) → upsert: trả interest hiện có,
 *     cập nhật note/interestCode nếu body có gửi lên.
 *   - Gợi ý căn (suggestions): ưu tiên căn cùng propertyTypeCode với căn KH đang
 *     quan tâm + statusCode=AVAILABLE (loại trừ căn đã quan tâm); nếu KH chưa
 *     quan tâm căn nào → lấy căn AVAILABLE mới nhất.
 *
 * Mọi query scope theo orgId (multi-tenant). Không dùng zod — validate tay,
 * trả InterestError (status + code) để route map sang HTTP response
 * (cùng pattern MasterDataError ở master-data-service.ts).
 */

import { prisma } from '../../shared/database/prisma-client.js';

/* ── Constants ───────────────────────────────────────────────────────────── */

/** MasterData TRANG_THAI_QUAN_TAM — mặc định khi body không có interestCode. */
export const DEFAULT_INTEREST_CODE = 'QUAN_TAM';
const NOTE_MAX_LEN = 2000;
export const SUGGEST_LIMIT_DEFAULT = 5;
const SUGGEST_LIMIT_MAX = 20;

/* ── Types ───────────────────────────────────────────────────────────────── */

export interface CreateInterestPayload {
  propertyId?: string | null;
  projectId?: string | null;
  interestCode?: string | null;
  note?: string | null;
  source?: string | null;
}

export interface UpdateInterestPayload {
  interestCode?: string | null;
  note?: string | null;
}

/** Lỗi nghiệp vụ — route map `status` sang HTTP status code. */
export class InterestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'InterestError';
  }
}

/* ── Selects ─────────────────────────────────────────────────────────────── */

/** Field căn đủ dùng cho chip "căn quan tâm" + gợi ý (giá serialize về string). */
const PROPERTY_SELECT = {
  id: true,
  unitCode: true,
  propertyTypeCode: true,
  statusCode: true,
  zoneName: true,
  blockName: true,
  category: true,
  transactionType: true,
  priceVnd: true,
  priceRentVnd: true,
  usableAreaM2: true,
  bedrooms: true,
  bathrooms: true,
  project: { select: { id: true, name: true } },
};

/** Interest kèm căn (kèm project của căn) + project trực tiếp nếu interest trỏ project. */
const INTEREST_INCLUDE = {
  property: { select: PROPERTY_SELECT },
  project: { select: { id: true, name: true } },
};

/* ── Helpers ─────────────────────────────────────────────────────────────── */

function isInterestError(err: unknown): err is InterestError {
  return err instanceof InterestError;
}

/** BigInt price → string (JSON.stringify không nhận BigInt). */
function priceToString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value.toString();
  return String(value);
}

/** Đảm bảo row trả về client an toàn JSON (giá BigInt → string). */
export function serializeInterest<T extends { property?: unknown }>(row: T): T {
  const property = row.property as Record<string, unknown> | null | undefined;
  if (!property || typeof property !== 'object') return row;
  const { priceVnd, priceRentVnd, ...rest } = property;
  return {
    ...row,
    property: {
      ...rest,
      priceVnd: priceToString(priceVnd),
      priceRentVnd: priceToString(priceRentVnd),
    },
  };
}

/** Căn gợi ý → serialize giá về string (cùng contract với serializeInterest). */
function serializeSuggestedProperty<T extends Record<string, unknown>>(row: T): T {
  const { priceVnd, priceRentVnd, ...rest } = row;
  return {
    ...rest,
    priceVnd: priceToString(priceVnd),
    priceRentVnd: priceToString(priceRentVnd),
  } as unknown as T;
}

function trimmedOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
}

async function assertContactExists(orgId: string, contactId: string): Promise<void> {
  const contact = await prisma.contact.findFirst({
    where: { id: contactId, orgId },
    select: { id: true },
  });
  if (!contact) {
    throw new InterestError(404, 'CONTACT_NOT_FOUND', 'Contact không tồn tại trong org');
  }
}

/* ── Service ─────────────────────────────────────────────────────────────── */

/**
 * Danh sách sản phẩm KH quan tâm — kèm căn (kèm project) và project nếu có.
 * Mới nhất trước.
 */
export async function listInterests(orgId: string, contactId: string): Promise<unknown[]> {
  await assertContactExists(orgId, contactId);
  const rows = await prisma.contactInterest.findMany({
    where: { orgId, contactId },
    include: INTEREST_INCLUDE,
    orderBy: { createdAt: 'desc' },
  });
  return rows.map((row) => serializeInterest(row as unknown as { property?: unknown }));
}

/**
 * Tạo interest cho contact. Chống trùng theo (contactId + propertyId):
 * đã tồn tại → upsert (cập nhật note/interestCode theo body) và trả interest hiện có.
 * Trường hợp chỉ trỏ project → khoá trùng là (contactId + projectId).
 */
export async function createInterest(
  orgId: string,
  contactId: string,
  userId: string,
  input: CreateInterestPayload,
): Promise<{ interest: unknown; created: boolean }> {
  const propertyId = trimmedOrNull(input.propertyId);
  const projectId = trimmedOrNull(input.projectId);
  if (!propertyId && !projectId) {
    throw new InterestError(
      400,
      'PROPERTY_OR_PROJECT_REQUIRED',
      'Phải có propertyId hoặc projectId',
    );
  }

  await assertContactExists(orgId, contactId);

  const codeProvided = input.interestCode !== undefined && input.interestCode !== null;
  const interestCode = trimmedOrNull(input.interestCode) ?? DEFAULT_INTEREST_CODE;
  const noteProvided = input.note !== undefined && input.note !== null;
  const note = noteProvided ? String(input.note).trim().slice(0, NOTE_MAX_LEN) : null;
  const source = trimmedOrNull(input.source);

  // Khoá trùng: có propertyId → (contactId, propertyId); chỉ project → (contactId, projectId).
  const existing = await prisma.contactInterest.findFirst({
    where: propertyId
      ? { orgId, contactId, propertyId }
      : { orgId, contactId, projectId, propertyId: null },
    include: INTEREST_INCLUDE,
  });

  if (existing) {
    const updated = await prisma.contactInterest.update({
      where: { id: existing.id },
      data: {
        ...(noteProvided ? { note } : {}),
        ...(codeProvided ? { interestCode } : {}),
      },
      include: INTEREST_INCLUDE,
    });
    return { interest: serializeInterest(updated as unknown as { property?: unknown }), created: false };
  }

  const created = await prisma.contactInterest.create({
    data: {
      orgId,
      contactId,
      propertyId,
      projectId,
      interestCode,
      note,
      source,
      createdById: userId,
    },
    include: INTEREST_INCLUDE,
  });
  return { interest: serializeInterest(created as unknown as { property?: unknown }), created: true };
}

/** Cập nhật interestCode / note của 1 interest. */
export async function updateInterest(
  orgId: string,
  id: string,
  input: UpdateInterestPayload,
): Promise<unknown> {
  const existing = await prisma.contactInterest.findFirst({
    where: { id, orgId },
    select: { id: true },
  });
  if (!existing) {
    throw new InterestError(404, 'INTEREST_NOT_FOUND', 'Interest không tồn tại');
  }

  const data: Record<string, unknown> = {};
  if (input.interestCode !== undefined && input.interestCode !== null) {
    const code = trimmedOrNull(input.interestCode);
    if (!code) {
      throw new InterestError(400, 'INTEREST_CODE_REQUIRED', 'interestCode không được rỗng');
    }
    data.interestCode = code;
  }
  if (input.note !== undefined && input.note !== null) {
    data.note = String(input.note).trim().slice(0, NOTE_MAX_LEN);
  }

  const updated = await prisma.contactInterest.update({
    where: { id },
    data,
    include: INTEREST_INCLUDE,
  });
  return serializeInterest(updated as unknown as { property?: unknown });
}

/** Xoá 1 interest. */
export async function deleteInterest(
  orgId: string,
  id: string,
): Promise<{ id: string; contactId: string }> {
  const existing = await prisma.contactInterest.findFirst({
    where: { id, orgId },
    select: { id: true, contactId: true },
  });
  if (!existing) {
    throw new InterestError(404, 'INTEREST_NOT_FOUND', 'Interest không tồn tại');
  }
  await prisma.contactInterest.delete({ where: { id } });
  return existing;
}

/**
 * Gợi ý căn cho KH:
 *   - KH đang quan tâm căn nào → gợi ý căn KHÁC cùng propertyTypeCode + AVAILABLE,
 *     loại trừ căn đã quan tâm, mới cập nhật trước.
 *   - KH chưa quan tâm căn nào → gợi ý căn AVAILABLE mới nhất.
 */
export async function suggestInterests(
  orgId: string,
  contactId: string,
  limit: number = SUGGEST_LIMIT_DEFAULT,
): Promise<unknown[]> {
  await assertContactExists(orgId, contactId);

  const safeLimit = Math.min(Math.max(1, Math.trunc(limit) || SUGGEST_LIMIT_DEFAULT), SUGGEST_LIMIT_MAX);

  const interests = await prisma.contactInterest.findMany({
    where: { orgId, contactId, propertyId: { not: null } },
    select: {
      propertyId: true,
      property: { select: { propertyTypeCode: true } },
    },
  });

  const interestedIds = interests
    .map((i) => i.propertyId)
    .filter((id): id is string => !!id);
  const typeCodes = [
    ...new Set(
      interests
        .map((i) => i.property?.propertyTypeCode)
        .filter((code): code is string => !!code),
    ),
  ];

  const where = typeCodes.length
    ? {
        orgId,
        statusCode: 'AVAILABLE',
        isActive: true,
        propertyTypeCode: { in: typeCodes },
        ...(interestedIds.length ? { id: { notIn: interestedIds } } : {}),
      }
    : {
        orgId,
        statusCode: 'AVAILABLE',
        isActive: true,
      };

  const properties = await prisma.property.findMany({
    where,
    orderBy: { updatedAt: 'desc' },
    take: safeLimit,
    select: PROPERTY_SELECT,
  });
  return properties.map((row) => serializeSuggestedProperty(row as unknown as Record<string, unknown>));
}

export { isInterestError };
