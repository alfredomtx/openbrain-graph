import { Cosmograph, prepareCosmographData } from '@cosmograph/cosmograph';
import { createClient } from '@supabase/supabase-js';

// --- Supabase Auth ---
const SUPABASE_URL = 'https://hkcsepatkmpkvxyvatfn.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhrY3NlcGF0a21wa3Z4eXZhdGZuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI1ODY4MjQsImV4cCI6MjA4ODE2MjgyNH0.GOqC4yZzIaXKbvCYtB74sNOb19cvchTm5P_i3jO4ZNQ';
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON);
const EDGE_FUNCTION_URL = `${SUPABASE_URL}/functions/v1/open-brain-graph-data`;

// --- Colors (hex for display, RGBA arrays for Cosmograph) ---
const ENTITY_COLORS = {
  person: '#06b6d4', project: '#a855f7', tool: '#3b82f6', company: '#f59e0b',
  concept: '#22c55e', location: '#f97316', default: '#8b5cf6',
};

// Convert hex color to [r, g, b, a] array for Cosmograph v2 direct strategy
function hexToRGBA(hex) {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
    255,
  ];
}

const ENTITY_COLORS_RGBA = Object.fromEntries(
  Object.entries(ENTITY_COLORS).map(([k, v]) => [k, hexToRGBA(v)])
);

const RELATION_COLORS = {
  works_at: '#f59e0b', uses: '#3b82f6', created: '#a855f7', owns: '#ef4444',
  knows: '#06b6d4', part_of: '#22c55e', depends_on: '#f97316', interested_in: '#ec4899',
  lives_in: '#f97316', learning: '#3b82f6', member_of: '#22c55e', built_with: '#a855f7',
  manages: '#ef4444', studies: '#3b82f6', talks_to: '#06b6d4', located_in: '#f97316', default: '#64748b',
};

// --- Media ---
const MEDIA_BADGES = { text: '📝', image: '📷', video: '🎬', audio: '🔊' };
let activeMediaTypes = new Set(['text', 'image', 'video', 'audio']);
let entitiesWithMedia = new Set();

// --- State ---
let cosmo = null;
let allData = { entities: [], relationships: [], thoughts: [], thoughtEntities: [] };
let entityById = new Map();
let relsByEntityId = new Map();
let currentPanelEntityId = null;
let activeEntityTypes = new Set();
let minConnections = 0;
let minMentions = 0;

