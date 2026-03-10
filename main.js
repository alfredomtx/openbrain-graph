import Graph from 'graphology';
import Sigma from 'sigma';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import { createClient } from '@supabase/supabase-js';

// --- Supabase Auth ---
const SUPABASE_URL = 'https://hkcsepatkmpkvxyvatfn.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhrY3NlcGF0a21wa3Z4eXZhdGZuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI1ODY4MjQsImV4cCI6MjA4ODE2MjgyNH0.GOqC4yZzIaXKbvCYtB74sNOb19cvchTm5P_i3jO4ZNQ';
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON);

const EDGE_FUNCTION_URL = `${SUPABASE_URL}/functions/v1/open-brain-graph-data`;
const SIM_THRESHOLD = 0.3;

// --- Color maps ---
const THOUGHT_COLORS = {
  idea: '#a855f7', decision: '#f59e0b', task: '#ef4444', person_note: '#06b6d4',
  observation: '#22c55e', reflection: '#f97316', learning: '#3b82f6', reference: '#64748b', default: '#8b5cf6',
};

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

const IMPORTANCE_SIZE = { high: 18, medium: 13, low: 8 };

// --- State ---
let renderer = null;
let currentView = 'knowledge';
let allData = { thoughts: [], entities: [], relationships: [], thoughtEntities: [] };
let highlightedNodes = new Set();
let hoveredNode = null;
let hoveredNeighbors = new Set();
let hoveredEdges = new Set();

// --- Helpers ---
function cosineSim(a, b) {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; magA += a[i]*a[i]; magB += b[i]*b[i]; }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

