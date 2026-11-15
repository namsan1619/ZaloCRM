// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyễn Tiến Lộc
/**
 * campaign-tracker-service.ts — Tracker chiến dịch marketing (P4, KHÔNG gửi thật).
 *
 * Model `Campaign` (bảng campaigns) — KHÁC với `AutomationCampaign` (EE, không khả dụng).
 * CRUD + thống kê cho chiến dịch:
 *   - listCampaigns / getCampaign / createCampaign / updateCampaign / deleteCampaign
 *   - setCampaignStatus (PATCH status)
 *   - getCampaignStats — tính từ dữ liệu THẬT:
 *       totalContacts      = distinct CustomerListEntry.contactId của các list thuộc campaign
 *       friendRequestsSent = count FriendshipAttempt (sentAt ∈ [startAt,endAt]) của contact thuộc list
 *       repliedContacts    = count Contact có lastInboundAt ∈ [startAt,endAt] (thuộc list)
 *       conversionRate     = replied / total (0 nếu thiếu dữ liệu)
 */
import { prisma } from '../../shared/database/prisma-client.js';
import { logger } from '../../shared/utils/logger.js';

export const CAMPAIGN_STATUSES = ['DRAFT', 'SCHEDULED', 'RUNNING', 'PAUSED', 'COMPLETED'] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 200;

export interface CampaignFilters {
  status?: string;
  channelCode?: string;
  q?: string;
  limit?: number;
  offset?: number;
}

export interface CampaignPayload {
  name?: string;
  channelCode?: string | null;
  typeCode?: string | null;
  startAt?: Date | null;
  endAt?: Date | null;
  costVnd?: bigint | null;
  customerListIds?: string[];
  projectIds?: string[];
  script?: string | null;
  note?: string | null;
}

/** 1 dòng KH trong stats — FE dùng để vẽ bảng KH của chiến dịch. */
export interface CampaignContactRow {
  contactId: string;
  name: string | null;
  phone: string | null;
  customerCode: string | null;
  friendStatus: string | null; // sent | accepted | pending | none
  replyStatus: string | null;  // replied | no_reply
  source: string | null;
}

export interface CampaignLinks {
  id: string;
  customerListId: string;
  customerList?: { id: string; name: string } | null;
}

export interface CampaignProjectLink {
  id: string;
  projectId: string;
  project?: { id: string; name: string } | null;
}

export interface SerializedCampaign {
  id: string;
  orgId: string;
  name: string;
  channelCode: string | null;
  typeCode: string | null;
  startAt: Date | null;
  endAt: Date | null;
  costVnd: number | null;
  status: string;
  script: string | null;
  note: string | null;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
  customerLists: CampaignLinks[];
  projects: CampaignProjectLink[];
}

export interface CampaignStats {
  campaignId: string;
  campaignName: string;
  status: string;
  startAt: Date | null;
  endAt: Date | null;
  totalContacts: number;
  friendRequestsSent: number;
  repliedContacts: number;
  conversionRate: number;
  customerListCount: number;
  projectCount: number;
  contacts: CampaignContactRow[];
}

/** Kết quả có lỗi — `error` là mã ổn định để route map sang HTTP status. */
export interface CampaignError {
  error: string;
  detailIds?: string[];
  allowed?: readonly string[];
}

export type CampaignResult<T> = ({ ok: true } & T) | ({ ok: false } & CampaignError);

// ── List ───────────────────────────────────────────────────────────────────
export async function listCampaigns(orgId: string, filters: CampaignFilters = {}) {
  const where: any = { orgId };
  if (filters.status) where.status = filters.status;
  if (filters.channelCode) where.channelCode = filters.channelCode;
  if (filters.q?.trim()) {
    where.name = { contains: filters.q.trim(), mode: 'insensitive' };
  }
  const limit = Math.min(Math.max(1, filters.limit ?? DEFAULT_LIST_LIMIT), MAX_LIST_LIMIT);
  const offset = Math.max(0, filters.offset ?? 0);

  const [campaigns, total] = await Promise.all([
    prisma.campaign.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: offset,
      take: limit,
      include: {
        customerLists: { select: { id: true, customerListId: true } },
        projects: { select: { id: true, projectId: true } },
      },
    }),
    prisma.campaign.count({ where }),
  ]);

  return {
    campaigns: campaigns.map((c: any) => ({
      ...serializeCampaign(c),
      customerListIds: c.customerLists.map((l: any) => l.customerListId),
      projectIds: c.projects.map((p: any) => p.projectId),
    })),
    total,
    page: Math.floor(offset / limit) + 1,
    limit,
  };
}

