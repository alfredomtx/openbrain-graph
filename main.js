import Graph from 'graphology';
import Sigma from 'sigma';
import forceAtlas2 from 'graphology-layout-forceatlas2';
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

// --- Media ---
const MEDIA_BADGES = { text: '📝', image: '📷', video: '🎬', audio: '🔊' };
let activeMediaTypes = new Set(['text', 'image', 'video', 'audio']);
let entitiesWithMedia = new Set();

// --- State ---
let renderer = null;
let allData = { entities: [], relationships: [], thoughts: [], thoughtEntities: [] };
let highlightedNodes = new Set();
let hoveredNode = null;
let hoveredNeighbors = new Set();
let hoveredEdges = new Set();
let currentPanelEntity = null;
let currentPanelGraph = null;
let currentPanelNodeId = null;

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

// --- Build Graph ---
function buildGraph(entities, relationships) {
  const g = new Graph({ multi: false, type: 'directed' });
  const entityMap = new Map();

  entities.forEach(e => {
    entityMap.set(e.id, e);
    const color = ENTITY_COLORS[e.type] || ENTITY_COLORS.default;
    const size = 8 + Math.min(20, (e.mention_count || 1) * 2);
    const mediaLabel = entitiesWithMedia.has(e.id) ? ` ✦` : '';
    g.addNode(e.id, {
      label: e.name + mediaLabel,
      size,
      color,
      x: Math.random() * 1000 - 500,
      y: Math.random() * 1000 - 500,
      entityData: e,
    });
  });

  relationships.forEach(r => {
    if (!entityMap.has(r.source_id) || !entityMap.has(r.target_id)) return;
    if (r.source_id === r.target_id) return;
    try {
      g.addEdge(r.source_id, r.target_id, {
        label: r.relation,
        color: RELATION_COLORS[r.relation] || RELATION_COLORS.default,
        size: 1.5 + (r.confidence || 0.5) * 2,
        type: 'arrow',
        relData: r,
      });
    } catch {} // skip duplicate edges
  });

  return g;
}

// --- Layout ---
function applyLayout(g) {
  if (g.order < 2) return; // skip if 0-1 nodes
  forceAtlas2.assign(g, {
    iterations: 200,
    settings: { gravity: 1, scalingRatio: 10, slowDown: 5, barnesHutOptimize: true },
  });
}

