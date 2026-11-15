<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Nguyễn Tiến Lộc -->
<template>
  <v-dialog v-model="open" max-width="640">
    <v-card>
      <v-card-title>
        <v-icon size="18">mdi-bullhorn-outline</v-icon>
        {{ editing ? 'Sửa chiến dịch' : 'Tạo chiến dịch' }}
      </v-card-title>
      <v-card-text>
        <v-text-field v-model="form.name" label="Tên chiến dịch *" />

        <div class="d-flex ga-3">
          <v-select
            v-model="form.channelCode"
            label="Kênh"
            :items="channelOptions"
            item-title="label"
            item-value="code"
            clearable
          />
          <v-select
            v-model="form.typeCode"
            label="Loại"
            :items="typeOptions"
            item-title="label"
            item-value="value"
          />
        </div>

        <div class="d-flex ga-3">
          <v-text-field v-model="form.startAt" label="Từ ngày" type="date" />
          <v-text-field v-model="form.endAt" label="Đến ngày" type="date" />
        </div>

        <v-text-field
          v-model="form.costVnd"
          label="Ngân sách (VND)"
          type="number"
          hint="Nhập số tròn chục nghìn, VD: 50000000"
          persistent-hint
        />

        <v-select
          v-model="form.customerListIds"
          label="Tệp khách hàng (nguồn đối tượng)"
          :items="customerListOptions"
          item-title="name"
          item-value="id"
          multiple
          chips
          closable-chips
          hint="Chọn 1 tệp trở lên — chiến dịch lấy KH từ các tệp này"
          persistent-hint
        />

        <v-select
          v-model="form.projectIds"
          label="Dự án"
          :items="projectOptions"
          item-title="name"
          item-value="id"
          multiple
          chips
          closable-chips
          hint="Dự án liên quan — dùng để đối chiếu bảng hàng"
          persistent-hint
        />

        <v-textarea v-model="form.script" label="Kịch bản" auto-grow rows="3" />
        <v-textarea v-model="form.note" label="Ghi chú" auto-grow rows="2" />

        <v-alert v-if="formError" type="error" density="compact" class="mt-3">{{ formError }}</v-alert>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn @click="open = false">Huỷ</v-btn>
        <v-btn color="primary" :loading="saving" @click="handleSubmit">
          {{ editing ? 'Lưu' : 'Tạo' }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useCampaigns, type CampaignItem, type CampaignPayload } from '@/composables/use-campaigns';
import { fetchMasterItems, type MasterOption } from '@/composables/use-properties';
import { useToast } from '@/composables/use-toast';

const props = defineProps<{
  modelValue: boolean;
  campaign?: CampaignItem | null;
}>();
const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void;
  (e: 'saved', campaign: CampaignItem | null): void;
}>();

const toast = useToast();
const {
  customerListOptions,
  projectOptions,
  fetchCustomerListOptions,
  fetchProjectOptions,
  createCampaign,
  updateCampaign,
} = useCampaigns();

const open = computed({
  get: () => props.modelValue,
  set: (v: boolean) => emit('update:modelValue', v),
});

const editing = computed(() => !!props.campaign);
const saving = ref(false);
const formError = ref('');
const channelOptions = ref<MasterOption[]>([]);

/** Loại chiến dịch — theo Campaign.typeCode trong schema. */
const typeOptions = [
  { value: 'marketing', label: 'Marketing' },
  { value: 'care', label: 'Chăm sóc' },
  { value: 'friend_request', label: 'Kết bạn' },
  { value: 'message', label: 'Tin nhắn' },
];

interface FormState {
  name: string;
  channelCode: string | null;
  typeCode: string;
  startAt: string; // yyyy-mm-dd
  endAt: string;   // yyyy-mm-dd
  costVnd: string;
  customerListIds: string[];
  projectIds: string[];
  script: string;
  note: string;
}

const form = ref<FormState>(emptyForm());

function emptyForm(): FormState {
  return {
    name: '', channelCode: null, typeCode: 'marketing',
    startAt: '', endAt: '', costVnd: '',
    customerListIds: [], projectIds: [],
    script: '', note: '',
  };
}

/** ISO date (yyyy-mm-dd) → Date | null. */
function parseDate(v: string): Date | null {
  if (!v) return null;
  const d = new Date(`${v}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Date → ISO date (yyyy-mm-dd) để prefill form khi sửa. */
function toIsoDate(v: string | null): string {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

watch(() => props.modelValue, async (v) => {
  if (!v) return;
  formError.value = '';
  const c = props.campaign;
  if (c) {
    form.value = {
      name: c.name,
      channelCode: c.channelCode,
      typeCode: c.typeCode || 'marketing',
      startAt: toIsoDate(c.startAt),
      endAt: toIsoDate(c.endAt),
      costVnd: c.costVnd != null ? String(c.costVnd).replace(/[^\d]/g, '') : '',
      customerListIds: (c.customerLists ?? []).map((cl) => cl.customerListId),
      projectIds: (c.projects ?? []).map((p) => p.projectId),
      script: c.script ?? '',
      note: c.note ?? '',
    };
  } else {
    form.value = emptyForm();
  }
  await Promise.all([
    fetchCustomerListOptions(),
    fetchProjectOptions(),
    loadChannels(),
  ]);
});

async function loadChannels() {
  if (channelOptions.value.length) return;
  channelOptions.value = await fetchMasterItems('KEHOACH');
}

async function handleSubmit() {
  if (!form.value.name.trim()) { formError.value = 'Tên chiến dịch không được trống'; return; }
  saving.value = true;
  formError.value = '';
  try {
    const payload: CampaignPayload = {
      name: form.value.name.trim(),
      channelCode: form.value.channelCode || null,
      typeCode: form.value.typeCode || null,
      startAt: parseDate(form.value.startAt)?.toISOString() ?? null,
      endAt: parseDate(form.value.endAt)?.toISOString() ?? null,
      costVnd: form.value.costVnd ? form.value.costVnd : null,
      customerListIds: form.value.customerListIds,
      projectIds: form.value.projectIds,
      script: form.value.script || null,
      note: form.value.note || null,
    };
    const saved = props.campaign
      ? await updateCampaign(props.campaign.id, payload)
      : await createCampaign(payload);
    toast.success(props.campaign ? 'Đã cập nhật chiến dịch' : 'Đã tạo chiến dịch');
    emit('saved', saved);
    emit('update:modelValue', false);
  } catch (err) {
    formError.value = (err as { response?: { data?: { error?: string } } }).response?.data?.error
      ?? 'Lưu thất bại — thử lại';
  } finally {
    saving.value = false;
  }
}
</script>
