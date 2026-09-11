'use strict';

const byId = identifier => document.getElementById(identifier);
const canvas = byId('graph');
const context = canvas.getContext('2d');
const minimap = byId('minimap');
const mapContext = minimap.getContext('2d');
const palette = new Map([['Document', '#d98662'], ['Section', '#329987'], ['Passage', '#628fc8'], ['Concept', '#8f7ac7']]);
const maxVisibleNodes = 600;
const motionPreference = matchMedia('(prefers-reduced-motion: reduce)');
let reducedMotion = motionPreference.matches;
const state = {
  nodes: [], edges: [], visibleNodes: [], visibleEdges: [], nodeById: new Map(), adjacency: new Map(),
  types: new Set(), edgeTypes: new Set(), selected: null, selectedEdge: null, hovered: null, hoveredEdge: null,
  focus: null, path: null, preset: 'overview', paused: reducedMotion, remaining: 0, framePending: false,
  width: 1, height: 1, camera: {positionX: 0, positionY: 0, scale: 1}, pointer: null,
  directoryLimit: 30, connectionLimit: 30, geometry: [], mapBounds: null, toastTimer: null, initialized: false,
  fitView: true, labelBoxes: [], lastNodeClick: null,
  queryResult: null,
  effectsEnabled: GraphAppearance.read('motion', 'on') !== 'off', visualTime: 0, lastDraw: 0,
  layoutTransition: null, hasLayout: false,
};

function readGraphColors() {
  const styles = getComputedStyle(document.documentElement);
  return Object.fromEntries(['bg', 'glow', 'grid', 'edge', 'association', 'active', 'label', 'label-active', 'label-bg', 'halo', 'ring', 'outline', 'particle'].map(name => [name, styles.getPropertyValue(`--graph-${name}`).trim()]));
}
let graphColors = readGraphColors();
window.addEventListener('graph-theme-change', () => { graphColors = readGraphColors(); schedule(); });

function graphMotionEnabled() {
  return state.effectsEnabled && !reducedMotion && !document.hidden;
}
function displayPosition(node) {
  const start = state.layoutTransition?.positions.get(node.id);
  if (!start || node.pinned) return {positionX: node.positionX, positionY: node.positionY};
  const progress = 1 - Math.pow(1 - state.layoutTransition.progress, 3);
  return {positionX: start.positionX + (node.positionX - start.positionX) * progress,
    positionY: start.positionY + (node.positionY - start.positionY) * progress};
}
function settleLayoutTransition() {
  if (!state.layoutTransition) return;
  for (const node of state.visibleNodes) {
    const position = displayPosition(node);
    node.positionX = position.positionX; node.positionY = position.positionY;
    node.velocityX = 0; node.velocityY = 0;
  }
  state.layoutTransition = null;
}

function colorFor(node) { return palette.get(node.type) || '#c99cac'; }
function radiusFor(node) {
  const base = node.type === 'Document' ? 20 : node.type === 'Section' ? 13 : node.type === 'Passage' ? 7 : 10;
  return (base + Math.min(8, Math.sqrt(node.degree || 0) * .8)) * Number(byId('node-size').value) / 100;
}
function screenRadius(node) {
  return Math.max(node.type === 'Passage' ? 4 : 6, radiusFor(node) * state.camera.scale);
}
function clearHover() {
  state.hovered = null;
  state.hoveredEdge = null;
  byId('tooltip').hidden = true;
}
function createElement(tag, className = '', content = '') {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = content;
  return element;
}
function shortLabel(label, length = 32) { return label.length > length ? label.slice(0, length - 1) + '…' : label; }
function formatType(type) { return type.toLowerCase().replaceAll('_', ' ').replace(/^./, character => character.toUpperCase()); }
function edgeEnabled(edge) {
  return state.edgeTypes.has(edge.type) && (edge.type !== 'CO_OCCURS_WITH' || Number(edge.properties.weight || 1) >= Number(byId('min-weight').value));
}
function invalidatePath() {
  state.queryResult = null;
  state.path = null;
  byId('path-result').replaceChildren();
  byId('clear-path').hidden = true;
}
function toast(message) {
  clearTimeout(state.toastTimer);
  byId('toast').textContent = message;
  byId('toast').hidden = false;
  state.toastTimer = setTimeout(() => { byId('toast').hidden = true; }, 3000);
}
function openInspector() {
  window.GraphChat?.close();
  document.body.classList.remove('hide-inspector');
  document.body.classList.add('inspector-open');
  if (innerWidth <= 760) document.body.classList.remove('sidebar-open');
}
function openPanel(panel) {
  document.body.classList.remove('hide-sidebar');
  document.body.classList.add('sidebar-open');
  if (innerWidth <= 760) document.body.classList.remove('inspector-open');
  for (const name of ['explore', 'paths', 'appearance']) byId('panel-' + name).hidden = name !== panel;
  document.querySelectorAll('[data-panel]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.panel === panel)));
  byId('panel-title').textContent = {explore: 'Explore', paths: 'Path finder', appearance: 'Display settings'}[panel];
}

function neighborhood(identifier, depth) {
  const visited = new Set([identifier]);
  let frontier = [identifier];
  for (let hop = 0; hop < depth; hop++) {
    const next = [];
    for (const nodeId of frontier) {
      for (const edge of state.adjacency.get(nodeId) || []) {
        if (!edgeEnabled(edge)) continue;
        const other = edge.source.id === nodeId ? edge.target.id : edge.source.id;
        if (!visited.has(other)) { visited.add(other); next.push(other); }
      }
    }
    frontier = next;
  }
  return visited;
}

function nodeButton(node) {
  const button = createElement('button', 'node-item');
  const dot = createElement('span', 'dot'); dot.style.background = colorFor(node);
  button.append(dot, createElement('span', 'node-label', node.label), createElement('span', 'degree', String(node.degree)));
  button.title = `${node.label} · ${node.degree} relationships`;
  button.setAttribute('aria-pressed', String(node.id === state.selected));
  button.addEventListener('click', () => selectNode(node.id));
  return button;
}
function renderDirectory() {
  const sorted = [...state.visibleNodes].sort((left, right) => right.degree - left.degree || left.label.localeCompare(right.label));
  byId('node-list').replaceChildren(...sorted.slice(0, state.directoryLimit).map(nodeButton));
  byId('more-nodes').hidden = sorted.length <= state.directoryLimit;
  byId('directory-count').textContent = `${sorted.length} visible`;
}
function syncFilters() {
  document.querySelectorAll('#type-filters input').forEach(input => { input.checked = state.types.has(input.value); });
  document.querySelectorAll('#edge-filters input').forEach(input => { input.checked = state.edgeTypes.has(input.value); });
  document.querySelectorAll('[data-preset]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.preset === state.preset)));
  if (state.preset === 'custom') {
    byId('view-title').textContent = 'Filtered graph';
    byId('view-subtitle').textContent = 'Explore your selected nodes and relationships.';
    byId('view-chip').textContent = `${state.types.size} node types · ${state.edgeTypes.size} relationship types`;
  }
}
function updateGraph({layout = false, fit = false} = {}) {
  clearHover();
  const query = byId('search').value.trim().toLocaleLowerCase();
  const focused = state.focus ? neighborhood(state.focus.id, state.focus.depth) : null;
  const pathIds = state.path ? new Set(state.path.nodes) : null;
  const queryIds = state.queryResult?.nodeIds;
  const matches = state.nodes.filter(node => queryIds ? queryIds.has(node.id) : pathIds ? pathIds.has(node.id) : state.types.has(node.type) && (!focused || focused.has(node.id)) && (!query || node.searchText.includes(query)));
  state.visibleNodes = matches.slice(0, maxVisibleNodes);
  if (state.selected && matches.some(node => node.id === state.selected) && !state.visibleNodes.some(node => node.id === state.selected)) state.visibleNodes[state.visibleNodes.length - 1] = state.nodeById.get(state.selected);
  const visibleIds = new Set(state.visibleNodes.map(node => node.id));
  const pathEdges = state.queryResult?.edgeIds || (state.path ? new Set(state.path.edges.map(edge => edge.id)) : null);
  state.visibleEdges = state.edges.filter(edge => visibleIds.has(edge.source.id) && visibleIds.has(edge.target.id) && (pathEdges ? pathEdges.has(edge.id) : edgeEnabled(edge)));
  if ((state.selected && !visibleIds.has(state.selected)) || (state.selectedEdge && !state.visibleEdges.includes(state.selectedEdge))) {
    state.selected = null;
    state.selectedEdge = null;
    showSelection();
  }
  byId('node-count').textContent = `${state.visibleNodes.length} / ${state.nodes.length} nodes`;
  byId('edge-count').textContent = `${state.visibleEdges.length} relationships`;
  byId('status').textContent = matches.length > maxVisibleNodes ? `Showing ${maxVisibleNodes} of ${matches.length} matches. Search or focus to explore the rest.` : !matches.length ? 'No matching nodes. Try another search or reset your filters.' : '';
  byId('focus-banner').hidden = !state.focus && !state.path && !state.queryResult;
  byId('focus-description').textContent = state.queryResult ? `Query results · ${state.queryResult.rows} row${state.queryResult.rows === 1 ? '' : 's'} · ${state.queryResult.nodeIds.size} supporting nodes` : state.path ? `Shortest path · ${state.path.edges.length} relationship${state.path.edges.length === 1 ? '' : 's'}` : state.focus ? `${state.focus.depth}-hop neighborhood · ${shortLabel(state.nodeById.get(state.focus.id).label)}` : '';
  byId('graph-legend').replaceChildren(...[...new Set(state.visibleNodes.map(node => node.type))].map(type => {
    const item = createElement('span', 'legend-item');
    const dot = createElement('span', 'dot'); dot.style.background = colorFor({type});
    item.append(dot, document.createTextNode(type)); return item;
  }));
  renderDirectory();
  if (layout) applyLayout();
  else schedule();
  if (fit) fitGraph();
}

function applyPreset(preset) {
  state.queryResult = null;
  clearHover();
  state.preset = preset;
  state.focus = null; state.path = null; state.selected = null; state.selectedEdge = null;
  byId('search').value = ''; byId('min-weight').value = 1; byId('weight-value').textContent = '1';
  state.types = new Set(state.nodes.filter(node => preset === 'concepts' ? node.type === 'Concept' : preset === 'structure' ? node.type !== 'Concept' : true).map(node => node.type));
  state.edgeTypes = new Set(state.edges.filter(edge => preset === 'concepts' ? edge.type === 'CO_OCCURS_WITH' : preset === 'structure' ? edge.type === 'CONTAINS' : edge.type !== 'CO_OCCURS_WITH').map(edge => edge.type));
  const titles = {overview: ['Knowledge overview', 'Explore the ideas behind your document.', 'All node types'], concepts: ['Concept connections', 'Discover ideas that appear together.', 'Keywords & co-occurrence'], structure: ['Document structure', 'Follow the sections and passages.', 'Sections & source passages']};
  const [title, subtitle, chip] = titles[preset];
  byId('view-title').textContent = title; byId('view-subtitle').textContent = subtitle; byId('view-chip').textContent = chip;
  byId('path-result').replaceChildren(); byId('clear-path').hidden = true;
  syncFilters(); showSelection(); updateGraph({layout: true, fit: true});
}

function assignClusters() {
  const parent = new Map();
  for (const edge of state.edges) if (edge.type === 'CONTAINS' && !parent.has(edge.target.id)) parent.set(edge.target.id, edge.source.id);
  for (const node of state.nodes) {
    let current = node;
    const visited = new Set();
    node.cluster = 'root';
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      if (current.type === 'Section') node.cluster = current.id;
      current = state.nodeById.get(parent.get(current.id));
    }
  }
  for (const node of state.nodes.filter(item => item.type === 'Concept')) {
    const votes = new Map();
    for (const edge of state.adjacency.get(node.id)) {
      if (edge.type === 'MENTIONS') votes.set(edge.source.cluster, (votes.get(edge.source.cluster) || 0) + 1);
    }
    node.cluster = [...votes].sort((left, right) => right[1] - left[1])[0]?.[0] || 'root';
  }
}

function applyLayout() {
  const previous = state.hasLayout && graphMotionEnabled() ? new Map(state.visibleNodes.map(node => [node.id, displayPosition(node)])) : null;
  state.layoutTransition = null;
  const mode = byId('layout').value;
  const groups = new Map();
  if (mode === 'force') {
    for (const node of state.visibleNodes) {
      if (!groups.has(node.cluster)) groups.set(node.cluster, []);
      groups.get(node.cluster).push(node);
    }
    let groupIndex = 0;
    for (const [cluster, nodes] of groups) {
      const angle = groupIndex++ / Math.max(groups.size, 1) * Math.PI * 2 - Math.PI / 2;
      const distance = groups.size <= 1 || cluster === 'root' ? 0 : Math.max(210, Math.sqrt(state.visibleNodes.length) * 24);
      nodes.forEach((node, index) => {
        node.anchorX = Math.cos(angle) * distance;
        node.anchorY = Math.sin(angle) * distance;
        if (!node.pinned) {
          node.positionX = node.anchorX + Math.cos(index * 2.39996) * Math.sqrt(index + 1) * 33;
          node.positionY = node.anchorY + Math.sin(index * 2.39996) * Math.sqrt(index + 1) * 33;
        }
        node.velocityX = 0; node.velocityY = 0;
      });
    }
    for (let iteration = 0; iteration < 75; iteration++) simulate();
    schedule(reducedMotion ? 0 : 100);
  } else {
    const ids = new Set(state.visibleNodes.map(node => node.id));
    const root = state.visibleNodes.find(node => node.id === state.selected) || state.visibleNodes.find(node => node.type === 'Document') || [...state.visibleNodes].sort((left, right) => right.degree - left.degree)[0];
    const depths = new Map(root ? [[root.id, 0]] : []);
    const queue = root ? [root.id] : [];
    const links = new Map(state.visibleNodes.map(node => [node.id, []]));
    for (const edge of state.visibleEdges) { links.get(edge.source.id).push(edge.target.id); links.get(edge.target.id).push(edge.source.id); }
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const identifier = queue[cursor];
      for (const other of links.get(identifier) || []) if (ids.has(other) && !depths.has(other)) { depths.set(other, depths.get(identifier) + 1); queue.push(other); }
    }
    const lastDepth = Math.max(0, ...depths.values()) + 1;
    for (const node of state.visibleNodes) {
      const depth = depths.get(node.id) ?? lastDepth;
      if (!groups.has(depth)) groups.set(depth, []);
      groups.get(depth).push(node);
    }
    let bandPosition = 0;
    let ringRadius = 0;
    for (const [depth, nodes] of [...groups].sort((left, right) => left[0] - right[0])) {
      nodes.sort((left, right) => left.cluster.localeCompare(right.cluster) || left.label.localeCompare(right.label));
      ringRadius = depth === 0 ? 0 : Math.max(ringRadius + 165, nodes.length * 47 / (Math.PI * 2));
      nodes.forEach((node, index) => {
        const columns = Math.min(12, nodes.length);
        if (!node.pinned) {
          node.positionX = mode === 'radial' ? Math.cos(index / nodes.length * Math.PI * 2 - Math.PI / 2) * ringRadius : ((index % columns) - (columns - 1) / 2) * 100;
          node.positionY = mode === 'radial' ? Math.sin(index / nodes.length * Math.PI * 2 - Math.PI / 2) * ringRadius : bandPosition + Math.floor(index / columns) * 75;
        }
        node.velocityX = 0; node.velocityY = 0;
      });
      bandPosition += Math.ceil(nodes.length / 12) * 75 + 115;
    }
    state.remaining = 0; schedule();
  }
  updatePhysicsButton();
  if (previous) state.layoutTransition = {positions: previous, started: performance.now(), progress: 0};
  state.hasLayout = true;
}

