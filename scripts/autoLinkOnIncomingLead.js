#!/usr/bin/env node
// Watches the "Входящий лид" status in every configured pipeline and writes
// each lead's own CRM link into its "Ссылка на сделку" field, once, the
// first time that lead is seen there. Leads already sitting in the status
// before this script's first run are recorded as a baseline and skipped.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const STATE_PATH = path.join(ROOT, 'data', 'auto_link_state.json');
const LINK_FIELD_ID = 1080409; // "Ссылка на сделку" (text field, entity: leads)

const WATCHED_STATUSES = [
  { pipelineId: 8650290, statusId: 70129454, label: 'Ярославль / ВХОДЯЩИЙ ЛИД' },
  { pipelineId: 10109642, statusId: 80120054, label: 'Екатеринбург / ВХОДЯЩИЙ ЛИД' },
];

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile(path.join(ROOT, '.env'));

const BASE_URL = process.env.AMOCRM_BASE_URL;
const TOKEN = process.env.AMOCRM_TOKEN;

if (!BASE_URL || !TOKEN) {
  console.error('Missing AMOCRM_BASE_URL or AMOCRM_TOKEN (set them in .env).');
  process.exit(1);
}

function loadState() {
  if (!fs.existsSync(STATE_PATH)) {
    return { initialized: false, seenLeadIds: [] };
  }
  return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
}

async function amoRequest(pathAndQuery, options = {}) {
  const res = await fetch(`${BASE_URL}${pathAndQuery}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (res.status === 204) return null;
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error(`amoCRM API ${res.status} on ${pathAndQuery}: ${text}`);
  }
  return json;
}

async function fetchLeadsInStatus(pipelineId, statusId) {
  const leads = [];
  let page = 1;
  for (;;) {
    const query =
      `/api/v4/leads?filter[statuses][0][pipeline_id]=${pipelineId}` +
      `&filter[statuses][0][status_id]=${statusId}` +
      `&with=custom_fields_values&limit=250&page=${page}`;
    const data = await amoRequest(query);
    const pageLeads = data?._embedded?.leads || [];
    leads.push(...pageLeads);
    if (pageLeads.length < 250) break;
    page += 1;
  }
  return leads;
}

function hasLinkFieldFilled(lead) {
  const field = (lead.custom_fields_values || []).find((f) => f.field_id === LINK_FIELD_ID);
  const value = field?.values?.[0]?.value;
  return Boolean(value && String(value).trim());
}

async function setLeadLinkField(leadId) {
  const link = `${BASE_URL}/leads/detail/${leadId}`;
  await amoRequest(`/api/v4/leads/${leadId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      custom_fields_values: [
        {
          field_id: LINK_FIELD_ID,
          values: [{ value: link }],
        },
      ],
    }),
  });
  return link;
}

async function main() {
  const state = loadState();
  const seen = new Set(state.seenLeadIds || []);

  let allLeads = [];
  for (const status of WATCHED_STATUSES) {
    const leads = await fetchLeadsInStatus(status.pipelineId, status.statusId);
    for (const lead of leads) allLeads.push(lead);
  }

  if (!state.initialized) {
    for (const lead of allLeads) seen.add(lead.id);
    saveState({ initialized: true, seenLeadIds: [...seen] });
    console.log(
      `Baseline run: recorded ${allLeads.length} existing lead(s) at the watched statuses. ` +
        `They will be left untouched; only leads arriving after now will get the link.`
    );
    return;
  }

  let filled = 0;
  for (const lead of allLeads) {
    if (seen.has(lead.id)) continue;
    seen.add(lead.id);
    if (hasLinkFieldFilled(lead)) continue; // safety: don't overwrite a manually filled value
    const link = await setLeadLinkField(lead.id);
    filled += 1;
    console.log(`Lead ${lead.id}: set "Ссылка на сделку" = ${link}`);
  }

  saveState({ initialized: true, seenLeadIds: [...seen] });
  console.log(`Done. Checked ${allLeads.length} lead(s) currently at watched statuses, filled ${filled} new one(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
