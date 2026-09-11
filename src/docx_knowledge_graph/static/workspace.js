'use strict';

window.GraphWorkspace = (() => {
  let graphId = null;
  let token = null;
  let bootstrap = null;
  let maxUploadBytes = 20 * 1024 * 1024;
  let selectedFile = null;
  let upload = null;
  let documentVersion = 0;
  const element = identifier => document.getElementById(identifier);

  async function setup() {
    if (!bootstrap) bootstrap = fetch('/api/workspace').then(async response => {
      if (!response.ok) throw new Error('Cannot connect to the FastAPI server. Refresh and try again.');
      const settings = await response.json();
      token = settings.token; maxUploadBytes = settings.max_upload_bytes;
      element('upload-limit').textContent = `Up to ${Math.floor(maxUploadBytes / 1024 / 1024)} MiB · local conversion`;
      return settings;
    }).catch(error => { bootstrap = null; throw error; });
    return bootstrap;
  }
  function api(path, identifier = graphId) {
    if (path === '/api/documents' || path === '/api/workspace') return path;
    if (!identifier) throw new Error('Upload a document before using graph tools.');
    const base = `/api/graphs/${encodeURIComponent(identifier)}`;
    return path === '/api/graph' ? base : base + path.slice('/api'.length);
  }
  async function request(path, options = {}) {
    const identifier = graphId;
    await setup();
    const headers = new Headers(options.headers);
    if (options.method && options.method.toUpperCase() !== 'GET') headers.set('X-Workspace-Token', token);
    return fetch(api(path, identifier), {...options, headers});
  }
  function syncControls() {
    for (const identifier of ['open-chat', 'open-query', 'export-image']) element(identifier).disabled = !graphId;
    for (const button of document.querySelectorAll('.rail [data-panel]')) button.disabled = !graphId;
    element('download-graph').setAttribute('aria-disabled', String(!graphId));
    element('download-graph').tabIndex = graphId ? 0 : -1;
    element('open-upload').disabled = Boolean(upload);
    element('choose-upload').disabled = Boolean(upload);
    element('upload-submit').disabled = !selectedFile || Boolean(upload);
    element('upload-progress').hidden = !upload;
    element('upload-dialog').setAttribute('aria-busy', String(Boolean(upload)));
  }
  function showError(message) {
    element('upload-error').hidden = !message;
    element('upload-error').textContent = message;
  }
  function applyDocument(identifier, graph) {
    if (window.GraphChat?.isBusy()) throw new Error('Stop the current chat before switching documents.');
    if (!/^[a-f0-9]{32}$/.test(identifier) || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) throw new Error('The server returned an invalid graph.');
    document.body.classList.remove('no-graph');
    GraphViewer.load(graph);
    documentVersion++;
    graphId = identifier;
    GraphChat.resetForGraph();
    element('workspace-empty').hidden = true;
    element('download-graph').href = `${api('/api/graph')}/download`;
    const url = new URL(location.href); url.searchParams.set('graph', identifier);
    history.replaceState({graphId: identifier}, '', url);
    syncControls();
  }
  function openUpload() {
    if (window.GraphChat?.isBusy()) { toast('Stop the current chat before uploading another document.'); return; }
    if (upload) return;
    showError('');
    element('upload-dialog').showModal();
  }
  function chooseFile(file) {
    if (!file || upload) return;
    selectedFile = null;
    showError('');
    if (!/\.(docx|json)$/i.test(file.name)) showError('Choose a DOCX document or an exported graph JSON.');
    else if (!file.size) showError('The selected file is empty.');
    else if (file.size > maxUploadBytes) showError(`File exceeds the ${Math.floor(maxUploadBytes / 1024 / 1024)} MiB upload limit.`);
    else selectedFile = file;
    element('upload-selected').textContent = selectedFile ? `${file.name} · ${(file.size / 1024).toFixed(1)} KiB` : 'No file selected';
    element('upload-submit').textContent = selectedFile?.name.toLowerCase().endsWith('.json') ? 'Open graph' : 'Create graph';
    syncControls();
  }
  function closeUpload() {
    if (upload) upload.abort();
    element('upload-dialog').close();
  }
  async function submitUpload() {
    if (!selectedFile || upload) return;
    if (GraphChat.isBusy()) { showError('Stop the current chat before switching documents.'); return; }
    upload = new AbortController();
    syncControls(); showError('');
    const form = new FormData(); form.append('file', selectedFile);
    try {
      const response = await request('/api/documents', {method: 'POST', body: form, signal: upload.signal});
      const result = await response.json();
      if (!response.ok) throw new Error(result.error?.message || `Upload failed (${response.status}).`);
      applyDocument(result.graph_id, result.graph);
      element('upload-dialog').close();
      selectedFile = null; element('upload-file').value = ''; element('upload-selected').textContent = 'No file selected';
      toast(`Graph ready · ${result.graph.nodes.length} nodes · ${result.graph.edges.length} relationships. Download JSON from Export.`);
    } catch (error) {
      if (error.name !== 'AbortError') showError(error.message || 'Upload failed. Your current graph has not changed.');
    } finally {
      upload = null; syncControls();
    }
  }
  async function initialize() {
    const version = documentVersion;
    syncControls();
    try {
      const settings = await setup();
      const identifier = new URL(location.href).searchParams.get('graph') || settings.initial_graph_id;
      if (identifier) {
        const response = await fetch(`/api/graphs/${encodeURIComponent(identifier)}`);
        const result = await response.json();
        if (version !== documentVersion) return;
        if (!response.ok) throw new Error(result.error?.message || 'Unable to open this graph.');
        applyDocument(identifier, result);
      } else {
        element('document-name').textContent = 'Upload a document';
        element('workspace-status').textContent = 'Ready for your first document.';
        element('layout-status').textContent = 'Ready to upload';
      }
    } catch (error) {
      if (version !== documentVersion) return;
      element('workspace-status').textContent = error.message;
      element('layout-status').textContent = 'Upload a document to continue';
    }
  }
  document.addEventListener('DOMContentLoaded', () => {
    element('open-upload').addEventListener('click', openUpload);
    element('empty-upload').addEventListener('click', openUpload);
    element('choose-upload').addEventListener('click', () => element('upload-file').click());
    element('upload-file').addEventListener('change', event => chooseFile(event.target.files[0]));
    element('upload-submit').addEventListener('click', submitUpload);
    element('upload-close').addEventListener('click', closeUpload);
    element('upload-cancel').addEventListener('click', closeUpload);
    element('upload-dialog').addEventListener('cancel', event => { event.preventDefault(); closeUpload(); });
    element('download-graph').addEventListener('click', event => { if (!graphId) event.preventDefault(); });
    const dropzone = element('upload-dropzone');
    dropzone.addEventListener('dragover', event => { event.preventDefault(); if (!upload) dropzone.classList.add('drag-over'); });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));
    dropzone.addEventListener('drop', event => {
      event.preventDefault(); dropzone.classList.remove('drag-over');
      if (event.dataTransfer.files.length !== 1) { showError('Choose one document at a time.'); return; }
      chooseFile(event.dataTransfer.files[0]);
    });
    initialize();
  });
  return {get graphId() { return graphId; }, api, fetch: request};
})();