// ── Detail (kèm link tệp khách hàng + dự án) ──────────────────────────────
export async function getCampaign(orgId: string, id: string): Promise<SerializedCampaign | null> {
  const campaign = await prisma.campaign.findFirst({
    where: { id, orgId },
    include: {
      customerLists: true,
      projects: true,
    },
  });
  if (!campaign) return null;

  // CampaignCustomerList / CampaignProject không có Prisma relation tới
  // CustomerList / Project → resolve name riêng cho FE hiển thị chip.
  const [lists, projects] = await Promise.all([
    campaign.customerLists.length > 0
      ? prisma.customerList.findMany({
          where: { orgId, id: { in: campaign.customerLists.map((l) => l.customerListId) } },
          select: { id: true, name: true },
        })
      : [],
    campaign.projects.length > 0
      ? prisma.project.findMany({
          where: { orgId, id: { in: campaign.projects.map((p) => p.projectId) } },
          select: { id: true, name: true },
        })
      : [],
  ]);

  const listName = new Map(lists.map((l) => [l.id, l.name]));
  const projectName = new Map(projects.map((p) => [p.id, p.name]));

  return serializeCampaign({
    ...campaign,
    customerLists: campaign.customerLists.map((l) => ({
      ...l,
      customerList: { id: l.customerListId, name: listName.get(l.customerListId) ?? 'Đã xoá' },
    })),
    projects: campaign.projects.map((p) => ({
      ...p,
      project: { id: p.projectId, name: projectName.get(p.projectId) ?? 'Đã xoá' },
    })),
  });
}

// ── Create ─────────────────────────────────────────────────────────────────
export async function createCampaign(args: {
  orgId: string;
  userId: string | null;
  payload: CampaignPayload;
}): Promise<CampaignResult<{ campaign: SerializedCampaign }>> {
  const { orgId, userId, payload } = args;
  const name = payload.name?.trim();
  if (!name) return { ok: false, error: 'name_required' };

  const customerListIds = await resolveOwnedCustomerLists(orgId, payload.customerListIds);
  if (!customerListIds.ok) return customerListIds;
  const projectIds = await resolveOwnedProjects(orgId, payload.projectIds);
  if (!projectIds.ok) return projectIds;

  const startAt = payload.startAt ?? null;
  const endAt = payload.endAt ?? null;
  if (startAt && endAt && startAt > endAt) return { ok: false, error: 'date_range_invalid' };

  try {
    const created = await prisma.campaign.create({
      data: {
        orgId,
        name,
        channelCode: payload.channelCode ?? null,
        typeCode: payload.typeCode ?? null,
        startAt,
        endAt,
        costVnd: payload.costVnd ?? null,
        status: 'DRAFT',
        script: payload.script ?? null,
        note: payload.note ?? null,
        createdById: userId,
      },
    });

    if (customerListIds.value.length > 0) {
      await prisma.campaignCustomerList.createMany({
        data: customerListIds.value.map((customerListId) => ({ campaignId: created.id, customerListId })),
      });
    }
    if (projectIds.value.length > 0) {
      await prisma.campaignProject.createMany({
        data: projectIds.value.map((projectId) => ({ campaignId: created.id, projectId })),
      });
    }

    const campaign = await getCampaign(orgId, created.id);
    return { ok: true, campaign: campaign! };
  } catch (err) {
    logger.error('[campaign-tracker] create error:', err);
    return { ok: false, error: 'create_failed' };
  }
}

