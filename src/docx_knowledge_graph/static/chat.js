'use strict';

const chatState = {ready: false, token: null, sessionId: null, active: null, turnsRemaining: 6};
let chatSetupVersion = 0;
let chatApiKey = null;
let chatResize = null;
const launchChat = createElement('button');
launchChat.id = 'open-chat';
launchChat.setAttribute('aria-label', 'Ask your graph with Astra');
launchChat.setAttribute('aria-expanded', 'false');
launchChat.setAttribute('aria-controls', 'chat-panel');
const chatIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
chatIcon.classList.add('icon');
const chatIconUse = document.createElementNS('http://www.w3.org/2000/svg', 'use');
chatIconUse.setAttribute('href', '#i-chat'); chatIcon.append(chatIconUse);
launchChat.append(chatIcon, createElement('span', 'chat-launch-label', 'Ask graph'));
document.querySelector('.top-actions').prepend(launchChat);

function closeChat() {
  finishChatResize();
  byId('chat-panel').hidden = true;
  document.body.classList.remove('chat-open');
  launchChat.setAttribute('aria-expanded', 'false');
}
window.GraphChat = {close: closeChat, isBusy: () => Boolean(chatState.active), resetForGraph: () => {
  chatSetupVersion++;
  chatState.sessionId = null; chatState.turnsRemaining = 6; chatState.ready = false; chatState.token = null;
  byId('chat-messages').replaceChildren(); byId('chat-welcome').hidden = false;
  byId('chat-setup').hidden = true; byId('chat-status').textContent = 'Checking chat setup…';
  byId('chat-input').value = ''; chatControls();
  if (!byId('chat-panel').hidden) checkChatSetup();
}};

