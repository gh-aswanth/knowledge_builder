async (page) => {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const baseURL = page.url().split('/').slice(0, 3).join('/');
  const errors = [];
  const onError = error => errors.push(error.message);
  page.on('pageerror', onError);
  const documentBytes = await page.evaluate(() => {
  const xml = new TextEncoder().encode('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Alpha manages Beta security.</w:t></w:r></w:p></w:body></w:document>');
  const filename = new TextEncoder().encode('word/document.xml');
  let checksum = 0xffffffff;
  for (const byte of xml) {
    checksum ^= byte;
    for (let bit = 0; bit < 8; bit++) checksum = (checksum >>> 1) ^ (checksum & 1 ? 0xedb88320 : 0);
  }
  checksum = (checksum ^ 0xffffffff) >>> 0;
  const local = new DataView(new ArrayBuffer(30));
  local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint32(14, checksum, true);
  local.setUint32(18, xml.length, true); local.setUint32(22, xml.length, true); local.setUint16(26, filename.length, true);
  const central = new DataView(new ArrayBuffer(46));
  central.setUint32(0, 0x02014b50, true); central.setUint16(4, 20, true); central.setUint16(6, 20, true);
  central.setUint32(16, checksum, true); central.setUint32(20, xml.length, true); central.setUint32(24, xml.length, true); central.setUint16(28, filename.length, true);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, 1, true); end.setUint16(10, 1, true);
  end.setUint32(12, central.byteLength + filename.length, true); end.setUint32(16, local.byteLength + filename.length + xml.length, true);
  return [...new Uint8Array(local.buffer), ...filename, ...xml, ...new Uint8Array(central.buffer), ...filename, ...new Uint8Array(end.buffer)];
  });
  async function chooseUpload(name, content) {
    await page.locator('#upload-file').evaluate((input, {name, content}) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([Array.isArray(content) ? new Uint8Array(content) : content], name));
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', {bubbles: true}));
    }, {name, content});
  }
  const statusRoute = '**/api/graphs/*/chat/status';
  let interceptNextStatus = null;
  const statusHandler = route => {
    if (interceptNextStatus) {
      const resolve = interceptNextStatus; interceptNextStatus = null; resolve(route); return;
    }
    return route.fulfill({json: {ready: true, token: 'test-only', issues: []}});
  };
  await page.route(statusRoute, statusHandler);
  try {
    for (const width of [1440, 390]) {
      await page.setViewportSize({width, height: 900});
      await page.goto(baseURL);
      await page.waitForFunction(() => byId('workspace-status').textContent.includes('first document'));
      check(await page.locator('#workspace-empty').isVisible(), 'Empty workspace missing');
      check(await page.locator('#open-chat').isDisabled(), 'Chat should require a document');
      await page.locator('#empty-upload').click();
      await chooseUpload('First.docx', documentBytes);
      const created = page.waitForResponse(response => response.url().endsWith('/api/documents') && response.status() === 201);
      await page.locator('#upload-submit').click();
      const result = await (await created).json();
      await page.waitForFunction(identifier => GraphWorkspace.graphId === identifier, result.graph_id);
      check(await page.locator('#workspace-empty').isHidden(), 'Empty state obscures graph');
      check(await page.evaluate(() => state.nodes.length > 3 && state.edges.length > 0), 'Graph was not rendered');
      check((await page.request.get(baseURL + result.download_url)).status() === 200, 'Download failed');
      check(await page.locator('#document-name').textContent() === 'First.docx', 'Source filename incorrect');
      check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `Page overflows at ${width}px`);
      await page.locator('#open-query').click();
      await page.locator('#query-input').fill('MATCH (passage:Passage) RETURN passage.text');
      await page.locator('#run-query').click();
      await page.waitForFunction(() => queryEditor.result !== null);
      check((await page.locator('#query-rows').textContent()).includes('Alpha manages Beta'), 'Query used wrong graph');
      await page.locator('#close-query').click();
      await page.locator('#open-chat').click();
      await page.waitForFunction(() => chatState.ready);
      await page.evaluate(() => {
        chatState.sessionId = 'old-session';
        byId('chat-messages').append(createElement('div', 'chat-turn', 'Old conversation'));
      });
      const staleResponse = new Promise(resolve => { interceptNextStatus = resolve; });
      await page.evaluate(() => { window.pendingSetupTest = checkChatSetup(); });
      const stale = await staleResponse;
      const second = {...result.graph, metadata: {...result.graph.metadata, source: 'Second.docx'}};
      second.nodes = second.nodes.map(node => ({...node, label: node.type === 'Document' ? 'Second' : node.label}));
      await page.locator('#open-upload').click();
      await chooseUpload('Second.json', JSON.stringify(second));
      await page.locator('#upload-submit').click();
      await page.waitForFunction(previous => GraphWorkspace.graphId !== previous, result.graph_id);
      await page.waitForFunction(() => chatState.ready);
      await stale.fulfill({json: {ready: false, token: 'obsolete', issues: ['Old document']}});
      await page.evaluate(() => window.pendingSetupTest);
      check(await page.evaluate(() => chatState.ready && chatState.token === 'test-only'), 'Old setup response replaced the new document token');
      check(await page.evaluate(() => !chatState.sessionId && !queryEditor.result && byId('chat-messages').children.length === 0), 'Old conversation or query leaked into new document');
      check(await page.locator('#document-name').textContent() === 'Second.docx', 'Document replacement failed');
      const secondURL = page.url();
      await page.locator('#open-upload').click();
      await chooseUpload('broken.docx', 'not a document');
      await page.locator('#upload-submit').click();
      await page.locator('#upload-error').waitFor({state: 'visible'});
      check(page.url() === secondURL, 'Failed upload changed active document');
      await page.locator('#upload-cancel').click();
      await page.reload();
      await page.waitForFunction(() => state.initialized);
      check(await page.locator('#document-name').textContent() === 'Second.docx', 'Refresh did not restore saved graph');
    }
    check(!errors.length, `Browser errors: ${errors.join('; ')}`);
    return '1440px / 390px: empty state, DOCX upload, JSON download/import, query, document isolation, failed upload and refresh passed';
  } finally {
    await page.unroute(statusRoute, statusHandler);
    page.off('pageerror', onError);
  }
}