function simulate() {
  const nodes = state.visibleNodes;
  for (const node of nodes) {
    node.layoutRadius = radiusFor(node);
    node.velocityX += ((node.anchorX || 0) - node.positionX) * .004 - node.positionX * .0004;
    node.velocityY += ((node.anchorY || 0) - node.positionY) * .004 - node.positionY * .0004;
  }
  for (let leftIndex = 0; leftIndex < nodes.length; leftIndex++) {
    const left = nodes[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex++) {
      const right = nodes[rightIndex];
      const deltaX = left.positionX - right.positionX || .1;
      const deltaY = left.positionY - right.positionY || .1;
      const distance = Math.max(1, Math.hypot(deltaX, deltaY));
      const spacing = left.layoutRadius + right.layoutRadius + 24;
      const force = Math.min(8, 1000 / (distance * distance) + Math.max(0, spacing - distance) * .1);
      const forceX = deltaX / distance * force;
      const forceY = deltaY / distance * force;
      left.velocityX += forceX; left.velocityY += forceY;
      right.velocityX -= forceX; right.velocityY -= forceY;
    }
  }
  for (const edge of state.visibleEdges) {
    const deltaX = edge.target.positionX - edge.source.positionX;
    const deltaY = edge.target.positionY - edge.source.positionY;
    const distance = Math.max(1, Math.hypot(deltaX, deltaY));
    const length = edge.type === 'CONTAINS' ? 145 : edge.type === 'MENTIONS' ? 120 : 155;
    const force = (distance - length) * (edge.type === 'CO_OCCURS_WITH' ? .0014 : .004);
    edge.source.velocityX += deltaX / distance * force; edge.source.velocityY += deltaY / distance * force;
    edge.target.velocityX -= deltaX / distance * force; edge.target.velocityY -= deltaY / distance * force;
  }
  for (const node of nodes) {
    if (node.pinned || state.pointer?.node === node) { node.velocityX = 0; node.velocityY = 0; continue; }
    node.velocityX *= .68; node.velocityY *= .68;
    node.positionX += Math.max(-12, Math.min(12, node.velocityX));
    node.positionY += Math.max(-12, Math.min(12, node.velocityY));
  }
}