// --- Helpers ---
function truncate(str, n) { return str && str.length > n ? str.slice(0, n) + '...' : str; }
function formatDate(iso) { return new Date(iso).toLocaleString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' }); }

// --- Fetch ---
async function fetchData() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Not authenticated');
  const res = await fetch(`${EDGE_FUNCTION_URL}?view=all`, {
    headers: { 'Authorization': `Bearer ${session.access_token}` }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// --- Build indexes ---
function buildIndexes() {
  entityById.clear();
  relsByEntityId.clear();
  allData.entities.forEach(e => entityById.set(e.id, e));
  allData.relationships.forEach(r => {
    if (!relsByEntityId.has(r.source_id)) relsByEntityId.set(r.source_id, []);
    if (!relsByEntityId.has(r.target_id)) relsByEntityId.set(r.target_id, []);
    relsByEntityId.get(r.source_id).push({ ...r, _dir: 'out' });
    relsByEntityId.get(r.target_id).push({ ...r, _dir: 'in' });
  });
}

// --- Connection count per entity ---
function getConnectionCount(entityId) {
  return (relsByEntityId.get(entityId) || []).length;
}

// --- Get filtered entities/relationships ---
function getFilteredData() {
  const entities = allData.entities.filter(e => {
    if (!activeEntityTypes.has(e.type)) return false;
    if ((e.mention_count || 0) < minMentions) return false;
    if (getConnectionCount(e.id) < minConnections) return false;
    return true;
  });
  const entityIds = new Set(entities.map(e => e.id));
  const relationships = allData.relationships.filter(r =>
    entityIds.has(r.source_id) && entityIds.has(r.target_id) && r.source_id !== r.target_id
  );
  return { entities, relationships };
}

// --- Media helpers ---
function computeEntitiesWithMedia() {
  entitiesWithMedia.clear();
  const mediaThoughtIds = new Set(
    allData.thoughts.filter(t => t.media_type && t.media_type !== 'text').map(t => t.id)
  );
  allData.thoughtEntities.forEach(te => {
    if (mediaThoughtIds.has(te.thought_id)) entitiesWithMedia.add(te.entity_id);
  });
}

function renderThought(t) {
  const mediaType = t.media_type || 'text';
  const badge = MEDIA_BADGES[mediaType] || MEDIA_BADGES.text;
  let mediaHtml = '';

  if (mediaType === 'image') {
    const src = t.media_thumbnail || t.media_url;
    if (src) {
      mediaHtml = `<a class="thought-media-link" href="${t.media_url}" target="_blank">
        <div class="thought-img-wrap"><img class="thought-thumb" src="${src}" alt="" loading="lazy" /></div>
      </a>`;
    } else {
      mediaHtml = `<div class="thought-thumb-placeholder">📷</div>`;
    }
  } else if (mediaType === 'video') {
    const thumb = t.media_thumbnail;
    mediaHtml = `<a class="thought-media-link" href="${t.media_url || '#'}" target="_blank">
      <div class="thought-video-wrap">
        ${thumb ? `<img class="thought-thumb" src="${thumb}" alt="" loading="lazy" />` : `<div class="thought-thumb-placeholder">🎬</div>`}
        <div class="thought-play-overlay">▶</div>
      </div>
    </a>`;
  } else if (mediaType === 'audio' && t.media_url) {
    mediaHtml = `<div class="thought-audio-wrap"><audio class="thought-audio" controls preload="none" src="${t.media_url}"></audio></div>`;
  }

  return `<div class="linked-thought${mediaType !== 'text' ? ' has-media' : ''}">
    <div class="thought-header">
      <span class="thought-badge">${badge}</span>
      <span class="thought-text">${truncate(t.content, 120)}</span>
    </div>
    ${mediaHtml}
  </div>`;
}

function buildMediaFilters() {
  const container = document.getElementById('media-type-filters');
  if (!container) return;
  container.innerHTML = '';

  const counts = { text: 0, image: 0, video: 0, audio: 0 };
  allData.thoughts.forEach(t => {
    const mt = t.media_type || 'text';
    if (counts[mt] !== undefined) counts[mt]++;
  });

  Object.entries(MEDIA_BADGES).forEach(([type, icon]) => {
    const label = document.createElement('label');
    label.className = 'type-filter';
    label.innerHTML = `
      <input type="checkbox" checked data-media-type="${type}" />
      <span class="thought-badge">${icon}</span>
      <span class="type-name">${type}</span>
      <span class="type-count">${counts[type]}</span>
    `;
    label.querySelector('input').addEventListener('change', (e) => {
      if (e.target.checked) activeMediaTypes.add(type);
      else activeMediaTypes.delete(type);
      if (currentPanelEntityId) {
        const entity = entityById.get(currentPanelEntityId);
        if (entity) showPanel(entity.id);
      }
    });
    container.appendChild(label);
  });
}

function getMediaStats() {
  const counts = { image: 0, video: 0, audio: 0 };
  allData.thoughts.forEach(t => {
    const mt = t.media_type || 'text';
    if (counts[mt] !== undefined) counts[mt]++;
  });
  let parts = [];
  if (counts.image) parts.push(`📷 ${counts.image}`);
  if (counts.video) parts.push(`🎬 ${counts.video}`);
  if (counts.audio) parts.push(`🔊 ${counts.audio}`);
  return parts.length ? ` · ${parts.join(' · ')}` : '';
}

// --- Panel ---
function showPanel(entityId) {
  currentPanelEntityId = entityId;
  const entity = entityById.get(entityId);
  if (!entity) return;

  const panel = document.getElementById('panel');
  const typeEl = document.getElementById('panel-type');
  typeEl.textContent = entity.type;
  typeEl.style.color = ENTITY_COLORS[entity.type] || ENTITY_COLORS.default;
  document.getElementById('panel-content').textContent = entity.name;

  let html = '';
  html += `<div class="meta-label">Mentions</div><span>${entity.mention_count || 0}</span>`;
  html += `<div class="meta-label">First seen</div><span style="color:#666">${formatDate(entity.created_at)}</span>`;

  // Relationships
  const rels = relsByEntityId.get(entityId) || [];
  if (rels.length) {
    html += `<div class="meta-label">Relationships</div><div class="rel-list">`;
    rels.forEach(r => {
      const otherId = r._dir === 'out' ? r.target_id : r.source_id;
      const other = entityById.get(otherId);
      if (!other) return;
      const direction = r._dir === 'out' ? '→' : '←';
      const color = RELATION_COLORS[r.relation] || RELATION_COLORS.default;
      html += `<div class="rel-item">
        <span style="color:${color}">${r.relation}</span>
        <span class="rel-dir">${direction}</span>
        <span style="color:${ENTITY_COLORS[other.type] || '#888'}">${other.name}</span>
      </div>`;
    });
    html += `</div>`;
  }

  // Linked thoughts (with media filter)
  const entityLinks = allData.thoughtEntities.filter(te => te.entity_id === entityId);
  const allLinkedThoughts = entityLinks
    .map(te => allData.thoughts.find(t => t.id === te.thought_id))
    .filter(Boolean);
  const filteredThoughts = allLinkedThoughts.filter(t => activeMediaTypes.has(t.media_type || 'text'));

  if (allLinkedThoughts.length) {
    const mediaIndicator = entitiesWithMedia.has(entityId) ? ' <span class="media-indicator">✦ has media</span>' : '';
    html += `<div class="meta-label">Linked Memories (${filteredThoughts.length}/${allLinkedThoughts.length})${mediaIndicator}</div><div class="linked-thoughts">`;
    filteredThoughts.slice(0, 8).forEach(t => {
      html += renderThought(t);
    });
    if (filteredThoughts.length > 8) html += `<div style="color:#555;font-size:11px;margin-top:4px">+${filteredThoughts.length - 8} more</div>`;
    html += `</div>`;
  }

  document.getElementById('panel-meta').innerHTML = html;
  panel.classList.remove('hidden');
}

function hidePanel() {
  currentPanelEntityId = null;
  document.getElementById('panel').classList.add('hidden');
}

// --- Stats + Legend ---
function updateStats(visibleCount) {
  const e = allData.entities, r = allData.relationships;
  document.getElementById('stat-total').textContent =
    `${e.length} entities · ${r.length} relationships · ${allData.thoughts.length} memories${getMediaStats()}`;
  const vc = document.getElementById('visible-count');
  if (vc) vc.textContent = visibleCount !== undefined ? `Showing ${visibleCount} entities` : '';
}

function buildLegend() {
  const container = document.getElementById('legend-items');
  if (!container) return;
  container.innerHTML = '';
  const types = [...new Set(allData.entities.map(e => e.type))];
  types.forEach(type => {
    const item = document.createElement('div');
    item.className = 'legend-item';
    item.innerHTML = `<div class="legend-dot" style="background:${ENTITY_COLORS[type] || ENTITY_COLORS.default}"></div><span>${type}</span>`;
    container.appendChild(item);
  });
}

// --- Filters UI ---
function buildEntityTypeFilters() {
  const container = document.getElementById('type-filters');
  if (!container) return;
  container.innerHTML = '';

  const types = [...new Set(allData.entities.map(e => e.type))];
  types.forEach(type => {
    activeEntityTypes.add(type);
    const counts = allData.entities.filter(e => e.type === type).length;
    const label = document.createElement('label');
    label.className = 'type-filter';
    label.innerHTML = `
      <input type="checkbox" checked data-entity-type="${type}" />
      <div class="legend-dot" style="background:${ENTITY_COLORS[type] || ENTITY_COLORS.default}"></div>
      <span class="type-name">${type}</span>
      <span class="type-count">${counts}</span>
    `;
    label.querySelector('input').addEventListener('change', (e) => {
      if (e.target.checked) activeEntityTypes.add(type);
      else activeEntityTypes.delete(type);
      refreshGraph();
    });
    container.appendChild(label);
  });
}

function initSliders() {
  const minConnInput = document.getElementById('min-connections');
  const minConnVal = document.getElementById('min-conn-val');
  const minMentInput = document.getElementById('min-mentions');
  const minMentVal = document.getElementById('min-mentions-val');

  if (minConnInput) {
    minConnInput.addEventListener('input', () => {
      minConnections = parseInt(minConnInput.value);
      minConnVal.textContent = minConnections;
      refreshGraph();
    });
  }
  if (minMentInput) {
    minMentInput.addEventListener('input', () => {
      minMentions = parseInt(minMentInput.value);
      minMentVal.textContent = minMentions;
      refreshGraph();
    });
  }
}

// --- Cosmograph init/update ---
async function initCosmograph(entities, relationships) {
  const container = document.getElementById('graph-container');

  const points = entities.map(e => ({
    id: e.id,
    label: e.name + (entitiesWithMedia.has(e.id) ? ' ✦' : ''),
    type: e.type,
    size: 4 + Math.min(12, (e.mention_count || 1) * 1.5),
  }));

  const links = relationships.map(r => ({
    source: r.source_id,
    target: r.target_id,
    relation: r.relation,
  }));

  const dataConfig = {
    points: { pointIdBy: 'id' },
    links: { linkSourceBy: 'source', linkTargetsBy: ['target'] },
  };

  const result = await prepareCosmographData(dataConfig, points, links);
  const { points: preparedPoints, links: preparedLinks, cosmographConfig } = result;

  if (cosmo) {
    cosmo.destroy();
    cosmo = null;
    container.innerHTML = '';
  }

  cosmo = new Cosmograph(container, {
    ...cosmographConfig,
    points: preparedPoints,
    links: preparedLinks,
    pointColorBy: 'type',
    pointColorByMap: new Map(Object.entries(ENTITY_COLORS)),
    pointColorStrategy: 'map',
    pointSizeBy: 'size',
    pointSizeStrategy: 'direct',
    pointLabelBy: 'label',
    pointLabelColor: '#cccccc',
    backgroundColor: '#0a0a0f',
    simulationIsRunning: true,
    linkColor: '#1e1e2e',
    linkWidth: 0.5,
    selectPointOnClick: 'connected',
    resetSelectionOnEmptyCanvasClick: true,
    onPointClick: (point) => {
      if (point && point.id) {
        showPanel(point.id);
      } else {
        hidePanel();
      }
    },
    onCanvasClick: () => {
      hidePanel();
    },
  });
}

async function refreshGraph() {
  const { entities, relationships } = getFilteredData();
  updateStats(entities.length);
  await initCosmograph(entities, relationships);
}

// --- Search ---
function initSearch() {
  const input = document.getElementById('search');
  const results = document.getElementById('search-results');

  input.addEventListener('input', () => {
    const q = input.value.toLowerCase().trim();
    if (!q) { results.classList.remove('visible'); return; }

    const matches = allData.entities.filter(e =>
      e.name.toLowerCase().includes(q) || e.type.toLowerCase().includes(q)
    );

    results.innerHTML = '';
    if (!matches.length) {
      results.innerHTML = `<div class="search-item"><div class="si-text" style="color:#555">No results</div></div>`;
    } else {
      matches.slice(0, 8).forEach(item => {
        const div = document.createElement('div');
        div.className = 'search-item';
        div.innerHTML = `<div class="si-type">${item.type}</div><div class="si-text">${item.name}</div>`;
        div.addEventListener('click', () => {
          results.classList.remove('visible');
          input.value = '';
          showPanel(item.id);
        });
        results.appendChild(div);
      });
    }
    results.classList.add('visible');
  });

  input.addEventListener('blur', () => setTimeout(() => results.classList.remove('visible'), 200));
}

// --- Empty State ---
function showEmptyState() {
  const container = document.getElementById('graph-container');
  container.innerHTML = `
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:#555;gap:12px;">
      <div style="font-size:3em;">🧠</div>
      <div style="font-size:1.2em;color:#888;">No entities yet</div>
      <div style="font-size:0.85em;max-width:400px;text-align:center;line-height:1.6;">
        Your knowledge graph will populate automatically as you chat with Miato.
        Entities (people, projects, tools) and their relationships are extracted from every conversation.
      </div>
    </div>
  `;
}

// --- Auth + Main ---
async function checkAuth() {
  const { data: { session } } = await supabase.auth.getSession();
  if (session) return session;

  document.getElementById('loading').style.display = 'none';
  document.getElementById('login-screen').style.display = 'flex';

  return new Promise((resolve) => {
    document.getElementById('login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('login-email').value;
      const password = document.getElementById('login-password').value;
      const errorEl = document.getElementById('login-error');
      errorEl.textContent = '';
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) { errorEl.textContent = error.message; return; }
      document.getElementById('login-screen').style.display = 'none';
      document.getElementById('loading').style.display = 'flex';
      resolve(data.session);
    });
  });
}

async function main() {
  await checkAuth();

  document.getElementById('logout-btn')?.addEventListener('click', async () => {
    await supabase.auth.signOut(); window.location.reload();
  });
  document.getElementById('panel-close').addEventListener('click', () => {
    hidePanel();
  });
  initSearch();

  const loadingText = document.getElementById('loading-text');
  loadingText.textContent = 'Fetching knowledge graph...';

  try {
    const data = await fetchData();
    allData.entities = data.entities || [];
    allData.relationships = data.relationships || [];
    allData.thoughts = data.thoughts || [];
    allData.thoughtEntities = data.thoughtEntities || [];

    if (!allData.entities.length) {
      const loading = document.getElementById('loading');
      loading.classList.add('fade-out');
      setTimeout(() => loading.remove(), 500);
      showEmptyState();
      return;
    }

    loadingText.textContent = `Laying out ${allData.entities.length} entities...`;
    console.log('[OpenBrain] Computing media...');
    computeEntitiesWithMedia();
    console.log('[OpenBrain] Building indexes...');
    buildIndexes();
    console.log('[OpenBrain] Building type filters...');
    buildEntityTypeFilters();
    console.log('[OpenBrain] Init sliders...');
    initSliders();
    console.log('[OpenBrain] Build legend...');
    buildLegend();
    console.log('[OpenBrain] Build media filters...');
    buildMediaFilters();
    console.log('[OpenBrain] Update stats...');
    updateStats(allData.entities.length);

    console.log('[OpenBrain] Init Cosmograph...');
    const { entities, relationships } = getFilteredData();
    await initCosmograph(entities, relationships);
    console.log('[OpenBrain] Cosmograph ready!');

    const loading = document.getElementById('loading');
    loading.classList.add('fade-out');
    setTimeout(() => loading.remove(), 500);
  } catch (err) {
    console.error('[OpenBrain] Error:', err);
    if (loadingText) {
      loadingText.textContent = `Error: ${err.message}`;
      loadingText.style.color = '#ef4444';
    }
  }
}

main();