const savedChatWidth = Number(GraphAppearance.read('chat-width', '500'));
let preferredChatWidth = Number.isFinite(savedChatWidth) && savedChatWidth >= 440 && savedChatWidth <= 900 ? savedChatWidth : 500;
function chatWidthLimits() {
  if (innerWidth <= 760) {
    const width = Math.max(1, Math.round(innerWidth - 16));
    return {minimum: width, maximum: width, fullWidth: true};
  }
  const sideWidth = document.querySelector('.sidebar').getBoundingClientRect().width;
  const railWidth = document.querySelector('.rail').getBoundingClientRect().width;
  const maximum = Math.floor(Math.min(900, innerWidth > 1200 ? innerWidth - sideWidth - railWidth - 360 : innerWidth - 24) / 10) * 10;
  return {minimum: Math.min(440, maximum), maximum, fullWidth: false};
}
function updateChatWidth() {
  const {minimum, maximum, fullWidth} = chatWidthLimits();
  const width = Math.max(minimum, Math.min(maximum, preferredChatWidth));
  byId('chat-width').min = minimum;
  byId('chat-width').max = maximum;
  byId('chat-width').value = width;
  byId('chat-width').disabled = fullWidth;
  byId('chat-width-value').textContent = `${width}px`;
  byId('chat-width-note').textContent = fullWidth ? 'Chat uses the full width on phones. Resize on a larger screen.' : 'Drag the chat’s left edge, or adjust its width here. Double-click the grip to reset.';
  const handle = byId('chat-resizer');
  handle.setAttribute('aria-valuemin', minimum);
  handle.setAttribute('aria-valuemax', maximum);
  handle.setAttribute('aria-valuenow', width);
  handle.setAttribute('aria-valuetext', `${width} pixels`);
  handle.setAttribute('aria-disabled', String(fullWidth));
  byId('chat-panel').style.setProperty('--chat-width', `${width}px`);
}
function setChatWidth(value, persist = true) {
  const {minimum, maximum, fullWidth} = chatWidthLimits();
  if (fullWidth) return;
  preferredChatWidth = Math.max(minimum, Math.min(maximum, Math.round(value / 10) * 10));
  if (persist) GraphAppearance.save('chat-width', preferredChatWidth);
  updateChatWidth();
}
function resetChatWidth() {
  finishChatResize();
  preferredChatWidth = 500; GraphAppearance.save('chat-width', 500); updateChatWidth();
}
function finishChatResize(cancelled = false) {
  if (!chatResize) return;
  const resize = chatResize;
  chatResize = null;
  if (cancelled) preferredChatWidth = resize.preferredWidth;
  GraphAppearance.save('chat-width', preferredChatWidth);
  document.body.classList.remove('resizing-chat');
  const handle = byId('chat-resizer');
  if (handle.hasPointerCapture(resize.pointerId)) handle.releasePointerCapture(resize.pointerId);
  updateChatWidth();
}
byId('chat-width').addEventListener('input', () => setChatWidth(Number(byId('chat-width').value)));
byId('chat-width-reset').addEventListener('click', resetChatWidth);
byId('chat-resizer').addEventListener('pointerdown', event => {
  if (event.button !== 0 || chatResize || chatWidthLimits().fullWidth) return;
  const handle = byId('chat-resizer');
  byId('chat-panel').getAnimations().forEach(animation => animation.finish());
  chatResize = {pointerId: event.pointerId, startX: event.clientX, startWidth: byId('chat-panel').getBoundingClientRect().width, preferredWidth: preferredChatWidth};
  handle.setPointerCapture(event.pointerId);
  handle.focus({preventScroll: true});
  document.body.classList.add('resizing-chat');
  event.preventDefault();
});
byId('chat-resizer').addEventListener('pointermove', event => {
  if (chatResize?.pointerId === event.pointerId) setChatWidth(chatResize.startWidth + chatResize.startX - event.clientX, false);
});
byId('chat-resizer').addEventListener('pointerup', event => { if (chatResize?.pointerId === event.pointerId) finishChatResize(); });
byId('chat-resizer').addEventListener('pointercancel', event => { if (chatResize?.pointerId === event.pointerId) finishChatResize(true); });
byId('chat-resizer').addEventListener('lostpointercapture', () => finishChatResize());
byId('chat-resizer').addEventListener('dblclick', resetChatWidth);
byId('chat-resizer').addEventListener('keydown', event => {
  if (event.key === 'Escape' && chatResize) {
    finishChatResize(true); event.preventDefault(); event.stopPropagation(); return;
  }
  if (chatResize || event.altKey || event.ctrlKey || event.metaKey) return;
  const {minimum, maximum} = chatWidthLimits();
  const width = Number(byId('chat-width').value);
  const step = event.shiftKey ? 50 : 10;
  const values = {ArrowLeft: width + step, ArrowRight: width - step, Home: minimum, End: maximum};
  if (Object.hasOwn(values, event.key)) {
    event.preventDefault(); event.stopPropagation(); setChatWidth(values[event.key]);
  }
});
window.addEventListener('blur', () => finishChatResize());
window.addEventListener('resize', () => { finishChatResize(true); updateChatWidth(); });
const chatWidthObserver = new ResizeObserver(updateChatWidth);
chatWidthObserver.observe(document.querySelector('.sidebar'));
updateChatWidth();

