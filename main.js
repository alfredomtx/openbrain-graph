import Graph from 'graphology';
import Sigma from 'sigma';
import forceAtlas2 from 'graphology-layout-forceatlas2';

// --- Config ----------------------------------------------------------------
const EDGE_FUNCTION_URL = 'https://hkcsepatkmpkvxyvatfn.supabase.co/functions/v1/open-brain-graph-data';
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhrY3NlcGF0a21wa3Z4eXZhdGZuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI1ODY4MjQsImV4cCI6MjA4ODE2MjgyNH0.GOqC4yZzIaXKbvCYtB74sNOb19cvchTm5P_i3jO4ZNQ';
const ACCESS_KEY = 'REDACTED';
const SIM_THRESHOLD = 0.3;

// --- Color map --------------------------------------------------------------
const TYPE_COLORS = {
  idea:         '#a855f7',
  decision:     '#f59e0b',
  task:         '#ef4444',
  person_note:  '#06b6d4',
  observation:  '#22c55e',
  reflection:   '#f97316',
  learning:     '#3b82f6',
  reference:    '#64748b',
  default:      '#8b5cf6',
};

const IMPORTANCE_SIZE = { high: 18, medium: 13, low: 8 };

// --- State ------------------------------------------------------------------
let renderer = null;
let graphData = null;
let allThoughts = [];
let highlightedNodes = new Set();