function truncate(str, n) { return str && str.length > n ? str.slice(0, n) + '...' : str; }
function formatDate(iso) { return new Date(iso).toLocaleString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' }); }

// --- Fetch ---
async function fetchData(view) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Not authenticated');
  const res = await fetch(`${EDGE_FUNCTION_URL}?view=${view}`, {
    headers: { 'Authorization': `Bearer ${session.access_token}` }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ============================================================================
// Knowledge Graph (entities + relationships)
// ============================================================================

function buildKnowledgeGraph(entities, relationships) {
  const g = new Graph({ multi: false, type: 'directed' });

  const entityMap = new Map();
  entities.forEach(e => {
    entityMap.set(e.id, e);
    const color = ENTITY_COLORS[e.type] || ENTITY_COLORS.default;
    const size = 8 + Math.min(20, (e.mention_count || 1) * 2);
    g.addNode(e.id, {
      label: e.name,
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
    const edgeKey = `${r.source_id}-${r.target_id}`;
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

// ============================================================================
// Thought Graph (legacy — cosine similarity)
// ============================================================================

function buildThoughtGraph(thoughts) {
  const g = new Graph({ multi: false });

  thoughts.forEach(t => {
    const type = t.metadata?.type || 'default';
    const imp = t.metadata?.importance || 'medium';
    g.addNode(t.id, {
      label: truncate(t.content, 40),
      size: IMPORTANCE_SIZE[imp] || IMPORTANCE_SIZE.medium,
      color: THOUGHT_COLORS[type] || THOUGHT_COLORS.default,
      x: Math.random() * 1000 - 500,
      y: Math.random() * 1000 - 500,
      thoughtData: t,
    });
  });

  // Parse embeddings
  thoughts.forEach(t => {
    if (typeof t.embedding === 'string') try { t.embedding = JSON.parse(t.embedding); } catch { t.embedding = null; }
  });

  const withEmb = thoughts.filter(t => t.embedding?.length > 0);
  for (let i = 0; i < withEmb.length; i++) {
    for (let j = i + 1; j < withEmb.length; j++) {
      const sim = cosineSim(withEmb[i].embedding, withEmb[j].embedding);
      if (sim >= SIM_THRESHOLD) {
        try {
          g.addEdge(withEmb[i].id, withEmb[j].id, {
            weight: sim,
            color: `rgba(200,180,255,${Math.min(0.7, 0.2 + (sim - SIM_THRESHOLD) * 4)})`,
            size: Math.max(1.5, (sim - SIM_THRESHOLD) * 8),
          });
        } catch {}
      }
    }
  }

  return g;
}

// ============================================================================
// Layout + Render
// ============================================================================

function applyLayout(g) {
  forceAtlas2.assign(g, {
    iterations: 200,
    settings: { gravity: 1, scalingRatio: 10, slowDown: 5, barnesHutOptimize: true },
  });
}

function initRenderer(g) {
  const container = document.getElementById('graph-container');
  if (renderer) { renderer.kill(); renderer = null; }

  const isKnowledge = currentView === 'knowledge';

  renderer = new Sigma(g, container, {
    labelColor: { color: '#cccccc' },
    labelSize: 12,
    defaultEdgeType: isKnowledge ? 'arrow' : 'line',
    renderEdgeLabels: isKnowledge,
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
        return { ...data, color: 'rgba(30,30,40,0.05)' };
      }
      if (highlightedNodes.size > 0) return { ...data, color: 'rgba(40,40,60,0.1)' };
      return data;
    },
  });

  renderer.on('clickNode', ({ node }) => {
    const data = g.getNodeAttributes(node);
    if (currentView === 'knowledge') showEntityPanel(data.entityData, g, node);
    else showThoughtPanel(data.thoughtData);
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

// ============================================================================
// Panels
// ============================================================================

function showEntityPanel(entity, graph, nodeId) {
  const panel = document.getElementById('panel');
  document.getElementById('panel-type').textContent = entity.type;
  document.getElementById('panel-type').style.color = ENTITY_COLORS[entity.type] || ENTITY_COLORS.default;
  document.getElementById('panel-content').textContent = entity.name;

  let html = '';
  html += `<div class="meta-label">Mentions</div><span>${entity.mention_count || 0}</span>`;
  html += `<div class="meta-label">First seen</div><span style="color:#666">${formatDate(entity.created_at)}</span>`;

  // Show relationships
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

  // Show linked thoughts
  const entityLinks = allData.thoughtEntities.filter(te => te.entity_id === entity.id);
  if (entityLinks.length) {
    html += `<div class="meta-label">Linked Memories (${entityLinks.length})</div><div class="linked-thoughts">`;
    const linkedThoughts = entityLinks
      .map(te => allData.thoughts.find(t => t.id === te.thought_id))
      .filter(Boolean)
      .slice(0, 5);
    linkedThoughts.forEach(t => {
      html += `<div class="linked-thought">${truncate(t.content, 100)}</div>`;
    });
    if (entityLinks.length > 5) html += `<div style="color:#555;font-size:11px">+${entityLinks.length - 5} more</div>`;
    html += `</div>`;
  }

  document.getElementById('panel-meta').innerHTML = html;
  panel.classList.remove('hidden');
}

function showThoughtPanel(thought) {
  const panel = document.getElementById('panel');
  const type = thought?.metadata?.type || 'default';
  document.getElementById('panel-type').textContent = type.replace(/_/g, ' ');
  document.getElementById('panel-type').style.color = THOUGHT_COLORS[type] || THOUGHT_COLORS.default;
  document.getElementById('panel-content').textContent = thought.content;

  let html = '';
  const meta = thought.metadata || {};
  if (meta.importance) {
    html += `<div class="meta-label">Importance</div><span class="importance-badge importance-${meta.importance}">${meta.importance}</span>`;
  }
  if (meta.topics?.length) {
    html += `<div class="meta-label">Topics</div><div class="tag-list">${meta.topics.map(t => `<span class="tag">${t}</span>`).join('')}</div>`;
  }
  if (meta.people?.length) {
    html += `<div class="meta-label">People</div><div class="tag-list">${meta.people.map(p => `<span class="tag person">${p}</span>`).join('')}</div>`;
  }
  html += `<div class="meta-label">Captured</div><span style="color:#666">${formatDate(thought.created_at)}</span>`;
  document.getElementById('panel-meta').innerHTML = html;
  panel.classList.remove('hidden');
}

function hidePanel() { document.getElementById('panel').classList.add('hidden'); }

// ============================================================================
// Stats + Legend + Search
// ============================================================================

function updateStats() {
  if (currentView === 'knowledge') {
    const e = allData.entities, r = allData.relationships;
    document.getElementById('stat-total').textContent = `${e.length} entities · ${r.length} relationships`;
    const typeCounts = {};
    e.forEach(ent => { typeCounts[ent.type] = (typeCounts[ent.type] || 0) + 1; });
    document.getElementById('stat-types').textContent = Object.entries(typeCounts).sort((a,b) => b[1]-a[1]).slice(0,4).map(([k,v]) => `${k}: ${v}`).join('  ·  ');
  } else {
    document.getElementById('stat-total').textContent = `${allData.thoughts.length} thoughts`;
    const typeCounts = {};
    allData.thoughts.forEach(t => { const type = t.metadata?.type || 'default'; typeCounts[type] = (typeCounts[type] || 0) + 1; });
    document.getElementById('stat-types').textContent = Object.entries(typeCounts).sort((a,b) => b[1]-a[1]).slice(0,4).map(([k,v]) => `${k.replace(/_/g,' ')}: ${v}`).join('  ·  ');
  }
}

function buildLegend() {
  const container = document.getElementById('legend-items');
  container.innerHTML = '';
  const colors = currentView === 'knowledge' ? ENTITY_COLORS : THOUGHT_COLORS;
  const items = currentView === 'knowledge'
    ? [...new Set(allData.entities.map(e => e.type))]
    : [...new Set(allData.thoughts.map(t => t.metadata?.type || 'default'))];

  items.forEach(type => {
    const item = document.createElement('div');
    item.className = 'legend-item';
    item.innerHTML = `<div class="legend-dot" style="background:${colors[type] || colors.default}"></div><span>${type.replace(/_/g,' ')}</span>`;
    item.addEventListener('click', () => {
      const ids = currentView === 'knowledge'
        ? allData.entities.filter(e => e.type === type).map(e => e.id)
        : allData.thoughts.filter(t => (t.metadata?.type || 'default') === type).map(t => t.id);
      highlightedNodes = new Set(ids);
      if (renderer) renderer.refresh();
    });
    container.appendChild(item);
  });
}

function initSearch() {
  const input = document.getElementById('search');
  const results = document.getElementById('search-results');

  input.addEventListener('input', () => {
    const q = input.value.toLowerCase().trim();
    if (!q) { results.classList.remove('visible'); highlightedNodes.clear(); if (renderer) renderer.refresh(); return; }

    let matches;
    if (currentView === 'knowledge') {
      matches = allData.entities.filter(e => e.name.toLowerCase().includes(q) || e.type.toLowerCase().includes(q));
      highlightedNodes = new Set(matches.map(e => e.id));
    } else {
      matches = allData.thoughts.filter(t => t.content.toLowerCase().includes(q));
      highlightedNodes = new Set(matches.map(t => t.id));
    }
    if (renderer) renderer.refresh();

    results.innerHTML = '';
    if (!matches.length) {
      results.innerHTML = `<div class="search-item"><div class="si-text" style="color:#555">No results</div></div>`;
    } else {
      matches.slice(0, 8).forEach(item => {
        const div = document.createElement('div');
        div.className = 'search-item';
        if (currentView === 'knowledge') {
          div.innerHTML = `<div class="si-type">${item.type}</div><div class="si-text">${item.name}</div>`;
        } else {
          div.innerHTML = `<div class="si-type">${(item.metadata?.type || 'default').replace(/_/g,' ')}</div><div class="si-text">${truncate(item.content, 80)}</div>`;
        }
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

// ============================================================================
// View toggle
// ============================================================================

async function switchView(view) {
  currentView = view;
  highlightedNodes.clear();
  hoveredNode = null;
  hidePanel();

  const loadingText = document.getElementById('loading-text');
  const loading = document.getElementById('loading');
  loading.classList.remove('fade-out');
  loading.style.display = 'flex';

  try {
    if (view === 'knowledge') {
      loadingText.textContent = 'Loading knowledge graph...';
      if (!allData.entities.length) {
        const data = await fetchData('knowledge');
        allData.entities = data.entities || [];
        allData.relationships = data.relationships || [];
        allData.thoughtEntities = data.thoughtEntities || [];
      }
      const g = buildKnowledgeGraph(allData.entities, allData.relationships);
      loadingText.textContent = `Laying out ${allData.entities.length} entities...`;
      applyLayout(g);
      initRenderer(g);
    } else {
      loadingText.textContent = 'Loading thought graph...';
      if (!allData.thoughts.length) {
        const data = await fetchData('thoughts');
        allData.thoughts = data.thoughts || [];
      }
      const g = buildThoughtGraph(allData.thoughts);
      loadingText.textContent = `Laying out ${allData.thoughts.length} thoughts...`;
      applyLayout(g);
      initRenderer(g);
    }

    updateStats();
    buildLegend();
    loading.classList.add('fade-out');
    setTimeout(() => { loading.style.display = 'none'; }, 500);
  } catch (err) {
    loadingText.textContent = `Error: ${err.message}`;
    loadingText.style.color = '#ef4444';
  }
}

// ============================================================================
// Auth + Main
// ============================================================================

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

  // Logout
  document.getElementById('logout-btn')?.addEventListener('click', async () => {
    await supabase.auth.signOut();
    window.location.reload();
  });

  // View toggle buttons
  document.querySelectorAll('.view-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.view-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      switchView(btn.dataset.view);
    });
  });

  // Panel close
  document.getElementById('panel-close').addEventListener('click', () => {
    hidePanel(); highlightedNodes.clear(); if (renderer) renderer.refresh();
  });

  initSearch();

  // Load all data upfront then render default view
  const loadingText = document.getElementById('loading-text');
  loadingText.textContent = 'Fetching data...';
  try {
    const data = await fetchData('all');
    allData.thoughts = data.thoughts || [];
    allData.entities = data.entities || [];
    allData.relationships = data.relationships || [];
    allData.thoughtEntities = data.thoughtEntities || [];
  } catch (err) {
    loadingText.textContent = `Error: ${err.message}`;
    return;
  }

  await switchView('knowledge');
}

main();