// ── Update ─────────────────────────────────────────────────────────────────
export async function updateCampaign(args: {
  orgId: string;
  id: string;
  payload: CampaignPayload;
}): Promise<CampaignResult<{ campaign: SerializedCampaign }>> {
  const { orgId, id, payload } = args;
  const existing = await prisma.campaign.findFirst({
    where: { id, orgId },
    select: { id: true, startAt: true, endAt: true },
  });
  if (!existing) return { ok: false, error: 'not_found' };

  const data: any = {};
  if (payload.name !== undefined) {
    const name = payload.name?.trim();
    if (!name) return { ok: false, error: 'name_required' };
    data.name = name;
  }
  if (payload.channelCode !== undefined) data.channelCode = payload.channelCode ?? null;
  if (payload.typeCode !== undefined) data.typeCode = payload.typeCode ?? null;
  if (payload.startAt !== undefined) data.startAt = payload.startAt ?? null;
  if (payload.endAt !== undefined) data.endAt = payload.endAt ?? null;
  if (payload.costVnd !== undefined) data.costVnd = payload.costVnd ?? null;
  if (payload.script !== undefined) data.script = payload.script ?? null;
  if (payload.note !== undefined) data.note = payload.note ?? null;

  // Range check dùng giá trị sau-update (fallback về giá trị hiện tại)
  const nextStart = payload.startAt !== undefined ? payload.startAt : existing.startAt;
  const nextEnd = payload.endAt !== undefined ? payload.endAt : existing.endAt;
  if (nextStart && nextEnd && nextStart > nextEnd) return { ok: false, error: 'date_range_invalid' };

  const replaceLists = payload.customerListIds !== undefined;
  const replaceProjects = payload.projectIds !== undefined;

  try {
    // Không field scalar và không thay link → no-op trả về campaign hiện tại.
    if (Object.keys(data).length > 0) {
      await prisma.campaign.update({ where: { id }, data });
    }

    // Replace links chỉ khi payload có cung cấp (undefined = giữ nguyên)
    if (replaceLists) {
      const lists = await resolveOwnedCustomerLists(orgId, payload.customerListIds);
      if (!lists.ok) return lists;
      await prisma.campaignCustomerList.deleteMany({ where: { campaignId: id } });
      if (lists.value.length > 0) {
        await prisma.campaignCustomerList.createMany({
          data: lists.value.map((customerListId) => ({ campaignId: id, customerListId })),
        });
      }
    }
    if (replaceProjects) {
      const projects = await resolveOwnedProjects(orgId, payload.projectIds);
      if (!projects.ok) return projects;
      await prisma.campaignProject.deleteMany({ where: { campaignId: id } });
      if (projects.value.length > 0) {
        await prisma.campaignProject.createMany({
          data: projects.value.map((projectId) => ({ campaignId: id, projectId })),
        });
      }
    }

    // Replace links chỉ khi payload có cung cấp (undefined = giữ nguyên)
    if (payload.customerListIds !== undefined) {
      const lists = await resolveOwnedCustomerLists(orgId, payload.customerListIds);
      if (!lists.ok) return lists;
      await prisma.campaignCustomerList.deleteMany({ where: { campaignId: id } });
      if (lists.value.length > 0) {
        await prisma.campaignCustomerList.createMany({
          data: lists.value.map((customerListId) => ({ campaignId: id, customerListId })),
        });
      }
    }
    if (payload.projectIds !== undefined) {
      const projects = await resolveOwnedProjects(orgId, payload.projectIds);
      if (!projects.ok) return projects;
      await prisma.campaignProject.deleteMany({ where: { campaignId: id } });
      if (projects.value.length > 0) {
        await prisma.campaignProject.createMany({
          data: projects.value.map((projectId) => ({ campaignId: id, projectId })),
        });
      }
    }

    const campaign = await getCampaign(orgId, id);
    return { ok: true, campaign: campaign! };
  } catch (err) {
    logger.error('[campaign-tracker] update error:', err);
    return { ok: false, error: 'update_failed' };
  }
}

// ── Delete ─────────────────────────────────────────────────────────────────
export async function deleteCampaign(
  orgId: string,
  id: string,
): Promise<CampaignResult<{ deleted: true }>> {
  const existing = await prisma.campaign.findFirst({ where: { id, orgId }, select: { id: true } });
  if (!existing) return { ok: false, error: 'not_found' };
  try {
    // FK cascade (onDelete: Cascade) tự xoá campaignCustomerList + campaignProject.
    await prisma.campaign.delete({ where: { id } });
    return { ok: true, deleted: true };
  } catch (err) {
    logger.error('[campaign-tracker] delete error:', err);
    return { ok: false, error: 'delete_failed' };
  }
}