function schedule(steps = 0) {
  state.remaining = Math.max(state.remaining, steps);
  if (document.hidden) return;
  if (!state.framePending) { state.framePending = true; requestAnimationFrame(frame); }
}
function frame(timestamp = performance.now()) {
  state.framePending = false;
  if (document.hidden) return;
  if (state.layoutTransition) {
    state.layoutTransition.progress = Math.max(0, Math.min(1, (timestamp - state.layoutTransition.started) / 650));
    if (state.layoutTransition.progress >= 1 || !graphMotionEnabled()) state.layoutTransition = null;
  }
  const physics = graphMotionEnabled() && state.remaining > 0 && !state.paused && byId('layout').value === 'force';
  if (physics && !state.layoutTransition) {
    simulate(); state.remaining--;
    if (state.remaining === 0 && state.fitView) fitGraph();
  }
  const effects = graphMotionEnabled() && state.visibleNodes.length > 0;
  if (physics || state.layoutTransition || !effects || timestamp - state.lastDraw >= (state.visibleNodes.length > 350 ? 64 : 32)) {
    if (effects) state.visualTime += Math.min(100, timestamp - state.lastDraw);
    state.lastDraw = timestamp;
    draw();
  }
  byId('layout-status').textContent = state.layoutTransition ? 'Transitioning layout' : state.paused ? 'Layout paused' : physics ? 'Arranging graph' : 'Ready to explore';
  if (physics || effects || state.layoutTransition) schedule();
}
function project(node) {
  const position = displayPosition(node);
  return {positionX: state.width / 2 + state.camera.positionX + position.positionX * state.camera.scale, positionY: state.height / 2 + state.camera.positionY + position.positionY * state.camera.scale};
}
function graphBounds() {
  if (!state.visibleNodes.length) return {minimumX: -100, maximumX: 100, minimumY: -100, maximumY: 100};
  return {minimumX: Math.min(...state.visibleNodes.map(node => node.positionX)) - 50, maximumX: Math.max(...state.visibleNodes.map(node => node.positionX)) + 50, minimumY: Math.min(...state.visibleNodes.map(node => node.positionY)) - 50, maximumY: Math.max(...state.visibleNodes.map(node => node.positionY)) + 50};
}
function canvasViewport() {
  const bounds = canvas.getBoundingClientRect();
  const header = document.querySelector('.canvas-header').getBoundingClientRect();
  const dock = document.querySelector('.canvas-bottom').getBoundingClientRect();
  const top = Math.min(state.height - 60, header.bottom - bounds.top + 12);
  return {left: 16, right: Math.max(40, state.width - 16), top: Math.max(12, top), bottom: Math.max(top + 40, dock.top - bounds.top - 12)};
}
function fitGraph() {
  const bounds = graphBounds();
  const viewport = canvasViewport();
  state.fitView = true;
  state.camera.scale = Math.max(.025, Math.min(1.7, (viewport.right - viewport.left) / (bounds.maximumX - bounds.minimumX), (viewport.bottom - viewport.top) / (bounds.maximumY - bounds.minimumY)));
  state.camera.positionX = (viewport.left + viewport.right - state.width) / 2 - (bounds.minimumX + bounds.maximumX) / 2 * state.camera.scale;
  state.camera.positionY = (viewport.top + viewport.bottom - state.height) / 2 - (bounds.minimumY + bounds.maximumY) / 2 * state.camera.scale;
  schedule();
}
function zoom(factor, screenX = state.width / 2, screenY = state.height / 2) {
  state.fitView = false;
  clearHover();
  const previous = state.camera.scale;
  state.camera.scale = Math.max(.025, Math.min(5, previous * factor));
  const relativeX = screenX - state.width / 2;
  const relativeY = screenY - state.height / 2;
  state.camera.positionX = relativeX - (relativeX - state.camera.positionX) * state.camera.scale / previous;
  state.camera.positionY = relativeY - (relativeY - state.camera.positionY) * state.camera.scale / previous;
  schedule();
}

function geometryFor(edge) {
  const source = project(edge.source);
  const target = project(edge.target);
  if (edge.source === edge.target) {
    const radius = screenRadius(edge.source);
    return {edge, startX: source.positionX - radius * .7, startY: source.positionY - radius * .7, endX: source.positionX + radius * .7, endY: source.positionY - radius * .7, controlX: source.positionX, controlY: source.positionY - radius - 55};
  }
  const deltaX = target.positionX - source.positionX;
  const deltaY = target.positionY - source.positionY;
  const distance = Math.max(1, Math.hypot(deltaX, deltaY));
  const bend = edge.curve * 18 + (edge.type === 'CO_OCCURS_WITH' ? 10 : 0);
  const sourceRadius = screenRadius(edge.source) + 1;
  const targetRadius = screenRadius(edge.target) + 3;
  return {edge, startX: source.positionX + deltaX / distance * sourceRadius, startY: source.positionY + deltaY / distance * sourceRadius, endX: target.positionX - deltaX / distance * targetRadius, endY: target.positionY - deltaY / distance * targetRadius, controlX: (source.positionX + target.positionX) / 2 - deltaY / distance * bend, controlY: (source.positionY + target.positionY) / 2 + deltaX / distance * bend};
}
function curvePoint(geometry, fraction) {
  const inverse = 1 - fraction;
  return {positionX: inverse * inverse * geometry.startX + 2 * inverse * fraction * geometry.controlX + fraction * fraction * geometry.endX, positionY: inverse * inverse * geometry.startY + 2 * inverse * fraction * geometry.controlY + fraction * fraction * geometry.endY};
}

function draw() {
  const pixelRatio = devicePixelRatio || 1;
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  context.globalAlpha = 1;
  context.fillStyle = graphColors.bg; context.fillRect(0, 0, state.width, state.height);
  const atmosphere = context.createRadialGradient(state.width * .48, state.height * .5, 0, state.width * .48, state.height * .5, Math.max(1, state.width, state.height) * .65);
  atmosphere.addColorStop(0, graphColors.glow); atmosphere.addColorStop(1, graphColors.bg);
  context.fillStyle = atmosphere; context.fillRect(0, 0, state.width, state.height);
  if (byId('show-grid').checked) {
    const spacing = 24;
    context.fillStyle = graphColors.grid;
    for (let gridX = ((state.camera.positionX % spacing) + spacing) % spacing; gridX < state.width; gridX += spacing) {
      for (let gridY = ((state.camera.positionY % spacing) + spacing) % spacing; gridY < state.height; gridY += spacing) context.fillRect(gridX, gridY, 1, 1);
    }
  }
  const activeId = state.hovered?.id || state.selected;
  const highlightedIds = activeId ? neighborhood(activeId, 1) : state.selectedEdge ? new Set([state.selectedEdge.source.id, state.selectedEdge.target.id]) : null;
  state.geometry = state.visibleEdges.map(geometryFor);
  for (const geometry of state.geometry) {
    const edge = geometry.edge;
    const highlighted = edge.id === state.selectedEdge?.id || edge === state.hoveredEdge || edge.source.id === activeId || edge.target.id === activeId || Boolean(state.path);
    context.globalAlpha = highlighted ? .85 : highlightedIds ? .06 : Number(byId('edge-opacity').value) / 100;
    context.strokeStyle = highlighted ? graphColors.active : edge.type === 'CO_OCCURS_WITH' ? graphColors.association : graphColors.edge;
    context.lineWidth = highlighted ? 1.6 : Math.min(2, .65 + Math.log1p(Number(edge.properties.weight) || 1) * .2);
    context.setLineDash(edge.type === 'CO_OCCURS_WITH' ? [3, 4] : []);
    context.beginPath(); context.moveTo(geometry.startX, geometry.startY); context.quadraticCurveTo(geometry.controlX, geometry.controlY, geometry.endX, geometry.endY); context.stroke();
    context.setLineDash([]);
    if (edge.type !== 'CO_OCCURS_WITH' && (highlighted || state.camera.scale > .55)) {
      const angle = Math.atan2(geometry.endY - geometry.controlY, geometry.endX - geometry.controlX);
      context.fillStyle = context.strokeStyle; context.beginPath(); context.moveTo(geometry.endX, geometry.endY);
      context.lineTo(geometry.endX - 5 * Math.cos(angle - .45), geometry.endY - 5 * Math.sin(angle - .45));
      context.lineTo(geometry.endX - 5 * Math.cos(angle + .45), geometry.endY - 5 * Math.sin(angle + .45)); context.fill();
    }
    if (edge === state.hoveredEdge || edge === state.selectedEdge || (byId('edge-labels').checked && (highlighted || state.camera.scale > .9))) {
      const midpoint = curvePoint(geometry, .5);
      context.globalAlpha = 1; context.font = '9px -apple-system, sans-serif'; context.textAlign = 'center';
      const label = formatType(edge.type); const width = context.measureText(label).width;
      context.fillStyle = graphColors.bg; context.fillRect(midpoint.positionX - width / 2 - 4, midpoint.positionY - 8, width + 8, 14);
      context.fillStyle = graphColors.active; context.fillText(label, midpoint.positionX, midpoint.positionY + 2);
    }
  }
  drawFlowParticles(activeId);
  for (const node of state.visibleNodes) {
    const point = project(node); const radius = screenRadius(node);
    const active = node.id === activeId || node.id === state.selected;
    context.globalAlpha = highlightedIds && !highlightedIds.has(node.id) ? .2 : 1;
    if (active) {
      const pulse = graphMotionEnabled() ? 1.5 * Math.sin(state.visualTime / 450) : 0;
      context.beginPath(); context.arc(point.positionX, point.positionY, radius + 7 + pulse, 0, Math.PI * 2);
      context.fillStyle = graphColors.halo; context.fill(); context.strokeStyle = graphColors.ring; context.lineWidth = 1; context.stroke();
    }
    context.shadowColor = colorFor(node);
    context.shadowBlur = active ? 16 : node.type === 'Document' || node.type === 'Section' ? 7 : 0;
    context.beginPath(); context.arc(point.positionX, point.positionY, radius, 0, Math.PI * 2);
    context.fillStyle = colorFor(node); context.fill(); context.shadowBlur = 0;
    context.strokeStyle = graphColors.outline; context.lineWidth = Math.max(1, state.camera.scale * 1.5); context.stroke();
    if (radius > 7) {
      context.strokeStyle = '#ffffffaa'; context.lineWidth = 1.1;
      if (node.type === 'Document' || node.type === 'Passage') {
        context.strokeRect(point.positionX - 3, point.positionY - 4, 6, 8);
        context.beginPath(); context.moveTo(point.positionX - 1, point.positionY); context.lineTo(point.positionX + 2, point.positionY); context.stroke();
      } else if (node.type === 'Section') {
        context.beginPath(); context.moveTo(point.positionX - 4, point.positionY); context.lineTo(point.positionX + 4, point.positionY); context.moveTo(point.positionX, point.positionY - 4); context.lineTo(point.positionX, point.positionY + 4); context.stroke();
      } else { context.beginPath(); context.arc(point.positionX, point.positionY, 2, 0, Math.PI * 2); context.fillStyle = '#ffffffc0'; context.fill(); }
    }
    if (node.pinned) {
      context.beginPath(); context.arc(point.positionX + radius * .7, point.positionY - radius * .7, 3, 0, Math.PI * 2); context.fillStyle = '#4f4a75'; context.fill();
    }
  }
  const labelMode = byId('label-mode').value;
  const viewport = canvasViewport();
  const labelLimit = Math.max(8, Math.min(80, Math.floor((viewport.right - viewport.left) * (viewport.bottom - viewport.top) / 5500)));
  const obstacles = state.visibleNodes.map(node => ({node, ...project(node), radius: screenRadius(node) + 2}));
  const previousLabels = new Map(state.labelBoxes.map(box => [box.node.id, box]));
  state.labelBoxes = [];
  const ranked = [...state.visibleNodes].sort((left, right) => Number(right.id === activeId) - Number(left.id === activeId) || Number(right.id === state.selected) - Number(left.id === state.selected) || right.degree - left.degree);
  for (const node of ranked) {
    const active = node.id === activeId || node.id === state.selected;
    if (labelMode === 'none' && !active) continue;
    if (highlightedIds && !highlightedIds.has(node.id) && !active) continue;
    const point = project(node); const radius = screenRadius(node);
    if (point.positionX < -50 || point.positionX > state.width + 50 || point.positionY < 0 || point.positionY > state.height) continue;
    if (!active && labelMode === 'smart' && ((node.type === 'Passage' && state.camera.scale < 1.1) || (state.camera.scale < .4 && node.degree < 8))) continue;
    if (!active && labelMode === 'smart' && state.labelBoxes.length >= labelLimit) continue;
    context.font = `${active ? '600' : '400'} ${active ? 13 : 11.5}px -apple-system, sans-serif`;
    const label = shortLabel(node.label, Math.min(active ? 48 : node.type === 'Section' ? 25 : 24, Math.max(12, Math.floor((viewport.right - viewport.left) / 8))));
    const width = context.measureText(label).width;
    const candidates = [
      {left: point.positionX - width / 2 - 4, top: point.positionY + radius + 4},
      {left: point.positionX + radius + 5, top: point.positionY - 10},
      {left: point.positionX - width - radius - 13, top: point.positionY - 10},
      {left: point.positionX - width / 2 - 4, top: point.positionY - radius - 24},
    ].map(position => ({...position, right: position.left + width + 8, bottom: position.top + 20, node}));
    const previous = previousLabels.get(node.id);
    if (node === state.hovered && previous) {
      const left = Math.max(viewport.left, Math.min(viewport.right - width - 8, previous.left + point.positionX - previous.nodeX));
      const top = Math.max(viewport.top, Math.min(viewport.bottom - 20, previous.top + point.positionY - previous.nodeY));
      candidates.unshift({left, top, right: left + width + 8, bottom: top + 20, node});
    }
    const fits = box => box.left >= viewport.left && box.right <= viewport.right && box.top >= viewport.top && box.bottom <= viewport.bottom;
    let box = candidates.find(candidate => fits(candidate) && (active || labelMode === 'all' || (
      !state.labelBoxes.some(other => candidate.left < other.right + 4 && candidate.right > other.left - 4 && candidate.top < other.bottom + 4 && candidate.bottom > other.top - 4) &&
      !obstacles.some(other => other.node !== node && other.positionX + other.radius > candidate.left && other.positionX - other.radius < candidate.right && other.positionY + other.radius > candidate.top && other.positionY - other.radius < candidate.bottom)
    )));
    if (!box && active && point.positionX >= viewport.left && point.positionX <= viewport.right && point.positionY >= viewport.top && point.positionY <= viewport.bottom) {
      const left = Math.max(viewport.left, Math.min(viewport.right - width - 8, candidates[0].left));
      const top = Math.max(viewport.top, Math.min(viewport.bottom - 20, candidates[0].top));
      box = {left, right: left + width + 8, top, bottom: top + 20, node};
    }
    if (!box) continue;
    box.nodeX = point.positionX;
    box.nodeY = point.positionY;
    state.labelBoxes.push(box); context.globalAlpha = 1; context.fillStyle = graphColors['label-bg'];
    context.beginPath(); context.roundRect(box.left, box.top, box.right - box.left, box.bottom - box.top, 3); context.fill();
    context.fillStyle = active ? graphColors['label-active'] : graphColors.label; context.textAlign = 'center'; context.fillText(label, (box.left + box.right) / 2, box.bottom - 5);
  }
  context.globalAlpha = 1;
  byId('zoom-value').textContent = `${Math.round(state.camera.scale * 100)}%`;
  drawMinimap();
}

