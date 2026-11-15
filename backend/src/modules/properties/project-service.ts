// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyễn Tiến Lộc
/**
 * project-service.ts — Service layer cho Dự án (Project) trong module Nguồn hàng.
 * unique(orgId, name) — tên dự án duy nhất trong org. Delete = soft (isActive=false)
 * vì Property.project onDelete=Restrict (không hard-delete dự án có căn).
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../../shared/database/prisma-client.js';
import { CrmError, parseIntInput } from './property-service.js';

export interface ProjectInput {
  name?: string;
  developer?: string | null;
  province?: string | null;
  district?: string | null;
  address?: string | null;
  handoverYear?: number | null;
  note?: string | null;
}

export interface ProjectListFilters {
  q?: string;
  includeInactive?: boolean;
  page?: number;
  pageSize?: number;
}

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;

export async function listProjects(
  orgId: string,
  f: ProjectListFilters,
): Promise<{ items: unknown[]; total: number; page: number; pageSize: number }> {
  const page = f.page && f.page > 0 ? f.page : 1;
  const pageSize = f.pageSize ? Math.min(Math.max(1, f.pageSize), MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE;
  const where: Prisma.ProjectWhereInput = { orgId };
  if (f.q && f.q.trim()) where.name = { contains: f.q.trim(), mode: 'insensitive' };
  if (!f.includeInactive) where.isActive = true;

  const [items, total] = await Promise.all([
    prisma.project.findMany({
      where,
      include: { _count: { select: { properties: true } } },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.project.count({ where }),
  ]);
  return { items: items as unknown[], total, page, pageSize };
}

export async function getProject(orgId: string, id: string): Promise<unknown> {
  const item = await prisma.project.findFirst({
    where: { id, orgId },
    include: { _count: { select: { properties: true } } },
  });
  if (!item) throw new CrmError(404, 'Dự án không tồn tại');
  return item;
}

export async function createProject(orgId: string, input: ProjectInput): Promise<unknown> {
  if (!input.name?.trim()) throw new CrmError(400, 'name (tên dự án) required');
  const data: Prisma.ProjectCreateInput = {
    org: { connect: { id: orgId } },
    name: input.name!.trim(),
    ...(input.developer !== null && input.developer !== undefined ? { developer: input.developer } : {}),
    ...(input.province !== null && input.province !== undefined ? { province: input.province } : {}),
    ...(input.district !== null && input.district !== undefined ? { district: input.district } : {}),
    ...(input.address !== null && input.address !== undefined ? { address: input.address } : {}),
    ...(input.handoverYear !== null && input.handoverYear !== undefined ? { handoverYear: input.handoverYear } : {}),
    ...(input.note !== null && input.note !== undefined ? { note: input.note } : {}),
  };
  try {
    return await prisma.project.create({ data });
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') {
      throw new CrmError(409, 'Tên dự án đã tồn tại', { code: 'PROJECT_DUPLICATE' });
    }
    throw err;
  }
}

export async function updateProject(
  orgId: string,
  id: string,
  input: Partial<ProjectInput>,
): Promise<unknown> {
  const existing = await prisma.project.findFirst({ where: { id, orgId } });
  if (!existing) throw new CrmError(404, 'Dự án không tồn tại');
  if (input.name !== undefined && !input.name?.trim()) throw new CrmError(400, 'name (tên dự án) required');
  const data: Prisma.ProjectUpdateInput = {
    ...(input.name !== null && input.name !== undefined ? { name: input.name!.trim() } : {}),
    ...(input.developer !== null && input.developer !== undefined ? { developer: input.developer } : {}),
    ...(input.province !== null && input.province !== undefined ? { province: input.province } : {}),
    ...(input.district !== null && input.district !== undefined ? { district: input.district } : {}),
    ...(input.address !== null && input.address !== undefined ? { address: input.address } : {}),
    ...(input.handoverYear !== null && input.handoverYear !== undefined ? { handoverYear: input.handoverYear } : {}),
    ...(input.note !== null && input.note !== undefined ? { note: input.note } : {}),
  };
  try {
    return await prisma.project.update({ where: { id }, data });
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') {
      throw new CrmError(409, 'Tên dự án đã tồn tại', { code: 'PROJECT_DUPLICATE' });
    }
    throw err;
  }
}

// Soft delete vì Property.project onDelete=Restrict → hard delete sẽ lỗi FK khi
// dự án còn căn. isActive=false ẩn khỏi list mặc định.
export async function deleteProject(orgId: string, id: string): Promise<{ deleted: boolean; id: string }> {
  const existing = await prisma.project.findFirst({ where: { id, orgId } });
  if (!existing) throw new CrmError(404, 'Dự án không tồn tại');
  await prisma.project.update({ where: { id }, data: { isActive: false } });
  return { deleted: true, id };
}

/**
 * Tìm dự án theo tên (insensitive, trim) trong org — dùng cho import bảng hàng
 * khi file có cột "Dự án" nhưng user không chọn projectId trước.
 */
export async function findProjectByName(orgId: string, name: string): Promise<{ id: string } | null> {
  if (!name?.trim()) return null;
  return prisma.project.findFirst({
    where: { orgId, name: { equals: name.trim(), mode: 'insensitive' } },
    select: { id: true },
  });
}

/** Helper parse handoverYear cho routes. */
export function parseHandoverYear(value: unknown): number | null {
  return parseIntInput(value, 'handoverYear', { min: 1900, max: 2100 });
}