// ── Status ─────────────────────────────────────────────────────────────────
export async function setCampaignStatus(
  orgId: string,
  id: string,
  status: string,
): Promise<CampaignResult<{ previousStatus: string; campaign: SerializedCampaign }>> {
  const existing = await prisma.campaign.findFirst({
    where: { id, orgId },
    select: { id: true, status: true },
  });
  if (!existing) return { ok: false, error: 'not_found' };
  if (!(CAMPAIGN_STATUSES as readonly string[]).includes(status)) {
    return { ok: false, error: 'invalid_status', allowed: CAMPAIGN_STATUSES };
  }
  try {
    const updated = await prisma.campaign.update({ where: { id }, data: { status } });
    return { ok: true, previousStatus: existing.status, campaign: serializeCampaign(updated) };
  } catch (err) {
    logger.error('[campaign-tracker] status update error:', err);
    return { ok: false, error: 'update_failed' };
  }
}

// ── Stats ──────────────────────────────────────────────────────────────────
/**
 * Stats tính từ dữ liệu thật:
 *  - totalContacts: distinct contactId trong CustomerListEntry của các list campaign
 *  - friendRequestsSent: FriendshipAttempt của các contact đó, sentAt ∈ [startAt,endAt]
 *  - repliedContacts: Contact của các list có lastInboundAt ∈ [startAt,endAt]
 *  - conversionRate = replied / total (0 nếu thiếu dữ liệu)
 * Campaign không có startAt/endAt → không lọc theo thời gian (tính toàn bộ).
 */
export async function getCampaignStats(
  orgId: string,
  campaignId: string,
): Promise<CampaignStats | null> {
  const campaign = await prisma.campaign.findFirst({
    where: { id: campaignId, orgId },
    select: { id: true, name: true, status: true, startAt: true, endAt: true },
  });
  if (!campaign) return null;

  // 1. Các list thuộc campaign
  const links = await prisma.campaignCustomerList.findMany({
    where: { campaignId },
    select: { customerListId: true },
  });
  const listIds = links.map((l) => l.customerListId);

  const base: CampaignStats = {
    campaignId: campaign.id,
    campaignName: campaign.name,
    status: campaign.status,
    startAt: campaign.startAt,
    endAt: campaign.endAt,
    totalContacts: 0,
    friendRequestsSent: 0,
    repliedContacts: 0,
    conversionRate: 0,
    customerListCount: listIds.length,
    projectCount: 0,
    contacts: [],
  };

  if (listIds.length === 0) return base;

  base.projectCount = await prisma.campaignProject.count({ where: { campaignId } });

  // 2. Distinct contact ids trong các entry của list
  const rows = await prisma.customerListEntry.findMany({
    where: { customerListId: { in: listIds }, contactId: { not: null } },
    select: { contactId: true },
    distinct: ['contactId'],
  });
  const contactIds = rows
    .map((r) => r.contactId)
    .filter((c): c is string => c !== null);
  const totalContacts = contactIds.length;

  // 3. Window time filter — chỉ áp dụng khi campaign có ngày
  const sentAtFilter: any = { not: null };
  const lastInboundFilter: any = { not: null };
  if (campaign.startAt) {
    sentAtFilter.gte = campaign.startAt;
    lastInboundFilter.gte = campaign.startAt;
  }
  if (campaign.endAt) {
    sentAtFilter.lte = campaign.endAt;
    lastInboundFilter.lte = campaign.endAt;
  }

  const [friendRequestsSent, repliedContacts] = await Promise.all([
    totalContacts > 0
      ? prisma.friendshipAttempt.count({
          where: { orgId, contactId: { in: contactIds }, sentAt: sentAtFilter },
        })
      : 0,
    totalContacts > 0
      ? prisma.contact.count({
          where: { orgId, id: { in: contactIds }, lastInboundAt: lastInboundFilter },
        })
      : 0,
  ]);

  const conversionRate = totalContacts > 0 ? repliedContacts / totalContacts : 0;

  return {
    ...base,
    totalContacts,
    friendRequestsSent,
    repliedContacts,
    conversionRate: Math.round(conversionRate * 10000) / 10000,
    contacts: await buildContactRows(orgId, contactIds, campaign.startAt, campaign.endAt),
  };
}

// ── Contacts rows (chi tiết từng KH của chiến dịch) ───────────────────────
/**
 * Mỗi dòng = 1 contact thuộc list của chiến dịch, kèm trạng thái bạn / phản hồi.
 *  - friendStatus: state của FriendshipAttempt gần nhất (sent | accepted | pending | none)
 *  - replyStatus : lastInboundAt có nằm trong khoảng [startAt,endAt] không
 */