function drawFlowParticles(activeId) {
  if (!graphMotionEnabled()) return;
  const routes = state.geometry.filter(({edge}) => edge.type !== 'CO_OCCURS_WITH' && (!activeId || edge.source.id === activeId || edge.target.id === activeId));
  const limit = state.visibleNodes.length > 350 ? 12 : 28;
  const stride = Math.max(1, Math.ceil(routes.length / limit));
  context.save();
  context.fillStyle = graphColors.particle; context.shadowColor = graphColors.active; context.shadowBlur = 7;
  for (let index = 0; index < routes.length; index += stride) {
    const fraction = (state.visualTime / 4200 + index * .618) % 1;
    const point = curvePoint(routes[index], fraction);
    context.globalAlpha = (activeId ? .9 : .6) * Math.sin(Math.PI * fraction);
    context.beginPath(); context.arc(point.positionX, point.positionY, activeId ? 2.4 : 1.7, 0, Math.PI * 2); context.fill();
  }
  context.restore();
}

function drawMinimap() {
  if (!byId('show-minimap').checked || !minimap.clientWidth) return;
  const width = minimap.clientWidth; const height = minimap.clientHeight;
  minimap.width = width * (devicePixelRatio || 1); minimap.height = height * (devicePixelRatio || 1);
  mapContext.setTransform(devicePixelRatio || 1, 0, 0, devicePixelRatio || 1, 0, 0);
  const bounds = graphBounds();
  const scale = Math.min((width - 10) / (bounds.maximumX - bounds.minimumX), (height - 10) / (bounds.maximumY - bounds.minimumY));
  const offsetX = (width - (bounds.maximumX + bounds.minimumX) * scale) / 2;
  const offsetY = (height - (bounds.maximumY + bounds.minimumY) * scale) / 2;
  state.mapBounds = {scale, offsetX, offsetY};
  for (const node of state.visibleNodes) { mapContext.fillStyle = colorFor(node); mapContext.beginPath(); mapContext.arc(node.positionX * scale + offsetX, node.positionY * scale + offsetY, 1.4, 0, Math.PI * 2); mapContext.fill(); }
  mapContext.fillStyle = graphColors.halo + '33'; mapContext.strokeStyle = graphColors.ring; mapContext.lineWidth = .8;
  const viewportX = (-state.width / 2 - state.camera.positionX) / state.camera.scale * scale + offsetX;
  const viewportY = (-state.height / 2 - state.camera.positionY) / state.camera.scale * scale + offsetY;
  const viewportWidth = state.width / state.camera.scale * scale; const viewportHeight = state.height / state.camera.scale * scale;
  mapContext.fillRect(viewportX, viewportY, viewportWidth, viewportHeight); mapContext.strokeRect(viewportX, viewportY, viewportWidth, viewportHeight);
}