// --- Helpers ----------------------------------------------------------------
function cosineSim(a, b) {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot  += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

function getType(t) {
  return t?.metadata?.type || 'default';
}

function getImportance(t) {
  return t?.metadata?.importance || 'medium';
}

function getColor(type) {
  return TYPE_COLORS[type] || TYPE_COLORS.default;
}

function truncate(str, n) {
  return str && str.length > n ? str.slice(0, n) + '...' : str;
}

function formatDate(iso) {
  return new Date(iso).toLocaleString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' });
}

// --- Fetch data -------------------------------------------------------------
async function fetchThoughts() {
  const res = await fetch(`${EDGE_FUNCTION_URL}?key=${ACCESS_KEY}`, {
    headers: { 'Authorization': `Bearer ${ANON_KEY}` }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  return json.thoughts || [];
}

// --- Build graph ------------------------------------------------------------
function buildGraph(thoughts) {
  const g = new Graph({ multi: false });

  // Add nodes
  thoughts.forEach(t => {
    const type = getType(t);
    const imp = getImportance(t);
    const size = IMPORTANCE_SIZE[imp] || IMPORTANCE_SIZE.medium;
    const color = getColor(type);

    g.addNode(t.id, {
      label: truncate(t.content, 40),
      size,
      color,
      x: Math.random() * 1000 - 500,
      y: Math.random() * 1000 - 500,
      thought: t,
    });
  });

  // Add edges (pairwise cosine similarity)
  const withEmbeddings = thoughts.filter(t => t.embedding);
  for (let i = 0; i < withEmbeddings.length; i++) {
    for (let j = i + 1; j < withEmbeddings.length; j++) {
      const sim = cosineSim(withEmbeddings[i].embedding, withEmbeddings[j].embedding);
      if (sim >= SIM_THRESHOLD) {
        try {
          g.addEdge(withEmbeddings[i].id, withEmbeddings[j].id, {
            weight: sim,
            color: `rgba(160,140,240,${Math.min(0.7, 0.2 + (sim - SIM_THRESHOLD) * 4)})`,
            size: Math.max(0.5, (sim - SIM_THRESHOLD) * 4),
          });
        } catch {}
      }
    }
  }

  return g;
}

// --- Force layout -----------------------------------------------------------
function applyLayout(g) {
  forceAtlas2.assign(g, {
    iterations: 200,
    settings: {
      gravity: 1,
      scalingRatio: 10,
      slowDown: 5,
      barnesHutOptimize: true,
    }
  });
}

// --- Render -----------------------------------------------------------------
function initRenderer(g) {
  const container = document.getElementById('graph-container');
  if (renderer) renderer.kill();

  renderer = new Sigma(g, container, {
    labelColor: { color: '#cccccc' },
    labelSize: 11,
    defaultEdgeType: 'line',
    renderEdgeLabels: false,
    nodeReducer: (node, data) => {
      const res = { ...data };
      if (highlightedNodes.size > 0) {
        if (highlightedNodes.has(node)) {
          res.size = data.size * 1.6;
          res.zIndex = 10;
        } else {
          res.color = '#2a2a3a';
          res.size = data.size * 0.6;
        }
      }
      return res;
    },
    edgeReducer: (edge, data) => {
      if (highlightedNodes.size > 0) {
        return { ...data, color: 'rgba(40,40,60,0.2)' };
      }
      return data;
    },
  });

  // Click node ? show detail panel
  renderer.on('clickNode', ({ node }) => {
    const data = g.getNodeAttributes(node);
    showPanel(data.thought);
    highlightedNodes = new Set([node]);
    renderer.refresh();
  });

  // Click stage ? clear
  renderer.on('clickStage', () => {
    highlightedNodes.clear();
    renderer.refresh();
    hidePanel();
  });

  return renderer;
}

// --- Detail Panel -----------------------------------------------------------
function showPanel(thought) {
  const panel = document.getElementById('panel');
  const type = getType(thought);
  const meta = thought.metadata || {};

  document.getElementById('panel-type').textContent = type.replace(/_/g, ' ');
  document.getElementById('panel-type').style.color = getColor(type);
  document.getElementById('panel-content').textContent = thought.content;

  let html = '';

  if (meta.importance) {
    html += `<div class="meta-label">Importance</div>`;
    html += `<span class="importance-badge importance-${meta.importance}">${meta.importance}</span>`;
  }

  if (meta.topics?.length) {
    html += `<div class="meta-label">Topics</div><div class="tag-list">`;
    meta.topics.forEach(t => { html += `<span class="tag">${t}</span>`; });
    html += `</div>`;
  }

  if (meta.people?.length) {
    html += `<div class="meta-label">People</div><div class="tag-list">`;
    meta.people.forEach(p => { html += `<span class="tag person">${p}</span>`; });
    html += `</div>`;
  }

  if (meta.action_items?.length) {
    html += `<div class="meta-label">Action Items</div><div class="tag-list">`;
    meta.action_items.forEach(a => { html += `<span class="tag action">${a}</span>`; });
    html += `</div>`;
  }

  if (meta.sentiment) {
    html += `<div class="meta-label">Sentiment</div>`;
    html += `<span class="tag sentiment-${meta.sentiment}">${meta.sentiment}</span>`;
  }

  html += `<div class="meta-label">Captured</div><span style="color:#666">${formatDate(thought.created_at)}</span>`;

  document.getElementById('panel-meta').innerHTML = html;
  panel.classList.remove('hidden');
}

function hidePanel() {
  document.getElementById('panel').classList.add('hidden');
}

// --- Stats bar --------------------------------------------------------------
function updateStats(thoughts) {
  const typeCounts = {};
  let latest = null;
  thoughts.forEach(t => {
    const type = getType(t);
    typeCounts[type] = (typeCounts[type] || 0) + 1;
    if (!latest || t.created_at > latest) latest = t.created_at;
  });

  document.getElementById('stat-total').textContent = `${thoughts.length} thoughts`;

  const typeSummary = Object.entries(typeCounts)
    .sort((a,b) => b[1]-a[1])
    .slice(0, 4)
    .map(([k,v]) => `${k.replace(/_/g,' ')}: ${v}`)
    .join('  ...  ');
  document.getElementById('stat-types').textContent = typeSummary;

  if (latest) {
    document.getElementById('stat-updated').textContent = `Updated ${formatDate(latest)}`;
  }
}

// --- Legend -----------------------------------------------------------------
function buildLegend(thoughts) {
  const types = [...new Set(thoughts.map(getType))];
  const container = document.getElementById('legend-items');
  container.innerHTML = '';
  types.forEach(type => {
    const item = document.createElement('div');
    item.className = 'legend-item';
    item.innerHTML = `<div class="legend-dot" style="background:${getColor(type)}"></div><span>${type.replace(/_/g,' ')}</span>`;
    item.addEventListener('click', () => filterByType(type));
    container.appendChild(item);
  });
}

// --- Search -----------------------------------------------------------------
function initSearch() {
  const input = document.getElementById('search');
  const results = document.getElementById('search-results');

  input.addEventListener('input', () => {
    const q = input.value.toLowerCase().trim();
    if (!q) {
      results.classList.remove('visible');
      highlightedNodes.clear();
      if (renderer) renderer.refresh();
      return;
    }

    const matches = allThoughts.filter(t =>
      t.content.toLowerCase().includes(q) ||
      (t.metadata?.topics || []).some(tp => tp.toLowerCase().includes(q)) ||
      (t.metadata?.people || []).some(p => p.toLowerCase().includes(q))
    );

    highlightedNodes = new Set(matches.map(t => t.id));
    if (renderer) renderer.refresh();

    results.innerHTML = '';
    if (matches.length === 0) {
      results.innerHTML = `<div class="search-item"><div class="si-text" style="color:#555">No results</div></div>`;
    } else {
      matches.slice(0, 8).forEach(t => {
        const item = document.createElement('div');
        item.className = 'search-item';
        item.innerHTML = `<div class="si-type">${getType(t).replace(/_/g,' ')}</div><div class="si-text">${truncate(t.content, 80)}</div>`;
        item.addEventListener('click', () => {
          showPanel(t);
          results.classList.remove('visible');
          input.value = '';
          highlightedNodes = new Set([t.id]);
          if (renderer) {
            renderer.refresh();
            // Pan to node
            const pos = renderer.getNodeDisplayData(t.id);
            if (pos) renderer.getCamera().animate({ x: pos.x, y: pos.y, ratio: 0.5 }, { duration: 500 });
          }
        });
        results.appendChild(item);
      });
    }
    results.classList.add('visible');
  });

  input.addEventListener('blur', () => setTimeout(() => results.classList.remove('visible'), 200));
}

// --- Filter by type ----------------------------------------------------------
function filterByType(type) {
  const matches = allThoughts.filter(t => getType(t) === type);
  highlightedNodes = new Set(matches.map(t => t.id));
  if (renderer) renderer.refresh();
}

// --- Panel close -------------------------------------------------------------
document.getElementById('panel-close').addEventListener('click', () => {
  hidePanel();
  highlightedNodes.clear();
  if (renderer) renderer.refresh();
});

// --- Main --------------------------------------------------------------------
async function main() {
  const loadingText = document.getElementById('loading-text');

  try {
    loadingText.textContent = 'Fetching thoughts...';
    allThoughts = await fetchThoughts();

    loadingText.textContent = `Computing graph (${allThoughts.length} nodes)...`;
    const g = buildGraph(allThoughts);

    loadingText.textContent = 'Running force layout...';
    applyLayout(g);

    graphData = g;
    initRenderer(g);
    updateStats(allThoughts);
    buildLegend(allThoughts);
    initSearch();

    // Fade out loading
    const loading = document.getElementById('loading');
    loading.classList.add('fade-out');
    setTimeout(() => loading.remove(), 500);

  } catch (err) {
    loadingText.textContent = `Error: ${err.message}`;
    loadingText.style.color = '#ef4444';
    console.error(err);
  }
}

main();
