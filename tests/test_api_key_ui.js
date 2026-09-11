async (page) => {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const statusRoute = '**/api/graphs/*/chat/status';
  const chatRoute = '**/api/graphs/*/chat';
  const baseURL = page.url();
  const secret = 'test-tab-only-key';
  const requests = [];
  const errors = [];
  const onError = error => errors.push(error.message);
  page.on('pageerror', onError);
  let runtimeReady = true;
  let serverKey = false;
  const statusHandler = route => route.fulfill({json: {
    ready: runtimeReady && serverKey, runtime_ready: runtimeReady, key_configured: serverKey,
    runtime_issues: runtimeReady ? [] : ['Install chat dependencies.'], token: 'test-token',
    issues: [...(runtimeReady ? [] : ['Install chat dependencies.']), ...(serverKey ? [] : ['Enter an API key.'])],
  }});
  let pendingChat = null;
  let resolveChat = null;
  const finishChat = route => route.fulfill({contentType: 'text/event-stream', body: [
    ['run_start', {run_id: 'test-run', session_id: 'test-session'}],
    ['llm_start', {id: 'answer'}],
    ['llm_delta', {id: 'answer', text: '## Answer\n\nThe graph is ready.'}],
    ['llm_end', {id: 'answer', usage: {}}],
    ['run_end', {turns_remaining: 5, tool_calls: 0}],
  ].map(([kind, data]) => `event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`).join('')});
  const chatHandler = route => {
    requests.push(route.request().postDataJSON());
    pendingChat = route;
    resolveChat?.();
  };
  await page.route(statusRoute, statusHandler);
  await page.route(chatRoute, chatHandler);
  try {
    for (const width of [1440, 390]) {
      await page.setViewportSize({width, height: 950});
      await page.goto(baseURL);
      await page.waitForFunction(() => state.initialized);
      await page.locator('#open-chat').click();
      await page.waitForFunction(() => byId('chat-status').textContent === 'Chat setup required');
      check(await page.locator('#chat-key-settings').getAttribute('open') !== null, 'Missing-key setup must open the key field');
      check(await page.locator('#chat-api-key').getAttribute('type') === 'password', 'API key must be masked');
      check(await page.locator('#chat-send').isDisabled(), 'Missing key should block Send');
      await page.locator('#chat-api-key').fill(secret);
      await page.locator('#chat-key-use').click();
      await page.waitForFunction(() => chatState.ready);
      check(await page.locator('#chat-api-key').inputValue() === '', 'Applied key remains in the DOM input');
      check(await page.locator('#chat-key-source').textContent() === 'This tab', 'Tab key source missing');
      check(await page.evaluate(value => !JSON.stringify({...localStorage, ...sessionStorage}).includes(value) && !document.cookie.includes(value), secret), 'Key was persisted in browser storage');
      await page.locator('#chat-input').fill('Show the graph summary.');
      const chatArrived = new Promise(resolve => { resolveChat = resolve; });
      await page.locator('#chat-send').click();
      await page.waitForFunction(() => Boolean(chatState.active));
      check(await page.locator('#chat-key-use').isDisabled() && await page.locator('#chat-key-clear').isDisabled(), 'Key settings must be locked during a run');
      await chatArrived;
      check(pendingChat !== null, 'Chat request missing');
      check(requests.at(-1).api_key === secret && requests.at(-1).message === 'Show the graph summary.', 'Key not sent separately from the message');
      await finishChat(pendingChat); pendingChat = null;
      await page.waitForFunction(() => !chatState.active && byId('chat-status').textContent.startsWith('Complete'));
      check(!(await page.locator('#chat-messages').innerText()).includes(secret), 'Key leaked into conversation');
      check(await page.locator('.chat-answer h2').textContent() === 'Answer', 'Markdown chat regressed');
      runtimeReady = false;
      await page.evaluate(() => checkChatSetup());
      check(await page.locator('#chat-send').isDisabled(), 'Tab key bypassed missing dependencies');
      check((await page.locator('#chat-setup-text').textContent()).includes('Install chat dependencies'), 'Dependency issue disappeared');
      runtimeReady = true;
      await page.locator('#chat-key-clear').click();
      await page.waitForFunction(() => byId('chat-key-source').textContent === 'Not configured');
      check(await page.locator('#chat-send').isDisabled(), 'Clear did not disable missing-key chat');
      serverKey = true;
      await page.evaluate(() => checkChatSetup());
      check(await page.locator('#chat-key-source').textContent() === 'Server environment', 'Clear should fall back to server key');
      check(await page.locator('#chat-send').isEnabled(), 'Server key fallback should enable chat');
      serverKey = false;
      await page.locator('#chat-api-key').fill(secret);
      await page.locator('#chat-key-use').click();
      await page.waitForFunction(() => chatState.ready);
      const other = await page.context().newPage();
      try {
        await other.route(statusRoute, statusHandler);
        await other.goto(baseURL);
        await other.waitForFunction(() => state.initialized);
        await other.locator('#open-chat').click();
        await other.waitForFunction(() => byId('chat-status').textContent === 'Chat setup required');
        check(await other.locator('#chat-send').isDisabled(), 'Key leaked to another tab');
      } finally { await other.close(); }
      check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1 && byId('chat-scroll').scrollWidth <= byId('chat-scroll').clientWidth + 1), `Key settings overflow at ${width}px`);
      await page.reload();
      await page.waitForFunction(() => state.initialized);
      await page.locator('#open-chat').click();
      await page.waitForFunction(() => byId('chat-status').textContent === 'Chat setup required');
      check(await page.locator('#chat-key-clear').isDisabled(), 'Key survived page refresh');
    }
    check(!errors.length, `Browser errors: ${errors.join('; ')}`);
    return 'Desktop/mobile: masked input, per-request key, no persistence, tab isolation, clear/fallback, dependency gating, busy state, Markdown, and refresh passed';
  } finally {
    if (pendingChat) await pendingChat.abort();
    await page.unroute(statusRoute, statusHandler);
    await page.unroute(chatRoute, chatHandler);
    page.off('pageerror', onError);
  }
}