function chatControls() {
  const busy = Boolean(chatState.active);
  byId('chat-send').disabled = busy || !chatState.ready || chatState.turnsRemaining <= 0;
  byId('chat-stop').hidden = !busy;
  byId('chat-stop').disabled = Boolean(chatState.active?.stopping);
  byId('chat-clear').disabled = busy;
  byId('chat-input').disabled = busy;
  byId('chat-api-key').disabled = busy;
  byId('chat-key-use').disabled = busy || !byId('chat-api-key').value.trim();
  byId('chat-key-clear').disabled = busy || !chatApiKey;
  launchChat.setAttribute('aria-busy', String(busy));
}
async function checkChatSetup() {
  if (!GraphWorkspace.graphId) return;
  const version = ++chatSetupVersion;
  chatState.ready = false;
  chatControls();
  try {
    const response = await GraphWorkspace.fetch('/api/chat/status');
    if (!response.ok) throw new Error('Restart the updated Graph Studio server.');
    const status = await response.json();
    if (version !== chatSetupVersion) return;
    chatState.ready = chatApiKey ? (status.runtime_ready ?? status.ready) : status.ready;
    chatState.token = status.token;
    byId('chat-setup').hidden = chatState.ready;
    byId('chat-setup-text').textContent = (chatApiKey ? (status.runtime_issues ?? status.issues) : status.issues).join('\n\n');
    byId('chat-key-source').textContent = chatApiKey ? 'This tab' : status.key_configured ? 'Server environment' : 'Not configured';
    if (!chatApiKey && !status.key_configured && !status.ready) byId('chat-key-settings').open = true;
    if (!chatState.active) byId('chat-status').textContent = chatState.ready ? 'Ready · GraphQuery tools enabled' : 'Chat setup required';
  } catch (error) {
    if (version !== chatSetupVersion) return;
    chatState.ready = false;
    byId('chat-setup').hidden = false;
    byId('chat-setup-text').textContent = error.message;
    byId('chat-status').textContent = 'Cannot connect to chat';
  }
  chatControls();
}
byId('chat-api-key').addEventListener('input', () => {
  byId('chat-key-feedback').textContent = '';
  chatControls();
});
byId('chat-key-use').addEventListener('click', () => {
  if (chatState.active) return;
  const value = byId('chat-api-key').value.trim();
  if (!/^[\x21-\x7E]{1,1024}$/.test(value)) {
    byId('chat-key-feedback').textContent = 'Enter a key without spaces or control characters (up to 1,024 characters).';
    return;
  }
  chatApiKey = value;
  byId('chat-api-key').value = '';
  byId('chat-key-source').textContent = 'This tab';
  byId('chat-key-feedback').textContent = 'Key set for this tab. OpenAI verifies it when you send a message.';
  checkChatSetup();
});
byId('chat-key-clear').addEventListener('click', () => {
  if (chatState.active) return;
  chatApiKey = null;
  byId('chat-api-key').value = '';
  byId('chat-key-feedback').textContent = 'Tab key cleared. The server key is used if configured.';
  checkChatSetup();
});
byId('chat-api-key').addEventListener('keydown', event => {
  if (event.key === 'Enter') { event.preventDefault(); byId('chat-key-use').click(); }
});
function followChat(update) {
  const scroll = byId('chat-scroll');
  const nearBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 90;
  update();
  if (nearBottom) scroll.scrollTop = scroll.scrollHeight;
}
function chatTrace(parent, label) {
  const details = createElement('details', 'chat-trace');
  const summary = createElement('summary', '', label);
  const content = createElement('pre');
  details.append(summary, content); parent.append(details);
  return {details, summary, content};
}
function chatSourceButton(node, parent) {
  const button = createElement('button', 'chat-source', `Source · ${shortLabel(node.label, 32)}`);
  button.type = 'button';
  button.title = node.id;
  button.setAttribute('aria-label', `Read source: ${node.label}`);
  button.addEventListener('click', () => {
    selectNode(node.id, {openDetails: false});
    let preview = parent.querySelector(':scope > .chat-source-preview');
    if (!preview) {
      preview = createElement('section', 'chat-source-preview');
      preview.tabIndex = -1;
      preview.setAttribute('aria-label', 'Citation source');
      parent.append(preview);
    }
    const heading = createElement('div', 'chat-source-heading');
    const close = createElement('button', '', 'Dismiss');
    close.type = 'button';
    close.setAttribute('aria-label', 'Dismiss source preview');
    close.addEventListener('click', () => { preview.remove(); if (button.isConnected) button.focus(); });
    heading.append(createElement('strong', '', node.label), close);
    preview.replaceChildren(heading, createElement('p', 'chat-note', `${node.type} · ${node.id}`),
      createElement('p', 'chat-source-text', String(node.properties?.text || 'This node has no source passage text.')));
    preview.focus({preventScroll: true});
    preview.scrollIntoView({block: 'nearest'});
  });
  return button;
}
function sourceLinks(element, parent) {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  while (walker.nextNode()) {
    if (!walker.currentNode.parentElement.closest('pre, code, a, button')) textNodes.push(walker.currentNode);
  }
  for (const textNode of textNodes) {
    const text = textNode.textContent;
    const pieces = [];
    let offset = 0;
    for (const match of text.matchAll(/\[node:([^\]\n]+)\]/g)) {
      pieces.push(document.createTextNode(text.slice(offset, match.index)));
      const node = state.nodeById.get(match[1]);
      pieces.push(node ? chatSourceButton(node, parent) : document.createTextNode(match[0]));
      offset = match.index + match[0].length;
    }
    if (offset) textNode.replaceWith(...pieces, document.createTextNode(text.slice(offset)));
  }
}
function renderChatAnswer(model) {
  model.answer.innerHTML = renderChatMarkdown(model.markdown);
  sourceLinks(model.answer, model.card);
}
function scheduleChatAnswer(model) {
  if (model.frame) return;
  model.frame = requestAnimationFrame(() => {
    model.frame = null;
    followChat(() => renderChatAnswer(model));
  });
}
function finishChatAnswer(model) {
  cancelAnimationFrame(model.frame);
  model.frame = null;
  renderChatAnswer(model);
}
function chatValue(value, parent, depth = 0) {
  if (value === null || value === undefined) return createElement('span', 'chat-null', 'null');
  if (typeof value !== 'object') {
    const node = typeof value === 'string' && state.nodeById.get(value);
    return node ? chatSourceButton(node, parent) : createElement('span', '', String(value));
  }
  if (value.$type === 'node' && state.nodeById.has(value.id)) return chatSourceButton(state.nodeById.get(value.id), parent);
  if (depth >= 3) return createElement('pre', '', JSON.stringify(value, null, 2));
  if (Array.isArray(value)) {
    if (!value.length) return createElement('span', 'chat-null', 'Empty list');
    const list = createElement('ul', 'chat-values');
    for (const item of value) {
      const entry = createElement('li'); entry.append(chatValue(item, parent, depth + 1)); list.append(entry);
    }
    return list;
  }
  const entries = Object.entries(value);
  if (!entries.length) return createElement('span', 'chat-null', 'None');
  const list = createElement('dl', 'chat-fields');
  for (const [key, item] of entries) {
    const content = createElement('dd'); content.append(chatValue(item, parent, depth + 1));
    list.append(createElement('dt', '', key), content);
  }
  return list;
}
function chatResultTable(parent, result) {
  const rows = (result.rows || []).filter(Array.isArray);
  const columns = Array.isArray(result.columns) ? result.columns : [];
  if (!rows.length) { parent.append(createElement('p', 'chat-note', 'No matches for this query.')); return; }
  const wrapper = createElement('div', 'chat-table-wrap');
  wrapper.tabIndex = 0; wrapper.setAttribute('role', 'region'); wrapper.setAttribute('aria-label', 'Query result table');
  const table = createElement('table');
  const header = createElement('tr');
  for (const column of columns) { const cell = createElement('th', '', String(column)); cell.scope = 'col'; header.append(cell); }
  const head = createElement('thead'); head.append(header);
  const body = createElement('tbody'); table.append(head, body); wrapper.append(table); parent.append(wrapper);
  const paging = createElement('div', 'chat-table-paging');
  const label = createElement('span'); label.setAttribute('aria-live', 'polite');
  const previous = createElement('button', '', 'Previous'); previous.type = 'button';
  const next = createElement('button', '', 'Next'); next.type = 'button';
  let offset = 0;
  function render() {
    body.replaceChildren();
    for (const row of rows.slice(offset, offset + 8)) {
      const rowElement = createElement('tr');
      for (const value of row) { const cell = createElement('td'); cell.append(chatValue(value, parent)); rowElement.append(cell); }
      body.append(rowElement);
    }
    label.textContent = `Rows ${offset + 1}–${Math.min(offset + 8, rows.length)} of ${rows.length} returned`;
    previous.disabled = offset === 0; next.disabled = offset + 8 >= rows.length;
  }
  previous.addEventListener('click', () => { offset -= 8; render(); });
  next.addEventListener('click', () => { offset += 8; render(); });
  paging.append(label);
  if (rows.length > 8) paging.append(previous, next);
  parent.append(paging); render();
}
function chatToolLabel(name) {
  return {get_graph_schema: 'Graph schema', run_graph_query: 'Graph query', read_graph_node: 'Read source'}[name] || name;
}
function setChatToolStatus(trace, status, label) {
  trace.details.dataset.status = status;
  trace.status.textContent = label;
}
function chatToolCard(parent, data) {
  const details = createElement('details', 'chat-trace chat-tool'); details.open = true;
  const summary = createElement('summary');
  const status = createElement('span', 'chat-tool-status');
  summary.append(createElement('strong', '', chatToolLabel(data.name)), status);
  const output = createElement('div', 'chat-tool-output');
  output.append(createElement('p', 'chat-note', 'Waiting for tool output…'));
  const diagnostics = createElement('div');
  const input = chatTrace(diagnostics, `Input · ${data.name}`);
  input.content.textContent = JSON.stringify(data.input, null, 2);
  details.append(summary, output, diagnostics); parent.append(details);
  const trace = {details, summary, status, output, diagnostics, name: data.name};
  setChatToolStatus(trace, 'running', 'Running');
  return trace;
}
function renderChatTool(trace, data, failed) {
  const output = data.output ?? {message: data.message};
  trace.output.replaceChildren();
  if (failed) {
    const error = typeof output.error === 'string' ? {message: output.error} : output.error || output;
    const card = createElement('div', 'chat-tool-error');
    card.append(createElement('strong', '', 'Tool could not complete'), createElement('p', '', error.message || data.message || 'Unknown tool error'));
    const location = [error.code, error.line != null ? `Line ${error.line}` : '', error.column != null ? `Column ${error.column}` : ''].filter(Boolean);
    if (location.length) card.append(createElement('p', 'chat-note', location.join(' · ')));
    trace.output.append(card);
  } else if (trace.queryData) {
    chatQueryCard(trace.output, trace.queryData);
  } else if (trace.name === 'get_graph_schema' && output.node_types) {
    for (const [label, counts] of [['Node types', output.node_types], ['Relationship types', output.relationship_types]]) {
      trace.output.append(createElement('h4', '', label));
      const grid = createElement('div', 'chat-schema-counts');
      for (const [name, count] of Object.entries(counts || {})) {
        if (name === '_preview') continue;
        const item = createElement('div'); item.append(createElement('span', '', name), createElement('strong', '', String(count))); grid.append(item);
      }
      trace.output.append(grid);
    }
    for (const [label, value] of [['Properties', output.properties], ['Stored directions', output.directions]]) {
      if (!value) continue;
      const section = createElement('details', 'chat-tool-section');
      section.append(createElement('summary', '', label), chatValue(value, trace.output)); trace.output.append(section);
    }
  } else if (trace.name === 'run_graph_query' && Array.isArray(output.rows)) {
    trace.output.append(createElement('h4', '', 'Result preview'));
    chatResultTable(trace.output, output);
    if (output.truncated || output.preview_notice) trace.output.append(createElement('p', 'chat-note', output.preview_notice || 'Result truncated.'));
  } else if (trace.name === 'read_graph_node' && output.id) {
    trace.output.append(createElement('h4', '', output.label || output.id), createElement('p', 'chat-note', `${output.type || 'Node'} · ${output.id}`));
    if (state.nodeById.has(output.id)) trace.output.append(chatSourceButton(state.nodeById.get(output.id), trace.output));
    trace.output.append(createElement('blockquote', 'chat-source-text', output.text || 'No source text available.'));
    if (output.truncated) trace.output.append(createElement('p', 'chat-note', 'Source excerpt truncated. Open the source to read the local passage.'));
  } else trace.output.append(chatValue(output, trace.output));
  if (!failed && !trace.queryData) trace.output.append(createElement('p', 'chat-note', 'Tool preview · long values and lists may be abbreviated.'));
  const raw = chatTrace(trace.diagnostics, 'Raw output · diagnostics');
  raw.content.textContent = JSON.stringify(output, null, 2);
}
function chatQueryCard(parent, data) {
  const result = data.result;
  const card = createElement('div', 'chat-query');
  card.append(createElement('strong', '', `${result.rows.length} result row${result.rows.length === 1 ? '' : 's'} · ${result.stats.elapsed_ms} ms`));
  card.append(createElement('pre', '', data.query));
  const params = chatTrace(card, 'Query parameters');
  params.content.textContent = JSON.stringify(data.parameters, null, 2);
  chatResultTable(card, result);
  const note = result.truncated ? `Output truncated from ${result.stats.total_rows} rows. Open the editor to paginate.` : result.rows.length ? `${result.graph.node_ids.length} supporting nodes · ${result.graph.edge_ids.length} relationships` : 'No matches for this query.';
  card.append(createElement('p', 'help-text', note));
  const actions = createElement('div', 'chat-query-actions');
  const graphButton = createElement('button', '', 'Show on graph');
  graphButton.disabled = !result.graph.node_ids.length;
  graphButton.addEventListener('click', () => { closeChat(); showQueryGraph(result.graph, result.rows.length); });
  const editorButton = createElement('button', '', 'Open query & results');
  editorButton.addEventListener('click', () => {
    resetQueryResults();
    byId('query-input').value = data.query;
    byId('query-params').value = JSON.stringify(data.parameters, null, 2);
    byId('query-parameters').open = Object.keys(data.parameters).length > 0;
    byId('query-examples').value = '';
    queryEditor.result = result; renderQueryRows();
    byId('show-query-graph').disabled = !result.graph.node_ids.length;
    byId('download-query').disabled = false;
    queryStatus(`${result.rows.length} rows from chat · ${result.stats.elapsed_ms} ms${result.truncated ? ' · Output truncated; use SKIP / LIMIT.' : ''}`);
    byId('query-dialog').showModal();
  });
  actions.append(graphButton, editorButton); card.append(actions); parent.append(card);
}
function chatEvent(run, kind, data) {
  if (chatState.active !== run) return;
  followChat(() => {
    if (kind === 'run_start') {
      run.runId = data.run_id; chatState.sessionId = data.session_id;
      byId('chat-status').textContent = 'Astra is searching…';
      if (run.stopping) cancelChatRun(run);
    } else if (kind === 'llm_start') {
      const card = createElement('div', 'chat-model');
      const label = createElement('div', 'chat-label', 'ASTRA');
      const phase = createElement('span', '', 'Generating'); label.append(phase);
      const answer = createElement('div', 'chat-answer'); card.append(label, answer); run.container.append(card);
      run.models.set(data.id, {card, answer, phase, markdown: '', frame: null, arguments: new Map()});
    } else if (kind === 'llm_delta') {
      const model = run.models.get(data.id);
      if (model) { model.markdown += data.text; scheduleChatAnswer(model); }
    } else if (kind === 'reasoning_delta') {
      const model = run.models.get(data.id);
      if (model) {
        model.reasoning ||= chatTrace(model.card, 'Reasoning summary · provided by OpenAI');
        model.reasoning.content.append(document.createTextNode(data.text));
      }
    } else if (kind === 'tool_argument_delta') {
      const model = run.models.get(data.id);
      if (model) {
        model.argumentTrace ||= chatTrace(model.card, 'Tool arguments · streaming');
        const chunk = data.chunk;
        const key = chunk.index ?? chunk.id ?? 0;
        const call = model.arguments.get(key) || {name: '', args: ''};
        if (chunk.name) call.name = chunk.name;
        if (typeof chunk.args === 'string') call.args += chunk.args;
        model.arguments.set(key, call);
        model.argumentTrace.content.textContent = [...model.arguments.values()].map(item => `${item.name}\n${item.args}`).join('\n\n');
      }
    } else if (kind === 'llm_end') {
      const model = run.models.get(data.id);
      if (model) {
        model.phase.textContent = data.usage.total_tokens ? `${data.usage.total_tokens} tokens` : 'Complete';
        if (model.argumentTrace) model.argumentTrace.summary.textContent = 'Tool arguments · Complete';
        finishChatAnswer(model);
      }
    } else if (kind === 'llm_error') {
      const model = run.models.get(data.id);
      if (model) { model.phase.textContent = 'Failed'; model.card.append(createElement('div', 'chat-trace chat-run-error', data.message)); }
    } else if (kind === 'tool_start') {
      const trace = chatToolCard(run.container, data);
      run.tools.set(data.id, trace);
      byId('chat-status').textContent = `Tool: ${data.name}`;
    } else if (kind === 'tool_delta') {
      const trace = run.tools.get(data.id);
      if (trace) {
        trace.progress ||= chatTrace(trace.diagnostics, 'Progress events');
        trace.progress.content.append(document.createTextNode('\n' + JSON.stringify(data.data)));
        trace.output.replaceChildren(createElement('h4', '', 'Progress'), chatValue(data.data, trace.output));
      }
    } else if (kind === 'tool_end' || kind === 'tool_error') {
      const trace = run.tools.get(data.id);
      if (trace) {
        const failed = kind === 'tool_error' || data.output?.ok === false;
        setChatToolStatus(trace, failed ? 'error' : 'complete', failed ? 'Failed' : 'Complete');
        renderChatTool(trace, data, failed);
      }
    } else if (kind === 'query_result') {
      const trace = run.tools.get(data.id);
      if (trace) {
        trace.queryData = data;
        trace.output.replaceChildren(); chatQueryCard(trace.output, data);
      } else chatQueryCard(run.container, data);
    } else if (kind === 'agent_state') {
      run.container.dataset.messageCount = String(data.message_count);
    } else if (kind === 'run_end') {
      run.terminal = true;
      chatState.turnsRemaining = data.turns_remaining;
      byId('chat-status').textContent = data.turns_remaining ? `Complete · ${data.tool_calls} tool call${data.tool_calls === 1 ? '' : 's'}` : 'Start a new chat to continue';
    } else if (kind === 'run_error' || kind === 'run_cancelled') {
      run.terminal = true;
      run.container.append(createElement('div', 'chat-trace chat-run-error', data.message));
      byId('chat-status').textContent = kind === 'run_cancelled' ? 'Stopped' : 'Request failed';
    }
  });
}