function showProperties(properties) {
  byId('detail-properties').replaceChildren(...Object.entries(properties).filter(([key]) => key !== 'text' && key !== 'evidence').map(([key, value]) => {
    const row = createElement('div', 'property');
    row.append(createElement('dt', '', key.replaceAll('_', ' ')), createElement('dd', '', typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value)));
    return row;
  }));
}
function connectionCard(edge, nodeId) {
  const card = createElement('div', 'relation-card');
  const outgoing = edge.source.id === nodeId;
  const other = outgoing ? edge.target : edge.source;
  const direction = edge.type === 'CO_OCCURS_WITH' ? '↔' : outgoing ? '→' : '←';
  const edgeButton = createElement('button', 'relation-label', `${direction} ${edge.type}${edge.properties.weight ? ' · ' + edge.properties.weight + ' shared passages' : ''}`);
  edgeButton.addEventListener('click', () => selectEdge(edge));
  const nodeLink = createElement('button', '', other.label);
  nodeLink.addEventListener('click', () => selectNode(other.id));
  card.append(edgeButton, createElement('br'), nodeLink);
  return card;
}
function renderConnections() {
  const node = state.nodeById.get(state.selected);
  const edges = node ? state.adjacency.get(node.id) : state.selectedEdge ? [state.selectedEdge] : [];
  const container = byId('relationships'); container.replaceChildren();
  if (node) {
    const sorted = [...edges].sort((left, right) => Number(edgeEnabled(right)) - Number(edgeEnabled(left)) || (Number(right.properties.weight) || 0) - (Number(left.properties.weight) || 0));
    for (const edge of sorted.slice(0, state.connectionLimit)) container.append(connectionCard(edge, node.id));
  } else if (state.selectedEdge) {
    const edge = state.selectedEdge;
    container.append(createElement('div', 'eyebrow', 'Endpoints'), nodeButton(edge.source), nodeButton(edge.target));
    const evidence = Array.isArray(edge.properties.evidence) ? edge.properties.evidence : [];
    if (evidence.length) container.append(createElement('div', 'eyebrow', 'Source evidence'));
    for (const identifier of evidence.slice(0, state.connectionLimit)) {
      const source = state.nodeById.get(identifier);
      if (!source) continue;
      const card = createElement('div', 'relation-card');
      card.append(createElement('p', 'help-text', shortLabel(String(source.properties.text || source.label), 230)));
      const link = createElement('button', 'source-link', 'Read source passage →');
      link.addEventListener('click', () => selectNode(identifier)); card.append(link); container.append(card);
    }
  }
  const count = node ? edges.length : state.selectedEdge?.properties.evidence?.length || 0;
  byId('more-relations').hidden = count <= state.connectionLimit;
  if (!count && node) container.append(createElement('p', 'help-text', 'This node has no relationships.'));
}
function setDetailTab(tab) {
  byId('detail-content').hidden = tab !== 'content'; byId('detail-connections').hidden = tab !== 'connections';
  document.querySelectorAll('[data-detail]').forEach(button => button.setAttribute('aria-selected', String(button.dataset.detail === tab)));
}
function showSelection() {
  const node = state.nodeById.get(state.selected); const edge = state.selectedEdge;
  const selected = node || edge;
  byId('overview').hidden = Boolean(selected); byId('selection').hidden = !selected;
  byId('inspector-title').textContent = node ? 'Node inspector' : edge ? 'Relationship inspector' : 'Graph overview';
  if (!selected) return;
  byId('detail-type').textContent = selected.type;
  byId('detail-title').textContent = node ? node.label : `${edge.source.label} → ${edge.target.label}`;
  byId('detail-summary').textContent = node ? `${node.degree} total relationships${node.pinned ? ' · Pinned in place' : ''}` : edge.type === 'CO_OCCURS_WITH' ? 'An undirected association between keywords in the same passage.' : 'A directed relationship between these nodes.';
  byId('detail-text').textContent = node ? String(node.properties.text || (node.type === 'Concept' ? 'A keyword extracted from the document. Open Connections to find mentions and supporting source passages.' : 'Select a connection to continue exploring.')) : edge.type === 'CO_OCCURS_WITH' ? `${edge.properties.weight || 1} shared passage(s). Open Connections to inspect source evidence.` : `${edge.source.label} ${formatType(edge.type).toLowerCase()} ${edge.target.label}.`;
  byId('pin-label').textContent = node?.pinned ? 'Unpin' : 'Pin';
  document.querySelector('.selection-actions').hidden = !node;
  showProperties({id: selected.id, ...selected.properties}); renderConnections();
}
function selectNode(identifier, {openDetails = true} = {}) {
  clearHover();
  const node = state.nodeById.get(identifier);
  state.selected = node?.id || null; state.selectedEdge = null; state.connectionLimit = 30;
  if (node && !state.visibleNodes.includes(node)) {
    invalidatePath(); state.focus = null; byId('search').value = '';
    state.types.add(node.type); state.preset = 'custom'; syncFilters();
    updateGraph();
    if (!state.visibleNodes.includes(node)) { state.focus = {id: node.id, depth: 1}; updateGraph({layout: true, fit: true}); }
  }
  showSelection(); setDetailTab('content'); renderDirectory(); schedule();
  if (node) {
    if (!state.path) byId('path-source').value = node.id;
    if (openDetails) openInspector();
    const point = project(node);
    const viewport = canvasViewport();
    if (point.positionX < viewport.left || point.positionX > viewport.right || point.positionY < viewport.top || point.positionY > viewport.bottom) {
      state.fitView = false;
      state.camera.positionX = (viewport.left + viewport.right - state.width) / 2 - node.positionX * state.camera.scale;
      state.camera.positionY = (viewport.top + viewport.bottom - state.height) / 2 - node.positionY * state.camera.scale;
      schedule();
    }
  }
}
function selectEdge(edge) {
  clearHover();
  state.selected = null; state.selectedEdge = edge; state.connectionLimit = 30;
  showSelection(); setDetailTab('connections'); openInspector(); renderDirectory(); schedule();
}
function focusNode(depth) {
  if (!state.selected) return;
  invalidatePath(); state.focus = {id: state.selected, depth}; byId('search').value = '';
  for (const identifier of neighborhood(state.selected, depth)) state.types.add(state.nodeById.get(identifier).type);
  syncFilters(); updateGraph({layout: true, fit: true});
}
function clearFocus() {
  state.queryResult = null;
  state.focus = null; state.path = null; byId('clear-path').hidden = true; byId('path-result').replaceChildren();
  updateGraph({layout: true, fit: true});
}

function shortestPath(source, target, directed) {
  const previous = new Map([[source, null]]);
  const queue = [source];
  for (let cursor = 0; cursor < queue.length && !previous.has(target); cursor++) {
    const identifier = queue[cursor];
    for (const edge of state.adjacency.get(identifier) || []) {
      if (!edgeEnabled(edge) || (directed && edge.type !== 'CO_OCCURS_WITH' && edge.source.id !== identifier)) continue;
      const other = edge.source.id === identifier ? edge.target.id : edge.source.id;
      if (!previous.has(other)) { previous.set(other, {identifier, edge}); queue.push(other); }
    }
  }
  if (!previous.has(target)) return null;
  const nodes = [target]; const edges = [];
  let current = target;
  while (previous.get(current)) { const step = previous.get(current); edges.unshift(step.edge); nodes.unshift(step.identifier); current = step.identifier; }
  return {nodes, edges};
}
function findPath() {
  state.queryResult = null;
  const source = byId('path-source').value; const target = byId('path-target').value;
  if (!state.nodeById.has(source) || !state.nodeById.has(target)) return;
  const result = shortestPath(source, target, byId('path-direction').value === 'directed');
  state.path = result; state.focus = null; state.selectedEdge = null;
  byId('path-result').replaceChildren(); byId('clear-path').hidden = !result;
  if (!result) {
    byId('path-result').textContent = 'No route exists with the current relationship filters and direction. Enable more relationships or choose any direction.';
    updateGraph({layout: true, fit: true}); return;
  }
  byId('path-result').append(createElement('p', 'help-text', `${result.edges.length} relationship${result.edges.length === 1 ? '' : 's'} · shortest route`));
  result.nodes.forEach((identifier, index) => {
    byId('path-result').append(nodeButton(state.nodeById.get(identifier)));
    if (result.edges[index]) byId('path-result').append(createElement('div', 'path-step', formatType(result.edges[index].type) + ' ↓'));
  });
  state.selected = null; showSelection(); updateGraph({layout: true, fit: true});
  if (innerWidth <= 760) document.body.classList.remove('sidebar-open');
}

const queryExamples = [
  {name: 'Most mentioned concepts', parameters: {}, source: `MATCH (passage:Passage)-[:MENTIONS]->(concept:Concept)
WITH concept, count(DISTINCT passage) AS mentions
WHERE mentions >= 2
RETURN concept, mentions
ORDER BY mentions DESC
LIMIT 25`},
  {name: 'Search passage text', parameters: {term: 'security'}, source: `MATCH (passage:Passage)
WHERE toLower(passage.text) CONTAINS toLower($term)
OPTIONAL MATCH (passage)-[:MENTIONS]->(concept:Concept)
RETURN passage, collect(DISTINCT concept) AS concepts
LIMIT 50`},
  {name: 'Strong concept connections', parameters: {weight: 3}, source: `MATCH (first:Concept)-[link:CO_OCCURS_WITH]->(second:Concept)
WHERE link.weight >= $weight
RETURN first, link, second, link.weight AS sharedPassages
ORDER BY sharedPassages DESC
LIMIT 50`},
  {name: 'Paths to source passages', parameters: {term: 'data'}, source: `MATCH path=(document:Document)-[:CONTAINS*1..3]->(passage:Passage)
WHERE toLower(passage.text) CONTAINS toLower($term)
RETURN path, length(path) AS hops, passage.text AS text
ORDER BY hops
LIMIT 25`},
  {name: 'Passages mentioning both concepts', parameters: {first: 'provider', second: 'agreement'}, source: `MATCH (first:Concept {label: $first})<-[:MENTIONS]-(passage:Passage),
      (passage)-[:MENTIONS]->(second:Concept {label: $second})
RETURN passage, first, second
LIMIT 50`},
];
const queryEditor = {result: null, page: 0, pageSize: 50, generation: 0, controller: null};

