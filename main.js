import { Cosmograph } from '@cosmograph/cosmograph';
import { createClient } from '@supabase/supabase-js';

// --- Supabase Auth ---
const SUPABASE_URL = 'https://hkcsepatkmpkvxyvatfn.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhrY3NlcGF0a21wa3Z4eXZhdGZuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI1ODY4MjQsImV4cCI6MjA4ODE2MjgyNH0.GOqC4yZzIaXKbvCYtB74sNOb19cvchTm5P_i3jO4ZNQ';
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON);
const EDGE_FUNCTION_URL = `${SUPABASE_URL}/functions/v1/open-brain-graph-data`;

// --- Colors ---
const ENTITY_COLORS = {
  person: '#06b6d4', project: '#a855f7', tool: '#3b82f6', company: '#f59e0b',
  concept: '#22c55e', location: '#f97316', default: '#8b5cf6',
};

const RELATION_COLORS = {
  works_at: '#f59e0b', uses: '#3b82f6', created: '#a855f7', owns: '#ef4444',
  knows: '#06b6d4', part_of: '#22c55e', depends_on: '#f97316', interested_in: '#ec4899',
  lives_in: '#f97316', learning: '#3b82f6', member_of: '#22c55e', built_with: '#a855f7',
  manages: '#ef4444', studies: '#3b82f6', talks_to: '#06b6d4', located_in: '#f97316', default: '#64748b',
};

const HIDDEN_COLOR = [10, 10, 15, 0]; // fully transparent
const DIM_COLOR = [40, 40, 60, 0.08]; // dimmed when hovering

// Hover state
let hoveredEntityId = null;

// --- State ---
let cosmograph = null;
let allData = { entities: [], relationships: [], thoughts: [], thoughtEntities: [] };
let activeTypes = new Set();
let minConnections = 0;
let minMentions = 0;
let activeMediaTypes = new Set(['text', 'image', 'video', 'audio']); // which media types to show in panels
let entitiesWithMedia = new Set(); // entity ids that have non-text thoughts

// All points/links loaded once — we track which entity index maps to which entity
let allPoints = [];
let allLinks = [];
let entityById = new Map(); // id -> entity object
let visibleIds = new Set(); // currently visible entity ids