async function readChatEvents(response, onEvent) {
  if (!response.body) throw new Error('Streaming is unavailable in this browser.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  function drain() {
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
      let kind = 'message'; const data = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) kind = line.slice(6).trim();
        if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      if (data.length) onEvent(kind, JSON.parse(data.join('\n')));
    }
  }
  try {
    while (true) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, {stream: !chunk.done});
      drain();
      if (buffer.length > 1024 * 1024) throw new Error('Chat event exceeded the size limit.');
      if (chunk.done) break;
    }
    if (buffer.trim()) throw new Error('The chat stream ended with an incomplete event.');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function sendChat(event) {
  event.preventDefault();
  const message = byId('chat-input').value.trim();
  if (!message || !chatState.ready || chatState.active || chatState.turnsRemaining <= 0) return;
  const container = createElement('article', 'chat-turn');
  container.append(createElement('p', 'chat-user', message));
  byId('chat-welcome').hidden = true; byId('chat-messages').append(container);
  const run = {container, controller: new AbortController(), models: new Map(), tools: new Map(), terminal: false, stopping: false};
  chatState.active = run;
  byId('chat-input').value = ''; byId('chat-status').textContent = 'Connecting to Astra…';
  chatControls(); byId('chat-scroll').scrollTop = byId('chat-scroll').scrollHeight;
  try {
    const response = await GraphWorkspace.fetch('/api/chat', {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Chat-Token': chatState.token},
      body: JSON.stringify({message, session_id: chatState.sessionId, ...(chatApiKey ? {api_key: chatApiKey} : {})}), signal: run.controller.signal});
    if (!response.ok) {
      const payload = await response.json();
      if (['SESSION_EXPIRED', 'SESSION_LIMIT'].includes(payload.error?.code)) chatState.turnsRemaining = 0;
      throw new Error(payload.error?.message || `Chat failed (${response.status}).`);
    }
    await readChatEvents(response, (kind, data) => chatEvent(run, kind, data));
    if (!run.terminal) throw new Error('The connection ended before a final response. Try again.');
  } catch (error) {
    const message = error.name === 'AbortError' ? 'Stopped locally. The server cancels the run when it detects the disconnected stream.' : error.message;
    container.append(createElement('div', 'chat-trace chat-run-error', message));
    byId('chat-status').textContent = run.stopping ? 'Stopped' : 'Request failed';
  } finally {
    clearTimeout(run.stopTimer);
    for (const model of run.models.values()) {
      finishChatAnswer(model);
      if (model.phase.textContent === 'Generating') model.phase.textContent = 'Interrupted';
    }
    for (const tool of run.tools.values()) if (tool.details.dataset.status === 'running') {
      setChatToolStatus(tool, 'error', 'Interrupted');
      tool.output.prepend(createElement('p', 'chat-note', 'No completed result was received.'));
    }
    if (chatState.active === run) chatState.active = null;
    chatControls();
    if (!byId('chat-panel').hidden) byId('chat-input').focus();
  }
}
async function cancelChatRun(run) {
  if (!run.runId || run.cancelSent) return;
  run.cancelSent = true;
  try {
    await GraphWorkspace.fetch('/api/chat/cancel', {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Chat-Token': chatState.token}, body: JSON.stringify({run_id: run.runId})});
  } catch { run.controller.abort(); }
}
launchChat.addEventListener('click', () => {
  if (!byId('chat-panel').hidden) { closeChat(); return; }
  byId('chat-panel').hidden = false; document.body.classList.add('chat-open');
  if (innerWidth <= 760) document.body.classList.remove('sidebar-open', 'inspector-open');
  launchChat.setAttribute('aria-expanded', 'true');
  checkChatSetup(); byId('chat-input').focus();
});
byId('chat-close').addEventListener('click', () => { closeChat(); launchChat.focus(); });
byId('chat-refresh').addEventListener('click', checkChatSetup);
byId('chat-form').addEventListener('submit', sendChat);
byId('chat-panel').addEventListener('keydown', event => {
  if (event.key === 'Escape') { closeChat(); launchChat.focus(); event.stopPropagation(); }
});
byId('chat-input').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); byId('chat-form').requestSubmit(); }
});
document.querySelectorAll('[data-chat-suggestion]').forEach(button => button.addEventListener('click', () => {
  if (!chatState.active) { byId('chat-input').value = button.dataset.chatSuggestion; byId('chat-input').focus(); }
}));
byId('chat-stop').addEventListener('click', () => {
  const run = chatState.active;
  if (!run || run.stopping) return;
  run.stopping = true; byId('chat-status').textContent = 'Stopping…'; chatControls();
  cancelChatRun(run);
  run.stopTimer = setTimeout(() => run.controller.abort(), 5000);
});
byId('chat-clear').addEventListener('click', async () => {
  if (chatState.active) return;
  if (chatState.sessionId) {
    try {
      const response = await GraphWorkspace.fetch('/api/chat/reset', {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Chat-Token': chatState.token}, body: JSON.stringify({session_id: chatState.sessionId})});
      if (!response.ok) throw new Error('Unable to clear the server conversation. Reload and try again.');
    } catch (error) { toast(error.message); return; }
  }
  chatState.sessionId = null; chatState.turnsRemaining = 6;
  byId('chat-messages').replaceChildren(); byId('chat-welcome').hidden = false;
  byId('chat-input').value = ''; checkChatSetup();
});