function queryStatus(message, error = false) {
  byId('query-status').textContent = message;
  byId('query-status').classList.toggle('query-error', error);
}
function cancelQuery() {
  queryEditor.generation++;
  queryEditor.controller?.abort();
  queryEditor.controller = null;
  byId('run-query').disabled = false;
  byId('query-results').setAttribute('aria-busy', 'false');
}
function resetQueryResults() {
  cancelQuery();
  queryEditor.result = null;
  queryEditor.page = 0;
  byId('query-results').hidden = true;
  byId('query-paging').hidden = true;
  byId('query-columns').replaceChildren();
  byId('query-rows').replaceChildren();
  byId('show-query-graph').disabled = true;
  byId('download-query').disabled = true;
  byId('query-input').removeAttribute('aria-invalid');
  byId('query-params').removeAttribute('aria-invalid');
  if (state.queryResult) clearFocus();
}
function showQueryGraph(graph, rows) {
  invalidatePath();
  state.focus = null; state.selected = null; state.selectedEdge = null;
  byId('search').value = '';
  state.queryResult = {nodeIds: new Set(graph.node_ids), edgeIds: new Set(graph.edge_ids), rows};
  state.directoryLimit = 30;
  showSelection(); updateGraph({layout: true, fit: true});
  byId('query-dialog').close();
  if (innerWidth <= 760) document.body.classList.remove('sidebar-open', 'inspector-open');
}
function queryCell(value) {
  const cell = createElement('td');
  const kind = value && typeof value === 'object' && value.$type;
  const node = kind === 'node' && state.nodeById.get(value.id);
  const edge = kind === 'relationship' && state.edges.find(item => item.id === value.id);
  const path = kind === 'path' && Array.isArray(value.nodes) && Array.isArray(value.relationships)
    && value.nodes.every(item => item && state.nodeById.has(item.id))
    && value.relationships.every(item => item && state.edges.some(edge => edge.id === item.id));
  if (node || edge || path) {
    const label = node ? `${node.type} · ${node.label}` : edge ? `${edge.source.label} → ${edge.type} → ${edge.target.label}` : `Path · ${value.relationships.length} hops · ${value.nodes.map(item => item.label).join(' → ')}`;
    const button = createElement('button', 'query-entity', shortLabel(label, 160));
    button.title = label;
    button.addEventListener('click', () => {
      if (path) showQueryGraph({node_ids: value.nodes.map(item => item.id), edge_ids: value.relationships.map(item => item.id)}, 1);
      else {
        showQueryGraph(queryEditor.result.graph, queryEditor.result.rows.length);
        if (node) selectNode(node.id);
        else selectEdge(edge);
      }
    });
    cell.append(button);
  } else {
    const content = value === null ? 'null' : typeof value === 'object' ? JSON.stringify(value) : String(value);
    cell.textContent = shortLabel(content, 800);
    if (content.length > 800) cell.append(createElement('div', 'help-text', 'Full value available in Download results.'));
  }
  return cell;
}
function renderQueryRows() {
  const result = queryEditor.result;
  if (!result) return;
  const header = createElement('tr');
  for (const column of result.columns) { const cell = createElement('th', '', column); cell.scope = 'col'; header.append(cell); }
  byId('query-columns').replaceChildren(header);
  const start = queryEditor.page * queryEditor.pageSize;
  byId('query-rows').replaceChildren(...result.rows.slice(start, start + queryEditor.pageSize).map(values => {
    const row = createElement('tr'); row.append(...values.map(queryCell)); return row;
  }));
  byId('query-results').hidden = !result.rows.length;
  byId('query-paging').hidden = result.rows.length <= queryEditor.pageSize;
  byId('query-previous').disabled = queryEditor.page === 0;
  byId('query-next').disabled = start + queryEditor.pageSize >= result.rows.length;
  byId('query-page-label').textContent = `${start + 1}–${Math.min(start + queryEditor.pageSize, result.rows.length)} of ${result.rows.length}`;
  byId('query-results').scrollTop = 0;
}
async function runQuery() {
  resetQueryResults();
  const source = byId('query-input').value;
  let parameters;
  try {
    parameters = JSON.parse(byId('query-params').value, (key, value) => {
      if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Numbers must be finite.');
      return value;
    });
    if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) throw new Error('Use a JSON object, for example {"term": "security"}.');
  } catch (error) {
    queryStatus(`Invalid parameters: ${error.message}`, true);
    byId('query-parameters').open = true;
    byId('query-params').setAttribute('aria-invalid', 'true');
    byId('query-params').focus();
    return;
  }
  const generation = queryEditor.generation;
  const controller = new AbortController();
  queryEditor.controller = controller;
  byId('run-query').disabled = true;
  byId('query-results').setAttribute('aria-busy', 'true');
  queryStatus('Running against the full graph…');
  try {
    const response = await GraphWorkspace.fetch('/api/query', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({query: source, parameters}), signal: controller.signal,
    });
    const result = await response.json();
    if (generation !== queryEditor.generation) return;
    if (!response.ok) {
      const detail = result.error || {};
      const location = detail.line ? `Line ${detail.line}, column ${detail.column}: ` : '';
      queryStatus(location + (detail.message || `Query failed (${response.status}).`), true);
      if (Number.isInteger(detail.position)) {
        const position = Array.from(source).slice(0, detail.position).join('').length;
        byId('query-input').setAttribute('aria-invalid', 'true');
        byId('query-input').focus();
        byId('query-input').setSelectionRange(position, position + 1);
      }
      return;
    }
    queryEditor.result = result;
    renderQueryRows();
    byId('show-query-graph').disabled = !result.graph.node_ids.length;
    byId('download-query').disabled = false;
    queryStatus(`${result.rows.length} row${result.rows.length === 1 ? '' : 's'} · ${result.stats.elapsed_ms} ms · ${result.graph.node_ids.length} supporting nodes · ${result.graph.edge_ids.length} relationships${result.truncated ? `\nOutput truncated: ${result.stats.total_rows} rows matched. Use SKIP / LIMIT or return smaller values.` : !result.rows.length ? '\nNo matches. Try a different term or broader pattern.' : !result.graph.node_ids.length ? '\nScalar result: no graph entities to display.' : ''}`);
  } catch (error) {
    if (generation === queryEditor.generation && error.name !== 'AbortError') queryStatus(`Unable to run query: ${error.message}. Check that the local server is running.`, true);
  } finally {
    if (generation === queryEditor.generation) {
      queryEditor.controller = null;
      byId('run-query').disabled = false;
      byId('query-results').setAttribute('aria-busy', 'false');
    }
  }
}
byId('query-examples').append(createElement('option', '', 'Load an example…'));
byId('query-examples').firstElementChild.value = '';
queryExamples.forEach((example, index) => {
  const option = createElement('option', '', example.name); option.value = String(index); byId('query-examples').append(option);
});
byId('query-input').value = queryExamples[0].source;
byId('query-examples').value = '0';
byId('open-query').addEventListener('click', () => {
  if (!state.initialized) { toast('Wait for the graph to load before querying.'); return; }
  byId('query-dialog').showModal(); byId('query-input').focus();
});
byId('close-query').addEventListener('click', () => byId('query-dialog').close());
byId('query-dialog').addEventListener('close', () => {
  if (queryEditor.controller) { cancelQuery(); queryStatus('Request cancelled. Run the query again when ready.'); }
});
byId('query-dialog').addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); if (!queryEditor.controller) runQuery(); }
});
byId('query-examples').addEventListener('change', () => {
  if (!byId('query-examples').value) return;
  const example = queryExamples[Number(byId('query-examples').value)];
  resetQueryResults();
  byId('query-input').value = example.source;
  byId('query-params').value = JSON.stringify(example.parameters, null, 2);
  byId('query-parameters').open = Object.keys(example.parameters).length > 0;
  queryStatus('Example loaded. Adjust its parameters, then run the query.');
});
for (const identifier of ['query-input', 'query-params']) byId(identifier).addEventListener('input', () => {
  resetQueryResults(); byId('query-examples').value = ''; queryStatus('Query changed. Run it to refresh the results.');
});
byId('run-query').addEventListener('click', runQuery);
byId('show-query-graph').addEventListener('click', () => { if (queryEditor.result) showQueryGraph(queryEditor.result.graph, queryEditor.result.rows.length); });
byId('query-previous').addEventListener('click', () => { if (queryEditor.page > 0) { queryEditor.page--; renderQueryRows(); } });
byId('query-next').addEventListener('click', () => { if ((queryEditor.page + 1) * queryEditor.pageSize < queryEditor.result.rows.length) { queryEditor.page++; renderQueryRows(); } });
byId('download-query').addEventListener('click', () => {
  if (!queryEditor.result) return;
  const blob = new Blob([JSON.stringify(queryEditor.result, null, 2) + '\n'], {type: 'application/json'});
  const url = URL.createObjectURL(blob); const link = document.createElement('a');
  link.href = url; link.download = 'graph-query-results.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

function pointOnCanvas(event) {
  const bounds = canvas.getBoundingClientRect();
  return {positionX: event.clientX - bounds.left, positionY: event.clientY - bounds.top};
}
function worldPoint(point) {
  return {positionX: (point.positionX - state.width / 2 - state.camera.positionX) / state.camera.scale, positionY: (point.positionY - state.height / 2 - state.camera.positionY) / state.camera.scale};
}
function hitNode(point) {
  const node = [...state.visibleNodes].reverse().find(node => {
    const projected = project(node);
    return Math.hypot(projected.positionX - point.positionX, projected.positionY - point.positionY) <= screenRadius(node) + 3;
  });
  return node || state.labelBoxes.find(box => point.positionX >= box.left && point.positionX <= box.right && point.positionY >= box.top && point.positionY <= box.bottom)?.node;
}
function hitEdge(point) {
  for (const geometry of [...state.geometry].reverse()) {
    let previous = curvePoint(geometry, 0);
    for (let segment = 1; segment <= 14; segment++) {
      const next = curvePoint(geometry, segment / 14);
      const deltaX = next.positionX - previous.positionX; const deltaY = next.positionY - previous.positionY;
      const fraction = Math.max(0, Math.min(1, ((point.positionX - previous.positionX) * deltaX + (point.positionY - previous.positionY) * deltaY) / Math.max(1, deltaX * deltaX + deltaY * deltaY)));
      if (Math.hypot(point.positionX - previous.positionX - fraction * deltaX, point.positionY - previous.positionY - fraction * deltaY) < 4) return geometry.edge;
      previous = next;
    }
  }
  return null;
}
function updateTooltip(point) {
  const tooltip = byId('tooltip'); const node = state.hovered; const edge = state.hoveredEdge;
  tooltip.hidden = !node && !edge;
  if (tooltip.hidden) return;
  tooltip.replaceChildren(document.createTextNode(shortLabel(node ? node.label : formatType(edge.type), 80)), createElement('small', '', node ? `${node.type} · ${node.degree} connections${node.pinned ? ' · Pinned' : ''}` : `${shortLabel(edge.source.label, 25)} ${edge.type === 'CO_OCCURS_WITH' ? '↔' : '→'} ${shortLabel(edge.target.label, 25)}`));
  tooltip.style.left = Math.max(8, Math.min(state.width - tooltip.offsetWidth - 8, point.positionX + 16)) + 'px';
  tooltip.style.top = Math.max(8, Math.min(state.height - tooltip.offsetHeight - 8, point.positionY + 16)) + 'px';
}
canvas.addEventListener('pointerdown', event => {
  if (event.button !== 0 || state.pointer) return;
  settleLayoutTransition();
  canvas.setPointerCapture(event.pointerId);
  const point = pointOnCanvas(event); const world = worldPoint(point); const node = hitNode(point);
  state.pointer = {identifier: event.pointerId, node, edge: node ? null : hitEdge(point), startX: point.positionX, startY: point.positionY, lastX: point.positionX, lastY: point.positionY, grabX: node ? node.positionX - world.positionX : 0, grabY: node ? node.positionY - world.positionY : 0, moved: false};
  byId('tooltip').hidden = true;
});
canvas.addEventListener('pointermove', event => {
  const point = pointOnCanvas(event); const pointer = state.pointer;
  if (!pointer) {
    const node = hitNode(point); const edge = node ? null : hitEdge(point);
    if (state.hovered !== node || state.hoveredEdge !== edge) { state.hovered = node; state.hoveredEdge = edge; schedule(); }
    canvas.style.cursor = node || edge ? 'pointer' : 'grab'; updateTooltip(point); return;
  }
  if (pointer.identifier !== event.pointerId) return;
  if (Math.hypot(point.positionX - pointer.startX, point.positionY - pointer.startY) > 4) pointer.moved = true;
  if (pointer.moved) state.fitView = false;
  if (pointer.moved && pointer.node) {
    const world = worldPoint(point); pointer.node.positionX = world.positionX + pointer.grabX; pointer.node.positionY = world.positionY + pointer.grabY; pointer.node.pinned = true; schedule(25);
  } else if (pointer.moved) {
    state.camera.positionX += point.positionX - pointer.lastX; state.camera.positionY += point.positionY - pointer.lastY; schedule();
  }
  pointer.lastX = point.positionX; pointer.lastY = point.positionY;
});
canvas.addEventListener('pointerup', event => {
  const pointer = state.pointer; if (!pointer || pointer.identifier !== event.pointerId) return;
  state.pointer = null;
  if (!pointer.moved) {
    if (pointer.node) {
      const previous = state.lastNodeClick;
      if (!previous || performance.now() - previous.time > 450 || Math.hypot(event.clientX - previous.clientX, event.clientY - previous.clientY) > 8) {
        state.lastNodeClick = {id: pointer.node.id, clientX: event.clientX, clientY: event.clientY, time: performance.now()};
      }
      selectNode(pointer.node.id);
    } else if (pointer.edge) selectEdge(pointer.edge);
    else selectNode(null);
  } else if (pointer.node) {
    selectNode(pointer.node.id);
    toast('Node pinned. Use Unpin in the inspector to release it.');
  }
});
canvas.addEventListener('pointercancel', () => { state.pointer = null; });
canvas.addEventListener('lostpointercapture', () => { state.pointer = null; });
canvas.addEventListener('pointerleave', () => { clearHover(); schedule(); });
canvas.addEventListener('dblclick', event => {
  const previous = state.lastNodeClick;
  const sameClick = previous && performance.now() - previous.time <= 500 && Math.hypot(event.clientX - previous.clientX, event.clientY - previous.clientY) <= 8;
  const node = sameClick ? state.nodeById.get(previous.id) : hitNode(pointOnCanvas(event));
  state.lastNodeClick = null;
  if (node) { selectNode(node.id); focusNode(1); }
});
canvas.addEventListener('wheel', event => { event.preventDefault(); const point = pointOnCanvas(event); zoom(Math.exp(-Math.max(-200, Math.min(200, event.deltaY)) * .002), point.positionX, point.positionY); }, {passive: false});
minimap.addEventListener('click', event => {
  if (!state.mapBounds) return;
  state.fitView = false;
  clearHover();
  const bounds = minimap.getBoundingClientRect(); const map = state.mapBounds;
  state.camera.positionX = -(event.clientX - bounds.left - map.offsetX) / map.scale * state.camera.scale;
  state.camera.positionY = -(event.clientY - bounds.top - map.offsetY) / map.scale * state.camera.scale; schedule();
});

const motionLabel = createElement('label', 'filter-row');
const motionInput = createElement('input'); motionInput.id = 'graph-motion'; motionInput.type = 'checkbox';
motionLabel.append(motionInput, document.createTextNode('Animate graph connections'));
const motionNote = createElement('p', 'help-text'); motionNote.id = 'motion-note';
motionInput.setAttribute('aria-describedby', 'motion-note');
byId('panel-appearance').querySelector('.eyebrow').after(motionLabel, motionNote);
const motionButton = createElement('button'); motionButton.id = 'motion-toggle'; motionButton.type = 'button';
const motionIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); motionIcon.classList.add('icon');
const motionIconUse = document.createElementNS('http://www.w3.org/2000/svg', 'use'); motionIconUse.setAttribute('href', '#i-sparkles');
motionIcon.append(motionIconUse); motionButton.append(motionIcon); byId('physics').after(motionButton);
function updateMotionControls() {
  const enabled = state.effectsEnabled && !reducedMotion;
  motionInput.checked = enabled; motionInput.disabled = reducedMotion;
  motionButton.disabled = reducedMotion;
  motionButton.setAttribute('aria-pressed', String(enabled));
  motionButton.setAttribute('aria-label', reducedMotion ? 'Graph animation disabled by system' : enabled ? 'Pause graph animation' : 'Enable graph animation');
  motionButton.title = motionButton.getAttribute('aria-label');
  motionNote.textContent = reducedMotion ? 'Your system requests reduced motion. Graph animation and layout motion are off.' : 'Gentle relationship flow, selection pulses, and smooth layout changes. Turn off for a still canvas.';
  document.documentElement.dataset.motion = enabled ? 'on' : 'off';
}
function setGraphMotion(enabled) {
  state.effectsEnabled = enabled;
  GraphAppearance.save('motion', enabled ? 'on' : 'off');
  if (!enabled) settleLayoutTransition();
  updateMotionControls(); updatePhysicsButton(); schedule();
}
motionInput.addEventListener('change', () => setGraphMotion(motionInput.checked));
motionButton.addEventListener('click', () => setGraphMotion(!state.effectsEnabled));
motionPreference.addEventListener('change', event => {
  reducedMotion = event.matches;
  if (reducedMotion) { settleLayoutTransition(); state.paused = true; state.remaining = 0; }
  updateMotionControls(); updatePhysicsButton(); schedule();
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) { state.lastDraw = performance.now(); schedule(); } });
updateMotionControls();

