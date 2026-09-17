#!/usr/bin/env node
// Watches for leads touching the "Входящий лид" status (in any configured
// pipeline) and writes each lead's own CRM link into its "Ссылка на сделку"
// field, once. Combines two signals so a lead is never missed, however
// briefly it was on the status:
//   1. Leads currently sitting at the watched status right now.
//   2. Leads that had a lead_status_changed event (into OR out of the
//      watched status) since the last check — this catches leads that
//      already moved on before this script ran again.
//
// On the very first run, every lead found by either signal is recorded as
// "already handled" WITHOUT writing anything, per the requirement that only
// leads arriving after setup should get the auto-filled link.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const STATE_PATH = path.join(ROOT, 'data', 'auto_link_state.json');
const LINK_FIELD_ID = 1080409; // "Ссылка на сделку" (text field, entity: leads)
const PAGE_LIMIT = 250;

const WATCHED_STATUSES = [
  { pipelineId: 8650290, statusId: 70129454, label: 'Ярославль / ВХОДЯЩИЙ ЛИД' },
  { pipelineId: 10109642, statusId: 80120054, label: 'Екатеринбург / ВХОДЯЩИЙ ЛИД' },
];
const WATCHED_KEYS = new Set(WATCHED_STATUSES.map((s) => `${s.pipelineId}:${s.statusId}`));

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
    return { initialized: false, lastCheckedAt: 0, filledLeadIds: [] };
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

async function fetchLeadsCurrentlyAtWatchedStatuses() {
  const leadIds = new Set();
  for (const status of WATCHED_STATUSES) {
    let page = 1;
    for (;;) {
      const query =
        `/api/v4/leads?filter[statuses][0][pipeline_id]=${status.pipelineId}` +
        `&filter[statuses][0][status_id]=${status.statusId}` +
        `&limit=${PAGE_LIMIT}&page=${page}`;
      const data = await amoRequest(query);
      const leads = data?._embedded?.leads || [];
      for (const lead of leads) leadIds.add(lead.id);
      if (leads.length < PAGE_LIMIT) break;
      page += 1;
    }
  }
  return leadIds;
}

// Leads with a lead_status_changed event, since fromTs, where either side of
// the transition (value_before or value_after) touches a watched status.
// Checking both sides catches a lead created directly at the watched status
// and then moved elsewhere before we noticed it was ever there.
async function fetchLeadsTouchingWatchedStatuses(fromTs, toTs) {
  const leadIds = new Set();
  let page = 1;
  for (;;) {
    const query =
      `/api/v4/events?filter[type]=lead_status_changed` +
      `&filter[created_at][from]=${fromTs}` +
      `&filter[created_at][to]=${toTs}` +
      `&limit=${PAGE_LIMIT}&page=${page}`;
    const data = await amoRequest(query);
    const events = data?._embedded?.events || [];
    for (const event of events) {
      const before = event.value_before?.[0]?.lead_status;
      const after = event.value_after?.[0]?.lead_status;
      const beforeKey = before && `${before.pipeline_id}:${before.id}`;
      const afterKey = after && `${after.pipeline_id}:${after.id}`;
      if (WATCHED_KEYS.has(beforeKey) || WATCHED_KEYS.has(afterKey)) {
        leadIds.add(event.entity_id);
      }
    }
    if (events.length < PAGE_LIMIT) break;
    page += 1;
  }
  return leadIds;
}

async function isLinkFieldAlreadyFilled(leadId) {
  const lead = await amoRequest(`/api/v4/leads/${leadId}?with=custom_fields_values`);
  const field = (lead?.custom_fields_values || []).find((f) => f.field_id === LINK_FIELD_ID);
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
  const nowTs = Math.floor(Date.now() / 1000);
  const filled = new Set(state.filledLeadIds || []);

  if (!state.initialized) {
    const currentlyThere = await fetchLeadsCurrentlyAtWatchedStatuses();
    for (const id of currentlyThere) filled.add(id);
    saveState({ initialized: true, lastCheckedAt: nowTs, filledLeadIds: [...filled] });
    console.log(
      `Baseline run: recorded ${currentlyThere.size} existing lead(s) at the watched statuses as ` +
        `already handled. They will be left untouched; only leads arriving after now will get the link.`
    );
    return;
  }

  const [currentlyThere, recentlyTouched] = await Promise.all([
    fetchLeadsCurrentlyAtWatchedStatuses(),
    fetchLeadsTouchingWatchedStatuses(state.lastCheckedAt, nowTs),
  ]);
  const candidates = new Set([...currentlyThere, ...recentlyTouched]);

  let filledCount = 0;
  for (const leadId of candidates) {
    if (filled.has(leadId)) continue;
    filled.add(leadId);
    if (await isLinkFieldAlreadyFilled(leadId)) continue; // don't overwrite a manual value
    const link = await setLeadLinkField(leadId);
    filledCount += 1;
    console.log(`Lead ${leadId}: set "Ссылка на сделку" = ${link}`);
  }

  saveState({ initialized: true, lastCheckedAt: nowTs, filledLeadIds: [...filled] });
  console.log(
    `Done. ${candidates.size} candidate lead(s) this run, filled ${filledCount} new one(s).`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
