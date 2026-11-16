// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyễn Tiến Lộc
/**
 * use-interests.spec.ts — unit test composable use-interests với api mock.
 *
 * KHÔNG gọi network thật: vi.mock('@/api/index') chặn axios, trả fixture cục bộ.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { api } from '@/api/index';

vi.mock('@/api/index', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
}));

import { useInterests } from './use-interests';

const mockGet = vi.mocked(api.get);
const mockPost = vi.mocked(api.post);
const mockPut = vi.mocked(api.put);
const mockDelete = vi.mocked(api.delete);

const FIXTURE = {
  interest: {
    id: 'int-1',
    contactId: 'c-1',
    propertyId: 'p-1',
    projectId: null,
    interestCode: 'QUAN_TAM',
    note: null,
    source: 'manual',
    createdAt: '2026-11-16T03:00:00.000Z',
    property: { id: 'p-1', unitCode: 'D01-1203', project: { id: 'prj-1', name: 'Sun Group' } },
    project: null,
  },
};

beforeEach(() => {
  vi.resetAllMocks();
});

describe('useInterests', () => {
  it('fetchInterests đọc đúng shape { interests: [...] }', async () => {
    mockGet.mockResolvedValueOnce({ data: { interests: [FIXTURE.interest] } });
    const c = useInterests();

    const list = await c.fetchInterests('c-1');

    expect(mockGet).toHaveBeenCalledWith('/contacts/c-1/interests');
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('int-1');
    expect(c.interests.value[0].property?.unitCode).toBe('D01-1203');
  });

  it('fetchInterests bắt lỗi và trả [] (không ném)', async () => {
    mockGet.mockRejectedValueOnce(new Error('network'));
    const c = useInterests();

    const list = await c.fetchInterests('c-1');

    expect(list).toEqual([]);
    expect(c.interests.value).toEqual([]);
    expect(c.error.value).toBeTruthy();
  });

  it('createInterest gọi POST + refetch list', async () => {
    mockPost.mockResolvedValueOnce({ data: { interest: FIXTURE.interest } });
    mockGet.mockResolvedValueOnce({ data: { interests: [FIXTURE.interest] } });
    const c = useInterests();

    const created = await c.createInterest('c-1', { propertyId: 'p-1', interestCode: 'QUAN_TAM', source: 'manual' });

    expect(mockPost).toHaveBeenCalledWith('/contacts/c-1/interests', {
      propertyId: 'p-1',
      interestCode: 'QUAN_TAM',
      source: 'manual',
    });
    expect(created?.id).toBe('int-1');
    expect(mockGet).toHaveBeenCalledWith('/contacts/c-1/interests');
  });

  it('deleteInterest gọi DELETE và bỏ dòng khỏi list', async () => {
    mockDelete.mockResolvedValueOnce({ data: { deleted: true } });
    const c = useInterests();
    c.interests.value = [FIXTURE.interest];

    const ok = await c.deleteInterest('int-1');

    expect(mockDelete).toHaveBeenCalledWith('/interests/int-1');
    expect(ok).toBe(true);
    expect(c.interests.value).toHaveLength(0);
  });

  it('deleteInterest lỗi → trả false, giữ list', async () => {
    mockDelete.mockRejectedValueOnce({ response: { data: { error: 'Không xoá được' } } });
    const c = useInterests();
    c.interests.value = [FIXTURE.interest];

    const ok = await c.deleteInterest('int-1');

    expect(ok).toBe(false);
    expect(c.interests.value).toHaveLength(1);
    expect(c.error.value).toBe('Không xoá được');
  });

  it('updateInterest cập nhật dòng trong list', async () => {
    mockPut.mockResolvedValueOnce({ data: { interest: { ...FIXTURE.interest, interestCode: 'RAT_QUAN_TAM' } } });
    const c = useInterests();
    c.interests.value = [FIXTURE.interest];

    const updated = await c.updateInterest('int-1', { interestCode: 'RAT_QUAN_TAM' });

    expect(mockPut).toHaveBeenCalledWith('/interests/int-1', { interestCode: 'RAT_QUAN_TAM' });
    expect(updated?.interestCode).toBe('RAT_QUAN_TAM');
    expect(c.interests.value[0].interestCode).toBe('RAT_QUAN_TAM');
  });

  it('fetchSuggestions đọc shape { suggestions: [...] }', async () => {
    mockGet.mockResolvedValueOnce({
      data: { suggestions: [{ id: 'p-9', unitCode: 'B2-1501', project: { id: 'prj-1', name: 'Sun Group' } }] },
    });
    const c = useInterests();

    const list = await c.fetchSuggestions('c-1', 5);

    expect(mockGet).toHaveBeenCalledWith('/contacts/c-1/interests/suggestions', { params: { limit: 5 } });
    expect(list).toHaveLength(1);
    expect(list[0].unitCode).toBe('B2-1501');
  });

  it('searchProperties gọi GET /properties với q và pageSize', async () => {
    mockGet.mockResolvedValueOnce({
      data: { items: [{ id: 'p-1', unitCode: 'D01-1203', project: { id: 'prj-1', name: 'Sun Group' } }] },
    });
    const c = useInterests();

    const list = await c.searchProperties('D01', 8);

    expect(mockGet).toHaveBeenCalledWith('/properties', { params: { q: 'D01', pageSize: 8 } });
    expect(list).toHaveLength(1);
  });

  it('searchProperties với q rỗng → không gọi API, trả []', async () => {
    const c = useInterests();

    const list = await c.searchProperties('   ');

    expect(mockGet).not.toHaveBeenCalled();
    expect(list).toEqual([]);
  });
});