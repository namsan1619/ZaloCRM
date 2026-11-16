// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyen Tien Loc
/**
 * broker-dashboard-service.ts — Tổng hợp KPI dashboard môi giới (broker summary).
 *
 * Một endpoint đọc thuần: GET /api/v1/dashboard/broker/summary. Toàn bộ query
 * scope theo orgId (multi-tenant) và chỉ tính dữ liệu "thật":
 *   - Contact: loại KH đã merge (mergedInto != null) khỏi total/newToday/byRating.
 *   - Property: chỉ tính căn còn active (isActive = true).
 *
 * Dùng prisma.groupBy + count chạy song song (Promise.all), không fetch cả bảng.
 * byRating luôn trả đủ 5 key A/B/C/D/UNRATED; UNRATED = total trừ 4 mức A-D
 * (bền vững dù Prisma có trả hay không trả nhóm ratingCode NULL trong groupBy).
 */

import { prisma } from '../../shared/database/prisma-client.js';

export class BrokerDashboardError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'BrokerDashboardError';
  }
}

export const RATING_KEYS = ['A', 'B', 'C', 'D', 'UNRATED'] as const;
export type RatingKey = (typeof RATING_KEYS)[number];

export interface BrokerContactsSummary {
  total: number;
  newToday: number;
  byRating: Record<RatingKey, number>;
  withInterests: number;
}

export interface BrokerProjectRow {
  projectId: string;
  projectName: string;
  total: number;
  available: number;
}

export interface BrokerAgencyRow {
  agencyId: string | null;
  agencyName: string;
  total: number;
  available: number;
}

export interface BrokerSummary {
  contacts: BrokerContactsSummary;
  properties: {
    total: number;
    byStatus: Record<string, number>;
    byProject: BrokerProjectRow[];
    byAgency: BrokerAgencyRow[];
  };
  campaigns: { total: number; running: number; scheduled: number; completed: number };
  runs: { total: number; running: number };
}

const VN_OFFSET_MS = 7 * 60 * 60 * 1000;

/**
 * Khoảng [today, tomorrow) theo mốc 00:00 giờ VN (UTC+7), trả về Date UTC tuyệt
 * đối — không phụ thuộc timezone chạy server. Dùng cho chỉ số "KH mới hôm nay".
 */
export function vnDayRange(now: Date = new Date()): { today: Date; tomorrow: Date } {
  const vnNow = new Date(now.getTime() + VN_OFFSET_MS);
  const dayStartMs =
    Date.UTC(vnNow.getUTCFullYear(), vnNow.getUTCMonth(), vnNow.getUTCDate()) - VN_OFFSET_MS;
  return {
    today: new Date(dayStartMs),
    tomorrow: new Date(dayStartMs + 24 * 60 * 60 * 1000),
  };
}