// --- Render ---
function initRenderer(g) {
  const container = document.getElementById('graph-container');
  if (renderer) { renderer.kill(); renderer = null; }

  renderer = new Sigma(g, container, {
    labelColor: { color: '#cccccc' },
    labelSize: 12,
    defaultEdgeType: 'arrow',
    renderEdgeLabels: true,
    edgeLabelColor: { color: '#888' },
    edgeLabelSize: 10,
    nodeReducer: (node, data) => {
      const res = { ...data };
      if (hoveredNode) {
        if (node === hoveredNode) { res.size = data.size * 1.5; res.zIndex = 10; }
        else if (hoveredNeighbors.has(node)) { res.size = data.size * 1.2; res.zIndex = 5; }
        else { res.color = '#1a1a2a'; res.size = data.size * 0.7; res.label = ''; }
      } else if (highlightedNodes.size > 0) {
        if (highlightedNodes.has(node)) { res.size = data.size * 1.6; res.zIndex = 10; }
        else { res.color = '#2a2a3a'; res.size = data.size * 0.6; }
      }
      return res;
    },
    edgeReducer: (edge, data) => {
      if (hoveredNode) {
        if (hoveredEdges.has(edge)) return { ...data, color: 'rgba(255,255,255,0.6)', size: 2.5 };
        return { ...data, color: 'rgba(30,30,40,0.05)', label: '' };
      }
      if (highlightedNodes.size > 0) return { ...data, color: 'rgba(40,40,60,0.1)', label: '' };
      return data;
    },
  });

  renderer.on('clickNode', ({ node }) => {
    const data = g.getNodeAttributes(node);
    showPanel(data.entityData, g, node);
    highlightedNodes = new Set([node]);
    renderer.refresh();
  });

  renderer.on('clickStage', () => { highlightedNodes.clear(); renderer.refresh(); hidePanel(); });

  renderer.on('enterNode', ({ node }) => {
    hoveredNode = node;
    hoveredNeighbors = new Set(g.neighbors(node));
    hoveredEdges = new Set(g.edges(node));
    renderer.refresh();
  });

  renderer.on('leaveNode', () => {
    hoveredNode = null; hoveredNeighbors.clear(); hoveredEdges.clear(); renderer.refresh();
  });
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
      // Re-render panel if open
      if (currentPanelEntity) showPanel(currentPanelEntity, currentPanelGraph, currentPanelNodeId);
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
function showPanel(entity, graph, nodeId) {
  currentPanelEntity = entity;
  currentPanelGraph = graph;
  currentPanelNodeId = nodeId;
  const panel = document.getElementById('panel');
  document.getElementById('panel-type').textContent = entity.type;
  document.getElementById('panel-type').style.color = ENTITY_COLORS[entity.type] || ENTITY_COLORS.default;
  document.getElementById('panel-content').textContent = entity.name;

  let html = '';
  html += `<div class="meta-label">Mentions</div><span>${entity.mention_count || 0}</span>`;
  html += `<div class="meta-label">First seen</div><span style="color:#666">${formatDate(entity.created_at)}</span>`;

  // Relationships
  const edges = graph.edges(nodeId);
  if (edges.length) {
    html += `<div class="meta-label">Relationships</div><div class="rel-list">`;
    edges.forEach(e => {
      const edgeData = graph.getEdgeAttributes(e);
      const source = graph.source(e);
      const target = graph.target(e);
      const otherNode = source === nodeId ? target : source;
      const otherData = graph.getNodeAttributes(otherNode);
      const direction = source === nodeId ? '→' : '←';
      const color = RELATION_COLORS[edgeData.label] || RELATION_COLORS.default;
      html += `<div class="rel-item">
        <span style="color:${color}">${edgeData.label}</span>
        <span class="rel-dir">${direction}</span>
        <span style="color:${ENTITY_COLORS[otherData.entityData?.type] || '#888'}">${otherData.label}</span>
      </div>`;
    });
    html += `</div>`;
  }

  // Linked thoughts (with media filter)
  const entityLinks = allData.thoughtEntities.filter(te => te.entity_id === entity.id);
  const allLinkedThoughts = entityLinks
    .map(te => allData.thoughts.find(t => t.id === te.thought_id))
    .filter(Boolean);
  const filteredThoughts = allLinkedThoughts.filter(t => activeMediaTypes.has(t.media_type || 'text'));
  
  if (allLinkedThoughts.length) {
    const mediaIndicator = entitiesWithMedia.has(entity.id) ? ' <span class="media-indicator">✦ has media</span>' : '';
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

function hidePanel() { document.getElementById('panel').classList.add('hidden'); }

// --- Stats + Legend ---
function updateStats() {
  const e = allData.entities, r = allData.relationships;
  document.getElementById('stat-total').textContent = `${e.length} entities · ${r.length} relationships · ${allData.thoughts.length} memories${getMediaStats()}`;
}

function buildLegend() {
  const container = document.getElementById('legend-items');
  container.innerHTML = '';
  const types = [...new Set(allData.entities.map(e => e.type))];
  types.forEach(type => {
    const item = document.createElement('div');
    item.className = 'legend-item';
    item.innerHTML = `<div class="legend-dot" style="background:${ENTITY_COLORS[type] || ENTITY_COLORS.default}"></div><span>${type}</span>`;
    item.addEventListener('click', () => {
      highlightedNodes = new Set(allData.entities.filter(e => e.type === type).map(e => e.id));
      if (renderer) renderer.refresh();
    });
    container.appendChild(item);
  });
}

// --- Search ---
function initSearch() {
  const input = document.getElementById('search');
  const results = document.getElementById('search-results');

  input.addEventListener('input', () => {
    const q = input.value.toLowerCase().trim();
    if (!q) { results.classList.remove('visible'); highlightedNodes.clear(); if (renderer) renderer.refresh(); return; }

    const matches = allData.entities.filter(e =>
      e.name.toLowerCase().includes(q) || e.type.toLowerCase().includes(q)
    );
    highlightedNodes = new Set(matches.map(e => e.id));
    if (renderer) renderer.refresh();

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
          highlightedNodes = new Set([item.id]);
          if (renderer) {
            renderer.refresh();
            const pos = renderer.getNodeDisplayData(item.id);
            if (pos) renderer.getCamera().animate({ x: pos.x, y: pos.y, ratio: 0.5 }, { duration: 500 });
          }
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
    hidePanel(); highlightedNodes.clear(); if (renderer) renderer.refresh();
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
    computeEntitiesWithMedia();
    const g = buildGraph(allData.entities, allData.relationships);
    applyLayout(g);
    initRenderer(g);
    updateStats();
    buildLegend();
    buildMediaFilters();

    const loading = document.getElementById('loading');
    loading.classList.add('fade-out');
    setTimeout(() => loading.remove(), 500);
  } catch (err) {
    loadingText.textContent = `Error: ${err.message}`;
    loadingText.style.color = '#ef4444';
  }
}

main();