function updatePhysicsButton() {
  const stopped = !state.effectsEnabled || reducedMotion || state.paused || byId('layout').value !== 'force';
  byId('physics').disabled = !state.effectsEnabled || reducedMotion || byId('layout').value !== 'force';
  byId('physics').setAttribute('aria-label', stopped ? 'Resume layout' : 'Pause layout');
  byId('physics').setAttribute('aria-pressed', String(!stopped));
  byId('physics-icon').setAttribute('href', stopped ? '#i-play' : '#i-pause');
}
function togglePhysics() {
  if (!state.effectsEnabled || reducedMotion || byId('layout').value !== 'force') return;
  state.paused = !state.paused; updatePhysicsButton(); schedule(state.paused ? 0 : 100);
}
function resetWorkspace() {
  clearHover();
  state.lastNodeClick = null;
  state.nodes.forEach(node => { node.pinned = false; }); state.paused = reducedMotion;
  byId('layout').value = 'force'; byId('label-mode').value = 'smart'; byId('edge-labels').checked = false;
  byId('node-size').value = 100; byId('size-value').textContent = '100%'; byId('edge-opacity').value = 35; byId('opacity-value').textContent = '35%';
  byId('show-grid').checked = true; byId('show-minimap').checked = true; byId('minimap-wrap').hidden = false;
  state.directoryLimit = 30; applyPreset('overview');
}
document.querySelectorAll('[data-panel]').forEach(button => button.addEventListener('click', () => openPanel(button.dataset.panel)));
document.querySelectorAll('[data-preset]').forEach(button => button.addEventListener('click', () => applyPreset(button.dataset.preset)));
document.querySelectorAll('[data-detail]').forEach(button => button.addEventListener('click', () => setDetailTab(button.dataset.detail)));
byId('toggle-sidebar').addEventListener('click', () => {
  if (innerWidth <= 760) { document.body.classList.remove('hide-sidebar'); document.body.classList.toggle('sidebar-open'); document.body.classList.remove('inspector-open'); }
  else document.body.classList.toggle('hide-sidebar');
});
byId('collapse-sidebar').addEventListener('click', () => { document.body.classList.add('hide-sidebar'); document.body.classList.remove('sidebar-open'); });
byId('toggle-inspector').addEventListener('click', () => {
  if (innerWidth <= 1200) { document.body.classList.remove('hide-inspector'); document.body.classList.toggle('inspector-open'); document.body.classList.remove('sidebar-open'); }
  else document.body.classList.toggle('hide-inspector');
});
byId('close-inspector').addEventListener('click', () => { document.body.classList.add('hide-inspector'); document.body.classList.remove('inspector-open'); });
byId('search').addEventListener('input', () => { invalidatePath(); state.focus = null; state.directoryLimit = 30; updateGraph({fit: true}); });
byId('min-weight').addEventListener('input', () => { byId('weight-value').textContent = byId('min-weight').value; invalidatePath(); updateGraph(); });
byId('more-nodes').addEventListener('click', () => { state.directoryLimit += 50; renderDirectory(); });
byId('more-relations').addEventListener('click', () => { state.connectionLimit += 50; renderConnections(); });
byId('zoom-in').addEventListener('click', () => zoom(1.25)); byId('zoom-out').addEventListener('click', () => zoom(.8));
byId('fit').addEventListener('click', fitGraph); byId('physics').addEventListener('click', togglePhysics);
byId('layout').addEventListener('change', () => { applyLayout(); fitGraph(); });
byId('reset').addEventListener('click', resetWorkspace);
byId('focus-node').addEventListener('click', () => focusNode(1)); byId('expand-node').addEventListener('click', () => focusNode(2));
byId('pin-node').addEventListener('click', () => { const node = state.nodeById.get(state.selected); if (node) { node.pinned = !node.pinned; showSelection(); schedule(30); } });
byId('unpin-all').addEventListener('click', () => { state.nodes.forEach(node => { node.pinned = false; }); showSelection(); schedule(80); toast('All nodes released.'); });
byId('exit-focus').addEventListener('click', clearFocus); byId('clear-path').addEventListener('click', clearFocus);
byId('clear-selection').addEventListener('click', () => selectNode(null)); byId('find-path').addEventListener('click', findPath);
for (const identifier of ['path-source', 'path-target', 'path-direction']) byId(identifier).addEventListener('change', () => {
  if (state.path || byId('path-result').textContent) { invalidatePath(); updateGraph({layout: true, fit: true}); }
});
for (const identifier of ['label-mode', 'edge-labels', 'show-grid']) byId(identifier).addEventListener('change', () => schedule());
byId('show-minimap').addEventListener('change', () => { byId('minimap-wrap').hidden = !byId('show-minimap').checked; schedule(); });
byId('node-size').addEventListener('input', () => { byId('size-value').textContent = byId('node-size').value + '%'; schedule(); });
byId('edge-opacity').addEventListener('input', () => { byId('opacity-value').textContent = byId('edge-opacity').value + '%'; schedule(); });
byId('help').addEventListener('click', () => byId('shortcuts').showModal()); byId('close-shortcuts').addEventListener('click', () => byId('shortcuts').close());
byId('fullscreen').addEventListener('click', async () => {
  try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); }
  catch { toast('Fullscreen is unavailable in this browser.'); }
});
byId('export-image').addEventListener('click', () => {
  draw();
  canvas.toBlob(blob => {
    if (!blob) { toast('Image export failed.'); return; }
    const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = 'knowledge-graph.png'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000); document.querySelector('details.export').open = false; toast('Graph image exported.');
  }, 'image/png');
});
document.addEventListener('keydown', event => {
  if (byId('query-dialog').open) return;
  if (event.target.closest('#chat-panel')) return;
  if (event.key === 'Escape' && document.body.classList.contains('chat-open')) { window.GraphChat.close(); return; }
  if (event.key === 'Escape') {
    if (byId('shortcuts').open) return;
    byId('search').value = ''; clearFocus(); selectNode(null); return;
  }
  if (event.ctrlKey || event.metaKey || event.altKey || /INPUT|SELECT|TEXTAREA/.test(event.target.tagName) || byId('shortcuts').open) return;
  if (event.key === '/') { event.preventDefault(); byId('search').focus(); }
  else if (event.key.toLowerCase() === 'f') fitGraph();
  else if (event.key === '+' || event.key === '=') zoom(1.25);
  else if (event.key === '-') zoom(.8);
  else if (event.key === ' ' && event.target.tagName !== 'BUTTON') { event.preventDefault(); togglePhysics(); }
});
const canvasObserver = new ResizeObserver(() => {
  state.width = canvas.clientWidth; state.height = canvas.clientHeight;
  canvas.width = Math.round(state.width * (devicePixelRatio || 1)); canvas.height = Math.round(state.height * (devicePixelRatio || 1));
  if (state.initialized && state.fitView) fitGraph();
  else schedule();
});
canvasObserver.observe(canvas);
canvasObserver.observe(document.querySelector('.canvas-header'));
canvasObserver.observe(document.querySelector('.canvas-bottom'));

