async (page) => {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const baseURL = page.url();
  const statusRoute = '**/api/graphs/*/chat/status';
  const chatRoute = '**/api/graphs/*/chat';
  const errors = [];
  const onError = error => errors.push(error.message);
  page.on('pageerror', onError);
  let events = [];
  const mockStatus = route => route.fulfill({json: {ready: true, token: 'test-only', issues: []}});
  const mockChat = route => route.fulfill({contentType: 'text/event-stream', body: events.map(([kind, data]) => `event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`).join('')});
  await page.route(statusRoute, mockStatus);
  await page.route(chatRoute, mockChat);
  try {
    await page.goto(baseURL);
    await page.waitForFunction(() => state.initialized);
    const source = await page.evaluate(() => {
      const node = state.nodes.find(item => item.type === 'Passage');
      return {id: node.id, label: node.label, type: node.type, text: node.properties.text};
    });
    const result = {
      columns: ['source', 'rank', 'detail'],
      rows: Array.from({length: 9}, (_, index) => [source.id, index + 1, {matched: true, value: '<img src=x onerror=alert(1)>'}]),
      stats: {rows: 9, total_rows: 15, elapsed_ms: 1.2},
      truncated: true, graph: {node_ids: [source.id], edge_ids: []}
    };
    const markdown = `The graph identifies **three priorities**. [node:${source.id}]

## Key findings
- **Security:** Review the documented controls.
- **Operations:** Confirm accountable owners.

| Priority | Evidence |
| --- | --- |
| Security | [node:${source.id}] |

> This is evidence from an extracted graph, not independent verification.

### Query example
\`\`\`graphquery
MATCH (passage:Passage) RETURN passage LIMIT 3
[node:${source.id}]
\`\`\`

Inline code: \`[node:${source.id}]\`. Unknown: [node:not-a-real-node].

[Reference](https://example.com) [Unsafe](javascript:alert(1))
![No remote image](https://example.com/pixel)
<img src=x onerror=alert(1)>`;
    const completed = [
      ['run_start', {run_id: 'test-run', session_id: 'test-session'}],
      ['llm_start', {id: 'planning'}],
      ['reasoning_delta', {id: 'planning', text: 'Provider summary'}],
      ['tool_argument_delta', {id: 'planning', chunk: {index: 0, name: 'get_graph_schema', args: '{}'}}],
      ['llm_end', {id: 'planning', usage: {total_tokens: 5}}],
      ['tool_start', {id: 'schema', name: 'get_graph_schema', input: {}}],
      ['tool_start', {id: 'source', name: 'read_graph_node', input: {node_id: source.id}}],
      ['tool_delta', {id: 'schema', data: {stage: 'Inspecting types'}}],
      ['tool_end', {id: 'source', output: {ok: true, ...source, text: '<script>Source text is not markup</script>', truncated: true}}],
      ['tool_end', {id: 'schema', output: {language: 'GraphQuery/1', node_types: {Passage: 20, Concept: 30}, relationship_types: {MENTIONS: 50}, properties: {nodes: {Passage: ['text']}}, directions: [{source_type: 'Passage', relationship: 'MENTIONS', target_type: 'Concept', count: 50}]}}],
      ['tool_start', {id: 'failed', name: 'run_graph_query', input: {query: 'RETURN missing'}}],
      ['tool_error', {id: 'failed', output: {ok: false, error: {message: 'Unknown variable: missing', code: 'QUERY_ERROR', line: 1, column: 8}}}],
      ['tool_start', {id: 'missing', name: 'read_graph_node', input: {node_id: 'missing'}}],
      ['tool_error', {id: 'missing', output: {ok: false, error: 'No node has that ID.'}}],
      ['tool_start', {id: 'query', name: 'run_graph_query', input: {query: 'MATCH (passage:Passage) RETURN passage'}}],
      ['tool_end', {id: 'query', output: {ok: true, ...result, preview_notice: 'Rows may be abbreviated.'}}],
      ['query_result', {id: 'query', query: 'MATCH (passage:Passage) RETURN passage', parameters: {}, result}],
      ['llm_start', {id: 'answer'}],
      ...Array.from({length: Math.ceil(markdown.length / 17)}, (_, index) => ['llm_delta', {id: 'answer', text: markdown.slice(index * 17, (index + 1) * 17)}]),
      ['llm_end', {id: 'answer', usage: {total_tokens: 120}}],
      ['run_end', {turns_remaining: 5, tool_calls: 5}]
    ];
    const reports = [];
    for (const width of [1440, 390]) {
      await page.setViewportSize({width, height: 1000});
      await page.reload();
      await page.waitForFunction(() => state.initialized);
      events = completed;
      await page.locator('#open-chat').click();
      await page.waitForFunction(() => chatState.ready);
      await page.locator('#chat-input').fill('Summarize the key priorities and cite the evidence.');
      await page.locator('#chat-send').click();
      await page.waitForFunction(() => !chatState.active && byId('chat-status').textContent.startsWith('Complete'));
      check(await page.locator('.chat-answer h2').textContent() === 'Key findings', 'Markdown heading missing');
      check(await page.locator('.chat-answer strong').count() === 3, 'Markdown emphasis missing');
      check(await page.locator('.chat-answer .chat-source').count() === 2, 'Citations must skip code and preserve tables');
      check(await page.locator('.chat-answer pre .chat-source, .chat-answer code .chat-source').count() === 0, 'Code citations became interactive');
      check((await page.locator('.chat-answer').last().textContent()).includes('[node:not-a-real-node]'), 'Unknown citation disappeared');
      check(await page.locator('#chat-messages img, #chat-messages script, #chat-messages iframe').count() === 0, 'Untrusted markup became active');
      check(await page.locator('.chat-answer a').getAttribute('rel') === 'noopener noreferrer', 'External link protections missing');
      check(await page.locator('.chat-tool[data-status=complete]').count() === 3, 'Interleaved tool completion lost');
      check(await page.locator('.chat-tool[data-status=error]').count() === 2, 'Tool failures lost');
      check((await page.locator('.chat-tool-error').first().textContent()).includes('Column 8'), 'Structured error location missing');
      check((await page.locator('.chat-tool-error').last().textContent()).includes('No node has that ID.'), 'String error message lost');
      check(await page.locator('.chat-schema-counts').count() === 2, 'Schema not structured');
      check(await page.locator('.chat-query').count() === 1, 'Query artifact duplicated');
      check(await page.locator('.chat-query tbody tr').count() === 8, 'Inline table pagination missing');
      await page.locator('.chat-query').getByRole('button', {name: 'Next', exact: true}).click();
      check(await page.locator('.chat-query tbody tr').count() === 1, 'Next results page incorrect');
      await page.locator('.chat-query').getByRole('button', {name: 'Previous', exact: true}).click();
      check((await page.locator('.chat-query').textContent()).includes('truncated from 15'), 'Result truncation not disclosed');
      check(await page.locator('summary').filter({hasText: /^Raw output/}).first().evaluate(summary => !summary.parentElement.open), 'Raw output should be collapsed');
      await page.locator('.chat-answer .chat-source').first().click();
      check(await page.locator('#chat-panel').isVisible(), 'Citation closed chat');
      check(await page.locator('#open-chat').getAttribute('aria-expanded') === 'true', 'Chat toggle lost expanded state');
      check(await page.evaluate(identifier => state.selected === identifier, source.id), 'Citation failed to select graph node');
      check((await page.locator('.chat-model > .chat-source-preview .chat-source-text').textContent()) === source.text, 'Citation preview lost local evidence');
      await page.locator('.chat-answer .chat-source').last().click();
      check(await page.locator('.chat-model > .chat-source-preview').count() === 1, 'Citation previews duplicated');
      await page.getByRole('button', {name: 'Dismiss source preview'}).click();
      check(await page.locator('#chat-panel').isVisible(), 'Dismissing source closed chat');
      const layout = await page.evaluate(() => ({
        viewport: innerWidth,
        page: document.documentElement.scrollWidth,
        panel: byId('chat-panel').getBoundingClientRect().toJSON(),
        scrollWidth: byId('chat-scroll').scrollWidth,
        chatWidth: byId('chat-scroll').clientWidth
      }));
      check(layout.page <= layout.viewport + 1 && layout.scrollWidth <= layout.chatWidth + 1, `Horizontal overflow at ${width}px: ${JSON.stringify(layout)}`);
      check(layout.panel.right <= layout.viewport + 1 && layout.panel.left >= 0, 'Chat is outside viewport');
      await page.evaluate(identifier => selectNode(identifier), source.id);
      check(await page.locator('#chat-panel').isHidden(), 'Ordinary node selection should retain inspector behavior');
      reports.push(`${width}px: Markdown, citations, tools, errors, tables and layout passed`);
    }
    await page.locator('#open-chat').click();
    events = [
      ['run_start', {run_id: 'interrupted', session_id: 'test-session'}],
      ['llm_start', {id: 'partial'}],
      ['llm_delta', {id: 'partial', text: '**Partial response**\n\n```json\n{"unfinished":'}],
      ['tool_start', {id: 'pending', name: 'read_graph_node', input: {node_id: source.id}}],
      ['run_cancelled', {message: 'Stopped by user.'}]
    ];
    await page.locator('#chat-input').fill('Interrupted request');
    await page.locator('#chat-send').click();
    await page.waitForFunction(() => !chatState.active && byId('chat-status').textContent === 'Stopped');
    check((await page.locator('.chat-turn').last().textContent()).includes('Interrupted'), 'Interrupted lifecycle not shown');
    check(await page.locator('.chat-turn').last().locator('.chat-answer strong').textContent() === 'Partial response', 'Partial Markdown not flushed');
    const streamResult = await page.evaluate(async () => {
      const bytes = new TextEncoder().encode('event: llm_delta\ndata: {"text":"Résumé ✅"}\n\n');
      const stream = new ReadableStream({start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); }});
      const frames = [];
      await readChatEvents(new Response(stream), (kind, data) => frames.push({kind, data}));
      let incompleteRejected = false;
      try { await readChatEvents(new Response('event: llm_delta\ndata: {'), () => {}); } catch { incompleteRejected = true; }
      const container = createElement('article'); byId('chat-messages').append(container);
      const run = {container, models: new Map(), tools: new Map()}; chatState.active = run;
      chatEvent(run, 'llm_start', {id: 'live'});
      chatEvent(run, 'llm_delta', {id: 'live', text: '**Stream'});
      await new Promise(requestAnimationFrame);
      const partial = container.querySelector('.chat-answer').textContent;
      chatEvent(run, 'llm_delta', {id: 'live', text: 'ing**'});
      await new Promise(requestAnimationFrame);
      const formatted = container.querySelector('strong')?.textContent;
      chatEvent(run, 'llm_end', {id: 'live', usage: {}});
      chatState.active = null; container.remove();
      return {frames, incompleteRejected, partial, formatted};
    });
    check(streamResult.frames[0].data.text === 'Résumé ✅' && streamResult.incompleteRejected, 'SSE chunk handling regression');
    check(streamResult.partial.trim() === '**Stream' && streamResult.formatted === 'Streaming', `Live Markdown did not update: ${JSON.stringify(streamResult)}`);
    check(errors.length === 0, `Browser errors: ${errors.join('; ')}`);
    return [...reports, 'Streaming, UTF-8 boundaries, incomplete events and interruption passed'];
  } finally {
    await page.unroute(statusRoute, mockStatus);
    await page.unroute(chatRoute, mockChat);
    page.off('pageerror', onError);
  }
}
