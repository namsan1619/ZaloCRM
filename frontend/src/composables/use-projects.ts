// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyễn Tiến Lộc
/**
 * Composable cho Dự án (Project / P3).
 * CRUD + list có phân trang + tìm kiếm. Contract:
 *  - GET/POST /api/v1/projects
 *  - PUT/DELETE /api/v1/projects/:id
 */
import { ref } from 'vue';
import { api } from '@/api/index';
import { pickList, pickTotal } from '@/composables/use-properties';

export interface ProjectItem {
  id: string;
  orgId: string;
  name: string;
  developer: string | null;
  province: string | null;
  district: string | null;
  address: string | null;
  handoverYear: number | null;
  note: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectPayload {
  name: string;
  developer?: string | null;
  province?: string | null;
  district?: string | null;
  address?: string | null;
  handoverYear?: number | null;
  note?: string | null;
  isActive?: boolean;
}

export function useProjects() {
  const projects = ref<ProjectItem[]>([]);
  const total = ref(0);
  const loading = ref(false);
  const q = ref('');
  const page = ref(1);
  const limit = ref(50);

  async function fetchProjects() {
    loading.value = true;
    try {
      const res = await api.get('/projects', {
        params: { q: q.value || undefined, page: page.value, limit: limit.value },
      });
      const data = res.data;
      projects.value = pickList<ProjectItem>(data, ['projects', 'items', 'list']);
      total.value = pickTotal(data);
    } catch (err) {
      console.error('[projects] fetchProjects failed:', err);
      projects.value = [];
      total.value = 0;
    } finally {
      loading.value = false;
    }
  }

  function search(text: string) {
    q.value = text;
    page.value = 1;
    return fetchProjects();
  }

  function goPage(p: number) {
    page.value = p;
    return fetchProjects();
  }

  async function createProject(payload: ProjectPayload): Promise<ProjectItem | null> {
    try {
      const res = await api.post('/projects', payload);
      return res.data?.project ?? res.data ?? null;
    } catch (err) {
      console.error('[projects] createProject failed:', err);
      throw err;
    }
  }

  async function updateProject(id: string, payload: ProjectPayload): Promise<ProjectItem | null> {
    try {
      const res = await api.put(`/projects/${id}`, payload);
      return res.data?.project ?? res.data ?? null;
    } catch (err) {
      console.error('[projects] updateProject failed:', err);
      throw err;
    }
  }

  async function deleteProject(id: string): Promise<void> {
    await api.delete(`/projects/${id}`);
  }

  return {
    projects,
    total,
    loading,
    q,
    page,
    limit,
    fetchProjects,
    search,
    goPage,
    createProject,
    updateProject,
    deleteProject,
  };
}