export async function getBrokerSummary(orgId: string): Promise<BrokerSummary> {
  if (!orgId) {
    throw new BrokerDashboardError(400, 'ORG_ID_REQUIRED', 'orgId là bắt buộc');
  }
  const { today, tomorrow } = vnDayRange();

  const [
    contactsTotal,
    contactsNewToday,
    ratingRows,
    interestRows,
    propertiesTotal,
    statusRows,
    projectRows,
    agencyRows,
    campaignsTotal,
    campaignStatusRows,
    runsTotal,
    runStatusRows,
  ] = await Promise.all([
    prisma.contact.count({ where: { orgId, mergedInto: null } }),
    prisma.contact.count({
      where: { orgId, mergedInto: null, createdAt: { gte: today, lt: tomorrow } },
    }),
    prisma.contact.groupBy({
      by: ['ratingCode'],
      where: { orgId, mergedInto: null },
      _count: true,
    }),
    prisma.contactInterest.groupBy({ by: ['contactId'], where: { orgId }, _count: true }),
    prisma.property.count({ where: { orgId, isActive: true } }),
    prisma.property.groupBy({
      by: ['statusCode'],
      where: { orgId, isActive: true },
      _count: true,
    }),
    prisma.property.groupBy({
      by: ['projectId', 'statusCode'],
      where: { orgId, isActive: true },
      _count: true,
    }),
    prisma.property.groupBy({
      by: ['agencyId', 'statusCode'],
      where: { orgId, isActive: true },
      _count: true,
    }),
    prisma.campaign.count({ where: { orgId } }),
    prisma.campaign.groupBy({ by: ['status'], where: { orgId }, _count: true }),
    prisma.campaignRun.count({ where: { orgId } }),
    prisma.campaignRun.groupBy({ by: ['status'], where: { orgId }, _count: true }),
  ]);

  // ── KH: byRating ───────────────────────────────────────────────────────────
  // Chỉ cộng 4 mức A-D từ groupBy; UNRATED = total - tổng A-D (không phụ thuộc
  // việc Prisma groupBy có trả nhóm NULL hay không). Đảm bảo 5 key luôn hiện diện.
  const byRating: Record<RatingKey, number> = { A: 0, B: 0, C: 0, D: 0, UNRATED: 0 };
  for (const row of ratingRows) {
    const key = row.ratingCode as RatingKey | null;
    if (key === 'A' || key === 'B' || key === 'C' || key === 'D') {
      byRating[key] += row._count;
    }
  }
  const ratedSum = byRating.A + byRating.B + byRating.C + byRating.D;
  byRating.UNRATED = Math.max(0, contactsTotal - ratedSum);

  // ── Bảng hàng: gom (projectId|agencyId, statusCode) → total + available ─────
  const projectAgg = new Map<string, { total: number; available: number }>();
  for (const row of projectRows) {
    const agg = projectAgg.get(row.projectId) ?? { total: 0, available: 0 };
    agg.total += row._count;
    if (row.statusCode === 'AVAILABLE') agg.available += row._count;
    projectAgg.set(row.projectId, agg);
  }

  // Top 10 dự án theo total desc, gắn projectName từ bảng Project.
  const topProjects = [...projectAgg.entries()]
    .map(([projectId, { total, available }]) => ({ projectId, total, available }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 10);
  const projects = await prisma.project.findMany({
    where: { orgId, id: { in: topProjects.map((p) => p.projectId) } },
    select: { id: true, name: true },
  });
  const projectNameMap = new Map(projects.map((p) => [p.id, p.name]));
  const byProject: BrokerProjectRow[] = topProjects.map((p) => ({
    projectId: p.projectId,
    projectName: projectNameMap.get(p.projectId) ?? p.projectId,
    total: p.total,
    available: p.available,
  }));

  // agencyId NULL gom vào 1 bucket tên "Khac" (IDOR: null là key riêng, không
  // trộn với đại lý thật). Sort theo total desc để UI ưu tiên kênh nhiều căn.
  const agencyAgg = new Map<string | null, { total: number; available: number }>();
  for (const row of agencyRows) {
    const agg = agencyAgg.get(row.agencyId) ?? { total: 0, available: 0 };
    agg.total += row._count;
    if (row.statusCode === 'AVAILABLE') agg.available += row._count;
    agencyAgg.set(row.agencyId, agg);
  }
  const agencyIds = [...agencyAgg.keys()].filter((id): id is string => id !== null);
  const agencies = await prisma.agency.findMany({
    where: { orgId, id: { in: agencyIds } },
    select: { id: true, name: true },
  });
  const agencyNameMap = new Map(agencies.map((a) => [a.id, a.name]));
  const byAgency: BrokerAgencyRow[] = [...agencyAgg.entries()]
    .map(([agencyId, { total, available }]) => ({
      agencyId,
      agencyName: agencyId ? (agencyNameMap.get(agencyId) ?? agencyId) : 'Khac',
      total,
      available,
    }))
    .sort((a, b) => b.total - a.total);

  const byStatus: Record<string, number> = {};
  for (const row of statusRows) byStatus[row.statusCode] = row._count;

  const statusCount = (rows: Array<{ status: string; _count: number }>, status: string) =>
    rows.find((r) => r.status === status)?._count ?? 0;

  return {
    contacts: {
      total: contactsTotal,
      newToday: contactsNewToday,
      byRating,
      withInterests: interestRows.length,
    },
    properties: {
      total: propertiesTotal,
      byStatus,
      byProject,
      byAgency,
    },
    campaigns: {
      total: campaignsTotal,
      running: statusCount(campaignStatusRows, 'RUNNING'),
      scheduled: statusCount(campaignStatusRows, 'SCHEDULED'),
      completed: statusCount(campaignStatusRows, 'COMPLETED'),
    },
    runs: {
      total: runsTotal,
      running: statusCount(runStatusRows, 'RUNNING'),
    },
  };
}