function initializePanels() {
  byId('total-nodes').textContent = state.nodes.length.toLocaleString(); byId('total-edges').textContent = state.edges.length.toLocaleString();
  byId('type-filters').replaceChildren(); byId('edge-filters').replaceChildren(); byId('distribution').replaceChildren();
  const types = [...new Set(state.nodes.map(node => node.type))];
  for (const type of types) {
    const count = state.nodes.filter(node => node.type === type).length;
    const row = createElement('label', 'filter-row'); const input = document.createElement('input'); input.type = 'checkbox'; input.value = type;
    input.addEventListener('change', () => { if (input.checked) state.types.add(type); else state.types.delete(type); state.preset = 'custom'; invalidatePath(); syncFilters(); updateGraph({fit: true}); });
    const dot = createElement('span', 'dot'); dot.style.background = colorFor({type});
    row.append(input, dot, document.createTextNode(type), createElement('span', 'filter-count', String(count))); byId('type-filters').append(row);
    const distribution = createElement('div', 'distribution-row'); const track = createElement('div', 'distribution-track'); const bar = createElement('div', 'distribution-bar');
    bar.style.width = count / state.nodes.length * 100 + '%'; bar.style.background = colorFor({type}); track.append(bar);
    distribution.append(createElement('span', '', type), track, createElement('span', '', String(count))); byId('distribution').append(distribution);
  }
  for (const type of new Set(state.edges.map(edge => edge.type))) {
    const row = createElement('label', 'filter-row'); const input = document.createElement('input'); input.type = 'checkbox'; input.value = type;
    input.addEventListener('change', () => { if (input.checked) state.edgeTypes.add(type); else state.edgeTypes.delete(type); state.preset = 'custom'; invalidatePath(); syncFilters(); updateGraph(); });
    row.append(input, createElement('span', 'edge-swatch' + (type === 'CO_OCCURS_WITH' ? ' dashed' : '')), document.createTextNode(formatType(type)), createElement('span', 'filter-count', String(state.edges.filter(edge => edge.type === type).length)));
    byId('edge-filters').append(row);
  }
  byId('min-weight').max = state.edges.reduce((maximum, edge) => edge.type === 'CO_OCCURS_WITH' ? Math.max(maximum, Number(edge.properties.weight) || 1) : maximum, 1);
  const ranked = [...state.nodes].sort((left, right) => right.degree - left.degree);
  byId('top-nodes').replaceChildren(...ranked.slice(0, 5).map(nodeButton));
  const sorted = [...state.nodes].sort((left, right) => left.label.localeCompare(right.label));
  for (const identifier of ['path-source', 'path-target']) byId(identifier).replaceChildren(...sorted.map(node => {
    const option = document.createElement('option'); option.value = node.id; option.textContent = `${node.label} (${node.type})`; return option;
  }));
  if (ranked.length) byId('path-source').value = ranked[0].id;
  if (ranked.length > 1) byId('path-target').value = ranked[1].id;
}
function loadGraph(graph) {
  resetQueryResults(); clearHover();
  queryStatus('Choose an example or write a query to begin.');
  state.selected = null; state.selectedEdge = null; state.focus = null; state.path = null; state.queryResult = null;
  state.directoryLimit = 30; state.connectionLimit = 30; state.remaining = 0; state.layoutTransition = null; state.hasLayout = false;
  state.lastNodeClick = null; state.pointer = null; state.geometry = []; state.labelBoxes = []; state.fitView = true;
  byId('error').hidden = true;
  try {
    byId('document-name').textContent = graph.metadata?.source || graph.metadata?.title || 'Knowledge graph';
    byId('source-name').textContent = graph.metadata?.source || graph.metadata?.title || 'Knowledge graph';
    byId('extraction-note').textContent = graph.metadata?.description || '';
    state.nodes = graph.nodes.map(node => ({...node, properties: node.properties || {}, positionX: 0, positionY: 0, velocityX: 0, velocityY: 0, pinned: false, searchText: `${node.label} ${node.properties?.text || ''}`.toLocaleLowerCase()}));
    state.nodeById = new Map(state.nodes.map(node => [node.id, node])); state.adjacency = new Map(state.nodes.map(node => [node.id, []]));
    state.edges = graph.edges.map(edge => ({...edge, properties: edge.properties || {}, source: state.nodeById.get(edge.source), target: state.nodeById.get(edge.target), curve: 0}));
    const parallel = new Map();
    for (const edge of state.edges) {
      state.adjacency.get(edge.source.id).push(edge); if (edge.target !== edge.source) state.adjacency.get(edge.target.id).push(edge);
      const key = JSON.stringify([edge.source.id, edge.target.id].sort()); if (!parallel.has(key)) parallel.set(key, []); parallel.get(key).push(edge);
    }
    for (const edges of parallel.values()) edges.forEach((edge, index) => { edge.curve = (index - (edges.length - 1) / 2) * (edge.source.id > edge.target.id ? -1 : 1); });
    for (const node of state.nodes) node.degree = state.adjacency.get(node.id).length;
    state.width = canvas.clientWidth; state.height = canvas.clientHeight;
    assignClusters(); initializePanels(); state.initialized = true; applyPreset('overview');
  } catch (error) {
    byId('error').hidden = false; byId('error').textContent = error.message; byId('layout-status').textContent = 'Unable to load graph';
    throw error;
  }
}
window.GraphViewer = {load: loadGraph};