// --- Helpers ---
function truncate(str, n) { return str && str.length > n ? str.slice(0, n) + '...' : str; }
function formatDate(iso) { return new Date(iso).toLocaleString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' }); }

// --- Fetch ---
async function fetchData() {
  // Try refreshing the session first in case token expired
  const { data: { session }, error } = await supabase.auth.getSession();
  if (!session) {
    // Try refreshing
    const { data: refreshData } = await supabase.auth.refreshSession();
    if (!refreshData?.session) throw new Error('Not authenticated');
    return doFetch(refreshData.session.access_token);
  }
  return doFetch(session.access_token);
}

async function doFetch(token) {
  const res = await fetch(`${EDGE_FUNCTION_URL}?view=all`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  if (res.status === 401) {
    // Token expired mid-flight, try refresh once
    const { data: refreshData } = await supabase.auth.refreshSession();
    if (!refreshData?.session) throw new Error('Session expired — please log in again');
    const retry = await fetch(`${EDGE_FUNCTION_URL}?view=all`, {
      headers: { 'Authorization': `Bearer ${refreshData.session.access_token}` }
    });
    if (!retry.ok) throw new Error(`HTTP ${retry.status}`);
    return retry.json();
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// --- Connection counts ---
function getConnectionCounts() {
  const counts = new Map();
  allData.entities.forEach(e => counts.set(e.id, 0));
  allData.relationships.forEach(r => {
    if (counts.has(r.source_id)) counts.set(r.source_id, counts.get(r.source_id) + 1);
    if (counts.has(r.target_id)) counts.set(r.target_id, counts.get(r.target_id) + 1);
  });
  return counts;
}

// --- Compute visible set based on filters ---
function computeVisibleIds() {
  const connCounts = getConnectionCounts();
  visibleIds = new Set();
  allData.entities.forEach(e => {
    if (!activeTypes.has(e.type)) return;
    if ((connCounts.get(e.id) || 0) < minConnections) return;
    if ((e.mention_count || 0) < minMentions) return;
    visibleIds.add(e.id);
  });

  const count = visibleIds.size;
  document.getElementById('visible-count').textContent =
    `Showing ${count} / ${allData.entities.length} entities`;
}

// --- Build ALL points/links once ---
function buildAllPointsAndLinks() {
  const connCounts = getConnectionCounts();
  const idToIndex = new Map();

  allPoints = allData.entities.map((e, i) => {
    idToIndex.set(e.id, i);
    entityById.set(e.id, e);
    const hasMedia = entitiesWithMedia.has(e.id);
    return {
      id: e.id,
      index: i,
      label: hasMedia ? `${e.name} ✦` : e.name,
      type: e.type,
      color: ENTITY_COLORS[e.type] || ENTITY_COLORS.default,
      size: Math.max(1, (e.mention_count || 1)),
      hasMedia,
      visible: 1,
    };
  });

  // Deduplicate links
  const edgeSet = new Set();
  allLinks = [];
  allData.relationships.forEach(r => {
    if (r.source_id === r.target_id) return;
    if (!idToIndex.has(r.source_id) || !idToIndex.has(r.target_id)) return;
    const key = `${r.source_id}->${r.target_id}`;
    if (edgeSet.has(key)) return;
    edgeSet.add(key);
    allLinks.push({
      source: r.source_id,
      target: r.target_id,
      sourceIndex: idToIndex.get(r.source_id),
      targetIndex: idToIndex.get(r.target_id),
      relation: r.relation,
      color: RELATION_COLORS[r.relation] || RELATION_COLORS.default,
    });
  });
}

// --- Neighbor lookup ---
let neighborMap = new Map(); // entityId -> Set of neighbor entityIds

function buildNeighborMap() {
  neighborMap.clear();
  allLinks.forEach(l => {
    if (!neighborMap.has(l.source)) neighborMap.set(l.source, new Set());
    if (!neighborMap.has(l.target)) neighborMap.set(l.target, new Set());
    neighborMap.get(l.source).add(l.target);
    neighborMap.get(l.target).add(l.source);
  });
}

function isNeighbor(entityId, otherId) {
  return neighborMap.get(entityId)?.has(otherId) || false;
}

// --- Cosmograph init (once, with ALL data) ---
function initCosmograph() {
  const container = document.getElementById('graph-container');

  cosmograph = new Cosmograph(container, {
    backgroundColor: '#0a0a0f',

    // Data — ALL entities, always
    points: allPoints,
    links: allLinks,

    // Points config
    pointIdBy: 'id',
    pointIndexBy: 'index',
    pointLabelBy: 'label',
    pointSizeBy: 'size',
    pointSizeRange: [16, 45],
    pointLabelWeightBy: 'size',
    pointClusterBy: 'type',
    pointIncludeColumns: ['*'],

    // Dynamic color: visible nodes get their color, hidden get transparent, dimmed on hover
    pointColorBy: 'id',
    pointColorByFn: (id) => {
      if (!visibleIds.has(id)) return HIDDEN_COLOR;
      if (hoveredEntityId) {
        // Hovered node or its neighbors stay bright, rest dim
        if (id === hoveredEntityId || isNeighbor(hoveredEntityId, id)) {
          const e = entityById.get(id);
          return e ? (ENTITY_COLORS[e.type] || ENTITY_COLORS.default) : HIDDEN_COLOR;
        }
        return DIM_COLOR;
      }
      const e = entityById.get(id);
      return e ? (ENTITY_COLORS[e.type] || ENTITY_COLORS.default) : HIDDEN_COLOR;
    },

    // Dynamic size: hidden nodes get size 0, visible get scaled up
    pointSizeByFn: (size, index) => {
      const point = allPoints[index];
      if (!point || !visibleIds.has(point.id)) return 0;
      // Scale: min 16, max 45, based on mention count
      return Math.min(45, 16 + size * 3);
    },

    // Links config
    linkSourceBy: 'source',
    linkTargetBy: 'target',
    linkSourceIndexBy: 'sourceIndex',
    linkTargetIndexBy: 'targetIndex',
    linkWidthRange: [1, 4],

    // Dynamic link color: hide/dim based on visibility + hover
    linkColorBy: 'color',
    linkColorByFn: (color, index) => {
      const link = allLinks[index];
      if (!link) return HIDDEN_COLOR;
      if (!visibleIds.has(link.source) || !visibleIds.has(link.target)) return HIDDEN_COLOR;
      if (hoveredEntityId) {
        if (link.source === hoveredEntityId || link.target === hoveredEntityId) {
          return '#ffffff'; // bright white for connected links
        }
        return DIM_COLOR;
      }
      return color;
    },

    linkArrowByFn: () => true,

    // Simulation — tight + fast settle
    simulationGravity: 0.5,
    simulationRepulsion: 0.3,
    simulationLinkSpring: 1.75,
    simulationFriction: 0.7,
    simulationDecay: 3000,

    // Display
    showDynamicLabels: true,
    pointLabelColor: '#cccccc',
    hoveredPointRingColor: '#a78bfa',
    focusedPointRingColor: '#7c3aed',
    fitViewOnInit: true,
    fitViewDelay: 1000,
    fitViewPadding: 0.05,

    // Events — use ID-based lookup, works regardless of filter state
    onClick: (pointIndex) => {
      if (pointIndex !== undefined && pointIndex < allPoints.length) {
        const point = allPoints[pointIndex];
        const entity = entityById.get(point.id);
        if (entity && visibleIds.has(entity.id)) {
          showPanel(entity);
        } else {
          hidePanel();
        }
      } else {
        hidePanel();
      }
    },
    onPointMouseOver: (pointIndex) => {
      if (pointIndex !== undefined && pointIndex < allPoints.length) {
        const point = allPoints[pointIndex];
        if (visibleIds.has(point.id)) {
          hoveredEntityId = point.id;
          refreshColors();
        }
      }
    },
    onPointMouseOut: () => {
      hoveredEntityId = null;
      refreshColors();
    },
    onLabelClick: (pointIndex) => {
      if (pointIndex !== undefined && pointIndex < allPoints.length) {
        const point = allPoints[pointIndex];
        const entity = entityById.get(point.id);
        if (entity && visibleIds.has(entity.id)) {
          showPanel(entity);
        }
      }
    },
  });

  // Wait for data to upload before enabling hover, then settle
  cosmograph.dataUploaded().then(() => {
    graphReady = true;
    // Pause simulation + fit view after brief settle
    setTimeout(() => {
      if (cosmograph) {
        cosmograph.pause();
        cosmograph.fitView(500, 0.05);
      }
    }, 3000);
  }).catch(() => {
    graphReady = true; // still enable hover even if upload had issues
  });
}

// --- Refresh colors (for hover state changes) ---
let graphReady = false;

function refreshColors() {
  if (!cosmograph || !graphReady) return;
  cosmograph.setConfig({
    pointColorByFn: (id) => {
      if (!visibleIds.has(id)) return HIDDEN_COLOR;
      if (hoveredEntityId) {
        if (id === hoveredEntityId || isNeighbor(hoveredEntityId, id)) {
          const e = entityById.get(id);
          return e ? (ENTITY_COLORS[e.type] || ENTITY_COLORS.default) : HIDDEN_COLOR;
        }
        return DIM_COLOR;
      }
      const e = entityById.get(id);
      return e ? (ENTITY_COLORS[e.type] || ENTITY_COLORS.default) : HIDDEN_COLOR;
    },
    linkColorByFn: (color, index) => {
      const link = allLinks[index];
      if (!link) return HIDDEN_COLOR;
      if (!visibleIds.has(link.source) || !visibleIds.has(link.target)) return HIDDEN_COLOR;
      if (hoveredEntityId) {
        if (link.source === hoveredEntityId || link.target === hoveredEntityId) return '#ffffff';
        return DIM_COLOR;
      }
      return color;
    },
  });
}

// --- Apply filter (just re-evaluate color/size fns, no data reload) ---
function applyFilter() {
  computeVisibleIds();
  if (!cosmograph || !graphReady) return;

  // Re-trigger the accessor functions by re-setting them
  // This forces Cosmograph to re-evaluate pointColorByFn and pointSizeByFn
  cosmograph.setConfig({
    pointColorBy: 'id',
    pointColorByFn: (id) => {
      if (!visibleIds.has(id)) return HIDDEN_COLOR;
      const e = entityById.get(id);
      return e ? (ENTITY_COLORS[e.type] || ENTITY_COLORS.default) : HIDDEN_COLOR;
    },
    pointSizeByFn: (size, index) => {
      const point = allPoints[index];
      if (!point || !visibleIds.has(point.id)) return 0;
      return Math.min(45, 16 + size * 3);
    },
    linkColorByFn: (color, index) => {
      const link = allLinks[index];
      if (!link) return HIDDEN_COLOR;
      if (!visibleIds.has(link.source) || !visibleIds.has(link.target)) return HIDDEN_COLOR;
      return color;
    },
  });
}

// --- Media badge helpers ---
const MEDIA_ICONS = { text: '📝', image: '📷', video: '🎬', audio: '🔊' };

function renderThought(t) {
  const mt = t.media_type || 'text';
  const icon = MEDIA_ICONS[mt] || '📝';
  const hasMedia = mt !== 'text' && t.media_url;

  let mediaHtml = '';
  if (mt === 'image' && t.media_url) {
    const thumb = t.media_thumbnail || t.media_url;
    mediaHtml = `
      <a href="${t.media_url}" target="_blank" rel="noopener" class="thought-media-link">
        <div class="thought-img-wrap">
          <img src="${thumb}" alt="Image memory" class="thought-thumb" loading="lazy" />
        </div>
      </a>`;
  } else if (mt === 'video' && t.media_url) {
    const thumb = t.media_thumbnail || '';
    mediaHtml = `
      <a href="${t.media_url}" target="_blank" rel="noopener" class="thought-media-link">
        <div class="thought-video-wrap">
          ${thumb ? `<img src="${thumb}" alt="Video thumbnail" class="thought-thumb" loading="lazy" />` : `<div class="thought-thumb-placeholder">🎬</div>`}
          <div class="thought-play-overlay">▶</div>
        </div>
      </a>`;
  } else if (mt === 'audio' && t.media_url) {
    mediaHtml = `
      <div class="thought-audio-wrap">
        <audio controls preload="none" class="thought-audio">
          <source src="${t.media_url}" />
          Your browser does not support audio.
        </audio>
      </div>`;
  }

  return `<div class="linked-thought ${hasMedia ? 'has-media' : ''}">
    <div class="thought-header">
      <span class="thought-badge">${icon}</span>
      <span class="thought-text">${truncate(t.content, 120)}</span>
    </div>
    ${mediaHtml}
  </div>`;
}

// --- Panel ---
function showPanel(entity) {
  if (!entity) return;
  const panel = document.getElementById('panel');
  document.getElementById('panel-type').textContent = entity.type;
  document.getElementById('panel-type').style.color = ENTITY_COLORS[entity.type] || ENTITY_COLORS.default;
  document.getElementById('panel-content').textContent = entity.name;

  const connCounts = getConnectionCounts();

  let html = '';
  html += `<div class="meta-label">Mentions</div><span>${entity.mention_count || 0}</span>`;
  html += `<div class="meta-label">Connections</div><span>${connCounts.get(entity.id) || 0}</span>`;
  html += `<div class="meta-label">First seen</div><span style="color:#666">${formatDate(entity.created_at)}</span>`;

  const rels = allData.relationships.filter(r => r.source_id === entity.id || r.target_id === entity.id);
  if (rels.length) {
    html += `<div class="meta-label">Relationships (${rels.length})</div><div class="rel-list">`;
    rels.forEach(r => {
      const isSource = r.source_id === entity.id;
      const otherId = isSource ? r.target_id : r.source_id;
      const other = entityById.get(otherId);
      if (!other) return;
      const direction = isSource ? '→' : '←';
      const relColor = RELATION_COLORS[r.relation] || RELATION_COLORS.default;
      const otherColor = ENTITY_COLORS[other.type] || ENTITY_COLORS.default;
      html += `<div class="rel-item">
        <span style="color:${relColor}">${r.relation}</span>
        <span class="rel-dir">${direction}</span>
        <span style="color:${otherColor}">${other.name}</span>
      </div>`;
    });
    html += `</div>`;
  }

  const entityLinks = allData.thoughtEntities.filter(te => te.entity_id === entity.id);
  if (entityLinks.length) {
    const allLinkedThoughts = entityLinks
      .map(te => allData.thoughts.find(t => t.id === te.thought_id))
      .filter(Boolean);

    // Filter by active media types
    const filteredThoughts = allLinkedThoughts.filter(t => {
      const mt = t.media_type || 'text';
      return activeMediaTypes.has(mt);
    });

    const mediaIndicator = entitiesWithMedia.has(entity.id) ? ' <span class="media-indicator" title="Has media content">✦</span>' : '';
    html += `<div class="meta-label">Linked Memories (${filteredThoughts.length}/${entityLinks.length})${mediaIndicator}</div>`;

    if (filteredThoughts.length === 0) {
      html += `<div style="color:#555;font-size:11px;padding:6px 0">No memories match current media filter</div>`;
    } else {
      html += `<div class="linked-thoughts">`;
      filteredThoughts.slice(0, 10).forEach(t => {
        html += renderThought(t);
      });
      if (filteredThoughts.length > 10) html += `<div style="color:#555;font-size:11px;margin-top:4px">+${filteredThoughts.length - 10} more</div>`;
      html += `</div>`;
    }
  }

  document.getElementById('panel-meta').innerHTML = html;
  panel.classList.remove('hidden');
}

function hidePanel() { document.getElementById('panel').classList.add('hidden'); }

// --- Filter UI ---
function buildTypeFilters() {
  const container = document.getElementById('type-filters');
  container.innerHTML = '';
  const types = [...new Set(allData.entities.map(e => e.type))].sort();
  const typeCounts = {};
  allData.entities.forEach(e => { typeCounts[e.type] = (typeCounts[e.type] || 0) + 1; });

  types.forEach(type => {
    activeTypes.add(type);
    const label = document.createElement('label');
    label.className = 'type-filter';
    const color = ENTITY_COLORS[type] || ENTITY_COLORS.default;
    label.innerHTML = `
      <input type="checkbox" checked data-type="${type}" />
      <span class="type-dot" style="background:${color}"></span>
      <span class="type-name">${type}</span>
      <span class="type-count">${typeCounts[type]}</span>
    `;
    label.querySelector('input').addEventListener('change', (e) => {
      if (e.target.checked) activeTypes.add(type);
      else activeTypes.delete(type);
      applyFilter();
    });
    container.appendChild(label);
  });
}

function buildMediaFilters() {
  const container = document.getElementById('media-type-filters');
  if (!container) return;
  container.innerHTML = '';

  const mediaTypeCounts = { text: 0, image: 0, video: 0, audio: 0 };
  allData.thoughts.forEach(t => {
    const mt = t.media_type || 'text';
    if (mediaTypeCounts[mt] !== undefined) mediaTypeCounts[mt]++;
    else mediaTypeCounts.text++;
  });

  const MEDIA_COLORS = { text: '#a78bfa', image: '#06b6d4', video: '#f59e0b', audio: '#22c55e' };
  const MEDIA_LABELS = { text: 'Text', image: 'Image', video: 'Video', audio: 'Audio' };

  Object.entries(MEDIA_LABELS).forEach(([mt, label]) => {
    activeMediaTypes.add(mt);
    const lbl = document.createElement('label');
    lbl.className = 'type-filter';
    const color = MEDIA_COLORS[mt];
    lbl.innerHTML = `
      <input type="checkbox" checked data-mediatype="${mt}" />
      <span class="type-dot" style="background:${color}"></span>
      <span class="type-name">${MEDIA_ICONS[mt]} ${label}</span>
      <span class="type-count">${mediaTypeCounts[mt]}</span>
    `;
    lbl.querySelector('input').addEventListener('change', (e) => {
      if (e.target.checked) activeMediaTypes.add(mt);
      else activeMediaTypes.delete(mt);
      // Refresh panel if open
      const panel = document.getElementById('panel');
      if (!panel.classList.contains('hidden')) {
        // Re-render current panel — find the entity from panel content
        const entityName = document.getElementById('panel-content').textContent;
        const entity = allData.entities.find(e => e.name === entityName);
        if (entity) showPanel(entity);
      }
    });
    container.appendChild(lbl);
  });
}

function initFilters() {
  const connSlider = document.getElementById('min-connections');
  const connVal = document.getElementById('min-conn-val');
  connSlider.addEventListener('input', () => {
    minConnections = parseInt(connSlider.value);
    connVal.textContent = minConnections;
    applyFilter();
  });

  const mentionSlider = document.getElementById('min-mentions');
  const mentionVal = document.getElementById('min-mentions-val');
  mentionSlider.addEventListener('input', () => {
    minMentions = parseInt(mentionSlider.value);
    mentionVal.textContent = minMentions;
    applyFilter();
  });
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
    ).slice(0, 10);

    results.innerHTML = '';
    if (!matches.length) {
      results.innerHTML = `<div class="search-item"><div class="si-text" style="color:#555">No results</div></div>`;
    } else {
      matches.forEach(item => {
        const div = document.createElement('div');
        div.className = 'search-item';
        const color = ENTITY_COLORS[item.type] || ENTITY_COLORS.default;
        div.innerHTML = `<div class="si-type" style="color:${color}">${item.type}</div><div class="si-text">${item.name}</div>`;
        div.addEventListener('click', () => {
          results.classList.remove('visible');
          input.value = '';
          showPanel(item);
          if (cosmograph) {
            cosmograph.getPointIndicesByIds([item.id]).then(indices => {
              if (indices?.length) {
                cosmograph.selectPoint(indices[0]);
                cosmograph.zoomToPoint(indices[0], 500);
              }
            }).catch(() => {});
          }
        });
        results.appendChild(div);
      });
    }
    results.classList.add('visible');
  });

  input.addEventListener('blur', () => setTimeout(() => results.classList.remove('visible'), 200));
}

// --- Compute entities with media ---
function computeEntitiesWithMedia() {
  entitiesWithMedia.clear();
  const mediaThoughtIds = new Set(
    allData.thoughts
      .filter(t => t.media_type && t.media_type !== 'text')
      .map(t => t.id)
  );
  allData.thoughtEntities.forEach(te => {
    if (mediaThoughtIds.has(te.thought_id)) {
      entitiesWithMedia.add(te.entity_id);
    }
  });
}

// --- Stats ---
function updateStats() {
  const mediaTypeCounts = { text: 0, image: 0, video: 0, audio: 0 };
  allData.thoughts.forEach(t => {
    const mt = t.media_type || 'text';
    if (mediaTypeCounts[mt] !== undefined) mediaTypeCounts[mt]++;
    else mediaTypeCounts.text++;
  });
  const parts = [`${allData.entities.length} entities`, `${allData.relationships.length} relationships`, `${allData.thoughts.length} memories`];
  const mediaParts = [];
  if (mediaTypeCounts.image) mediaParts.push(`📷 ${mediaTypeCounts.image}`);
  if (mediaTypeCounts.video) mediaParts.push(`🎬 ${mediaTypeCounts.video}`);
  if (mediaTypeCounts.audio) mediaParts.push(`🔊 ${mediaTypeCounts.audio}`);
  if (mediaParts.length) parts.push(mediaParts.join(' '));
  document.getElementById('stat-total').textContent = parts.join(' · ');
}

// --- Auth ---
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

// --- Main ---
async function main() {
  await checkAuth();

  document.getElementById('logout-btn')?.addEventListener('click', async () => {
    await supabase.auth.signOut(); window.location.reload();
  });
  document.getElementById('panel-close').addEventListener('click', () => { hidePanel(); });
  initSearch();
  initFilters();

  const loadingText = document.getElementById('loading-text');
  loadingText.textContent = 'Fetching knowledge graph...';

  try {
    const data = await fetchData();
    allData.entities = data.entities || [];
    allData.relationships = data.relationships || [];
    allData.thoughts = data.thoughts || [];
    allData.thoughtEntities = data.thoughtEntities || [];

    if (!allData.entities.length) {
      document.getElementById('loading').classList.add('fade-out');
      setTimeout(() => document.getElementById('loading')?.remove(), 500);
      document.getElementById('graph-container').innerHTML = `
        <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:#555;gap:12px;">
          <div style="font-size:3em;">🧠</div>
          <div style="font-size:1.2em;color:#888;">No entities yet</div>
        </div>`;
      return;
    }

    loadingText.textContent = `Initializing graph with ${allData.entities.length} entities...`;
    buildTypeFilters();
    computeEntitiesWithMedia();
    buildMediaFilters();
    updateStats();

    // Build all points/links and compute initial visibility
    buildAllPointsAndLinks();
    buildNeighborMap();
    computeVisibleIds();
    initCosmograph();

    const loading = document.getElementById('loading');
    loading.classList.add('fade-out');
    setTimeout(() => loading?.remove(), 500);
  } catch (err) {
    loadingText.textContent = `Error: ${err.message}`;
    loadingText.style.color = '#ef4444';
    console.error(err);
    // If auth error, sign out and reload to show login
    if (err.message.includes('expired') || err.message.includes('401')) {
      await supabase.auth.signOut();
      setTimeout(() => window.location.reload(), 2000);
    }
  }
}

main();
