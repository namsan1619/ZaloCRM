// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyễn Tiến Lộc
/**
 * agency-service.ts — Service layer cho Đại lý (Agency) trong module Nguồn hàng.
 * unique(orgId, code) — mã đại lý duy nhất trong org (mã lấy từ bảng hàng import).
 * Delete = soft (isActive=false) vì Property.agency onDelete=SetNull (hard delete
 * sẽ set agencyId=null hàng loạt — mất liên kết lịch sử).
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../../shared/database/prisma-client.js';
import { CrmError } from './property-service.js';

export interface AgencyInput {
  code?: string;
  name?: string;
  phone?: string | null;
  contactName?: string | null;
  note?: string | null;
}

export interface AgencyListFilters {
  q?: string;
  includeInactive?: boolean;
  page?: number;
  pageSize?: number;
}

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;

/** Mã đại lý: trim + uppercase để unique ổn định khi nhập tay vs import. */
export function normalizeAgencyCode(code: string): string {
  return code.trim().toUpperCase();
}

export async function listAgencies(
  orgId: string,
  f: AgencyListFilters,
): Promise<{ items: unknown[]; total: number; page: number; pageSize: number }> {
  const page = f.page && f.page > 0 ? f.page : 1;
  const pageSize = f.pageSize ? Math.min(Math.max(1, f.pageSize), MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE;
  const where: Prisma.AgencyWhereInput = { orgId };
  if (f.q && f.q.trim()) {
    const q = f.q.trim();
    where.OR = [
      { name: { contains: q, mode: 'insensitive' } },
      { code: { contains: q, mode: 'insensitive' } },
      { contactName: { contains: q, mode: 'insensitive' } },
      { phone: { contains: q, mode: 'insensitive' } },
    ];
  }
  if (!f.includeInactive) where.isActive = true;

  const [items, total] = await Promise.all([
    prisma.agency.findMany({
      where,
      include: { _count: { select: { properties: true } } },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.agency.count({ where }),
  ]);
  return { items: items as unknown[], total, page, pageSize };
}

export async function getAgency(orgId: string, id: string): Promise<unknown> {
  const item = await prisma.agency.findFirst({
    where: { id, orgId },
    include: { _count: { select: { properties: true } } },
  });
  if (!item) throw new CrmError(404, 'Đại lý không tồn tại');
  return item;
}

export async function createAgency(orgId: string, input: AgencyInput): Promise<unknown> {
  if (!input.code?.trim()) throw new CrmError(400, 'code (mã đại lý) required');
  if (!input.name?.trim()) throw new CrmError(400, 'name (tên đại lý) required');
  const data: Prisma.AgencyCreateInput = {
    org: { connect: { id: orgId } },
    code: normalizeAgencyCode(input.code),
    name: input.name!.trim(),
    ...(input.phone !== null && input.phone !== undefined ? { phone: input.phone } : {}),
    ...(input.contactName !== null && input.contactName !== undefined ? { contactName: input.contactName } : {}),
    ...(input.note !== null && input.note !== undefined ? { note: input.note } : {}),
  };
  try {
    return await prisma.agency.create({ data });
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') {
      throw new CrmError(409, 'Mã đại lý đã tồn tại', { code: 'AGENCY_DUPLICATE' });
    }
    throw err;
  }
}

export async function updateAgency(
  orgId: string,
  id: string,
  input: Partial<AgencyInput>,
): Promise<unknown> {
  const existing = await prisma.agency.findFirst({ where: { id, orgId } });
  if (!existing) throw new CrmError(404, 'Đại lý không tồn tại');
  if (input.code !== undefined && !input.code?.trim()) throw new CrmError(400, 'code (mã đại lý) required');
  if (input.name !== undefined && !input.name?.trim()) throw new CrmError(400, 'name (tên đại lý) required');
  const data: Prisma.AgencyUpdateInput = {
    ...(input.code !== null && input.code !== undefined ? { code: normalizeAgencyCode(input.code) } : {}),
    ...(input.name !== null && input.name !== undefined ? { name: input.name!.trim() } : {}),
    ...(input.phone !== null && input.phone !== undefined ? { phone: input.phone } : {}),
    ...(input.contactName !== null && input.contactName !== undefined ? { contactName: input.contactName } : {}),
    ...(input.note !== null && input.note !== undefined ? { note: input.note } : {}),
  };
  try {
    return await prisma.agency.update({ where: { id }, data });
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') {
      throw new CrmError(409, 'Mã đại lý đã tồn tại', { code: 'AGENCY_DUPLICATE' });
    }
    throw err;
  }
}

export async function deleteAgency(orgId: string, id: string): Promise<{ deleted: boolean; id: string }> {
  const existing = await prisma.agency.findFirst({ where: { id, orgId } });
  if (!existing) throw new CrmError(404, 'Đại lý không tồn tại');
  await prisma.agency.update({ where: { id }, data: { isActive: false } });
  return { deleted: true, id };
}

/**
 * Tìm đại lý theo mã (insensitive) trong org — dùng cho import bảng hàng
 * khi file có cột "Mã đại lý" nhưng user không chọn agencyId trước.
 */
export async function findAgencyByCode(orgId: string, code: string): Promise<{ id: string } | null> {
  if (!code?.trim()) return null;
  return prisma.agency.findFirst({
    where: { orgId, code: { equals: normalizeAgencyCode(code), mode: 'insensitive' } },
    select: { id: true },
  });
}
