<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Nguyễn Tiến Lộc -->
<template>
  <v-row dense class="mb-2 align-center">
    <!-- Search -->
    <v-col cols="12" sm="4">
      <v-text-field
        v-model="filters.search"
        prepend-inner-icon="mdi-magnify"
        label="Tìm kiếm tên / SĐT / email"
        clearable
        hide-details
        @update:model-value="emit('search')"
      />
    </v-col>

    <!-- Mã KH (CRM SĐT KH — 2026-11-15) -->
    <v-col cols="6" sm="4">
      <v-text-field
        v-model="filters.customerCode"
        prepend-inner-icon="mdi-identifier"
        label="Mã KH (KH000001…)"
        clearable
        hide-details
        density="compact"
        @update:model-value="emit('search')"
      />
    </v-col>

    <!-- Mức đánh giá (MasterData TRANG_THAI_KH — 2026-11-15) -->
    <v-col cols="6" sm="4">
      <v-select
        v-model="filters.ratingCode"
        :items="ratingOptions"
        item-title="label"
        item-value="code"
        label="Mức đánh giá"
        clearable
        hide-details
        density="compact"
        :loading="ratingLoading"
        @update:model-value="emit('search')"
      />
    </v-col>

    <!-- Source filter -->
    <v-col cols="6" sm="4">
      <v-select
        v-model="filters.source"
        :items="sourceOptions"
        item-title="text"
        item-value="value"
        label="Nguồn"
        clearable
        hide-details
        @update:model-value="emit('search')"
      />
    </v-col>

    <!-- Status filter -->
    <v-col cols="6" sm="4">
      <v-select
        v-model="filters.status"
        :items="statusOptions"
        item-title="text"
        item-value="value"
        label="Trạng thái"
        clearable
        hide-details
        @update:model-value="emit('search')"
      />
    </v-col>
  </v-row>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue';
import type { ContactFilters } from '@/composables/use-contacts';
import { SOURCE_OPTIONS, STATUS_OPTIONS } from '@/composables/use-contacts';
import { useMasterData } from '@/composables/use-master-data';

defineProps<{ filters: ContactFilters }>();
const emit = defineEmits<{ search: [] }>();

const sourceOptions = SOURCE_OPTIONS;
const statusOptions = STATUS_OPTIONS;

// Mức đánh giá A/B/C/D — danh mục MasterData TRANG_THAI_KH (P2).
const { itemsOf, fetchItems, loading: ratingLoading } = useMasterData();
const ratingOptions = computed(() => itemsOf('TRANG_THAI_KH'));
onMounted(() => { void fetchItems('TRANG_THAI_KH'); });
</script>