async function buildContactRows(
  orgId: string,
  contactIds: string[],
  startAt: Date | null,
  endAt: Date | null,
): Promise<CampaignContactRow[]> {
  if (contactIds.length === 0) return [];

  const [contacts, attempts] = await Promise.all([
    prisma.contact.findMany({
      where: { orgId, id: { in: contactIds } },
      select: {
        id: true,
        fullName: true,
        crmName: true,
        phone: true,
        customerCode: true,
        source: true,
        lastInboundAt: true,
      },
    }),
    prisma.friendshipAttempt.findMany({
      where: { orgId, contactId: { in: contactIds } },
      select: { contactId: true, state: true },
      orderBy: { queuedAt: 'desc' },
    }),
  ]);

  // Attempt mới nhất cho mỗi contact (list đã sort desc → giữ lần gặp đầu tiên)
  const latestAttempt = new Map<string, string>();
  for (const a of attempts) {
    if (!latestAttempt.has(a.contactId)) latestAttempt.set(a.contactId, a.state);
  }

  return contacts.map((c) => {
    const state = latestAttempt.get(c.id);
    let friendStatus: string = 'none';
    if (state === 'accepted') friendStatus = 'accepted';
    else if (state === 'sent') friendStatus = 'sent';
    else if (state) friendStatus = 'pending';

    const replied =
      c.lastInboundAt !== null &&
      (!startAt || c.lastInboundAt >= startAt) &&
      (!endAt || c.lastInboundAt <= endAt);

    return {
      contactId: c.id,
      name: c.fullName ?? c.crmName ?? null,
      phone: c.phone ?? null,
      customerCode: c.customerCode ?? null,
      friendStatus,
      replyStatus: replied ? 'replied' : 'no_reply',
      source: c.source ?? null,
    };
  });
}

// ── Serialize ──────────────────────────────────────────────────────────────
function serializeCampaign(campaign: any): SerializedCampaign {
  return {
    id: campaign.id,
    orgId: campaign.orgId,
    name: campaign.name,
    channelCode: campaign.channelCode ?? null,
    typeCode: campaign.typeCode ?? null,
    startAt: campaign.startAt ?? null,
    endAt: campaign.endAt ?? null,
    // costVnd là BigInt ở DB → trả number cho JSON (đủ chính xác cho VND).
    costVnd: campaign.costVnd != null ? Number(campaign.costVnd) : null,
    status: campaign.status,
    script: campaign.script ?? null,
    note: campaign.note ?? null,
    createdById: campaign.createdById ?? null,
    createdAt: campaign.createdAt,
    updatedAt: campaign.updatedAt,
    customerLists: (campaign.customerLists ?? []).map((l: any) => ({
      id: l.id,
      customerListId: l.customerListId,
      customerList: l.customerList ?? null,
    })),
    projects: (campaign.projects ?? []).map((p: any) => ({
      id: p.id,
      projectId: p.projectId,
      project: p.project ?? null,
    })),
  };
}

// ── Org-scoped refs validation ─────────────────────────────────────────────
type OwnedRefs = { ok: true; value: string[] } | { ok: false; error: string; detailIds: string[] };

async function resolveOwnedCustomerLists(orgId: string, ids?: string[]): Promise<OwnedRefs> {
  if (!ids || ids.length === 0) return { ok: true, value: [] };
  const unique = [...new Set(ids)];
  const found = await prisma.customerList.findMany({
    where: { orgId, id: { in: unique } },
    select: { id: true },
  });
  const foundIds = new Set(found.map((f) => f.id));
  const missing = unique.filter((id) => !foundIds.has(id));
  if (missing.length > 0) return { ok: false, error: 'customer_list_not_found', detailIds: missing };
  return { ok: true, value: unique };
}

async function resolveOwnedProjects(orgId: string, ids?: string[]): Promise<OwnedRefs> {
  if (!ids || ids.length === 0) return { ok: true, value: [] };
  const unique = [...new Set(ids)];
  const found = await prisma.project.findMany({
    where: { orgId, id: { in: unique } },
    select: { id: true },
  });
  const foundIds = new Set(found.map((f) => f.id));
  const missing = unique.filter((id) => !foundIds.has(id));
  if (missing.length > 0) return { ok: false, error: 'project_not_found', detailIds: missing };
  return { ok: true, value: unique };
}
