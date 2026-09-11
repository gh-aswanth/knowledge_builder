async (page) => {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const errors = [];
  const onError = error => errors.push(error.message);
  page.on('pageerror', onError);
  const reports = [];
  try {
    await page.setViewportSize({width: 1440, height: 1000});
    await page.emulateMedia({colorScheme: 'dark', reducedMotion: 'no-preference'});
    await page.evaluate(() => {
      for (const key of ['theme', 'motion', 'chat-width']) localStorage.removeItem(`graph-studio.${key}`);
    });
    await page.reload();
    await page.waitForFunction(() => state.initialized && byId('theme-mode'));
    check(await page.locator('#theme-mode').inputValue() === 'system', 'Theme must default to system');
    check(await page.evaluate(() => document.documentElement.dataset.theme === 'dark' && graphColors.bg === '#0b1120'), 'System dark theme or canvas palette missing');
    await page.emulateMedia({colorScheme: 'light'});
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light' && graphColors.bg === '#f8f9fc');
    await page.locator('#theme-mode').selectOption('dark');
    await page.reload();
    await page.waitForFunction(() => state.initialized);
    check(await page.locator('#theme-mode').inputValue() === 'dark', 'Explicit theme not saved');
    check(await page.evaluate(() => document.documentElement.dataset.theme === 'dark'), 'Explicit theme ignored');
    reports.push('System theme, live OS changes, explicit override, and persistence passed');

    await page.locator('#open-chat').click();
    const defaultWidth = await page.locator('#chat-panel').evaluate(panel => panel.getBoundingClientRect().width);
    check(Math.abs(defaultWidth - 500) < 1, `Expected 500px default chat, got ${defaultWidth}`);
    check(await page.locator('#chat-panel input[type=range]').count() === 0, 'Chat should not contain a width slider');
    check(await page.locator('#panel-appearance #chat-width').count() === 1, 'Slider must live in Display settings');
    await page.locator('#chat-resizer').focus();
    await page.locator('#chat-resizer').press('End');
    const wide = await page.locator('#chat-panel').evaluate(panel => panel.getBoundingClientRect().width);
    check(wide > defaultWidth + 100, 'Chat width control did not expand chat');
    check(await page.locator('.stage').evaluate(stage => stage.getBoundingClientRect().width >= 359), 'Wide chat squeezed the canvas too far');
    await page.reload();
    await page.waitForFunction(() => state.initialized);
    await page.locator('#open-chat').click();
    check(Math.abs(await page.locator('#chat-panel').evaluate(panel => panel.getBoundingClientRect().width) - wide) < 1, 'Chat width not restored');
    await page.locator('#chat-resizer').dblclick();
    check(Math.abs(await page.locator('#chat-panel').evaluate(panel => panel.getBoundingClientRect().width) - 500) < 1, 'Chat width reset failed');
    await page.locator('[data-panel=appearance]').click();
    await page.locator('#chat-width').focus();
    await page.locator('#chat-width').press('ArrowRight');
    check(await page.locator('#chat-resizer').getAttribute('aria-valuenow') === '510', 'Settings slider did not update the border handle');
    await page.locator('#chat-width-reset').click();

    async function startDrag(distance) {
      const bounds = await page.locator('#chat-resizer').boundingBox();
      const startX = bounds.x + bounds.width / 2;
      const startY = bounds.y + bounds.height / 2;
      await page.mouse.move(startX, startY);
      await page.mouse.down();
      await page.mouse.move(startX + distance, startY, {steps: 6});
    }
    await startDrag(-120);
    await page.mouse.up();
    const draggedWidth = Number(await page.locator('#chat-resizer').getAttribute('aria-valuenow'));
    check(draggedWidth > 500, 'Dragging the left border left did not widen chat');
    check(Number(await page.locator('#chat-width').inputValue()) === draggedWidth, 'Drag did not synchronize the settings slider');
    check(await page.evaluate(() => !chatResize && !document.body.classList.contains('resizing-chat')), 'Pointer capture not cleaned up');
    await startDrag(60);
    await page.mouse.up();
    const narrowWidth = Number(await page.locator('#chat-resizer').getAttribute('aria-valuenow'));
    check(narrowWidth < draggedWidth, 'Dragging right did not narrow chat');
    await startDrag(-80);
    await page.locator('#chat-resizer').press('Escape');
    await page.mouse.up();
    check(Number(await page.locator('#chat-resizer').getAttribute('aria-valuenow')) === narrowWidth, 'Escape should cancel a resize');
    check(await page.locator('#chat-panel').isVisible(), 'Cancelling resize closed chat');
    await startDrag(-80);
    await page.evaluate(() => byId('chat-resizer').dispatchEvent(new PointerEvent('pointercancel', {pointerId: chatResize.pointerId})));
    await page.mouse.up();
    check(Number(await page.locator('#chat-resizer').getAttribute('aria-valuenow')) === narrowWidth, 'Pointer cancellation should restore width');
    await startDrag(-80);
    await page.evaluate(() => closeChat());
    await page.mouse.up();
    check(await page.evaluate(() => !chatResize && !document.body.classList.contains('resizing-chat')), 'Closing chat left a resize active');
    await page.locator('#open-chat').click();
    await page.locator('#chat-resizer').focus();
    await page.locator('#chat-resizer').press('Home');
    check(await page.locator('#chat-width').inputValue() === await page.locator('#chat-resizer').getAttribute('aria-valuemin'), 'Minimum width bound failed');
    await page.locator('#chat-resizer').press('ArrowRight');
    check(await page.locator('#chat-width').inputValue() === await page.locator('#chat-resizer').getAttribute('aria-valuemin'), 'Resize exceeded the minimum bound');
    await page.locator('#chat-width-reset').click();
    reports.push('Border dragging, keyboard resize, settings sync, saved width, reset, bounds, and cancellation passed');

    await page.locator('#chat-close').click();
    await page.evaluate(() => { state.paused = true; state.remaining = 0; updatePhysicsButton(); });
    const initialTime = await page.evaluate(() => state.visualTime);
    await page.waitForFunction(start => state.visualTime > start + 80, initialTime);
    await page.locator('#motion-toggle').click();
    await page.waitForFunction(() => !state.framePending);
    const stopped = await page.evaluate(() => ({time: state.visualTime, canvas: canvas.toDataURL()}));
    await page.locator('#theme-mode').selectOption('light');
    await page.waitForFunction(() => !state.framePending);
    check(await page.evaluate(time => state.visualTime === time && !graphMotionEnabled(), stopped.time), 'Motion continued while paused');
    await page.reload();
    await page.waitForFunction(() => state.initialized && !state.framePending);
    check(await page.locator('#motion-toggle').getAttribute('aria-pressed') === 'false', 'Motion preference not saved');
    check(await page.locator('#physics').isDisabled(), 'Layout animation still enabled with graph motion off');
    await page.locator('#motion-toggle').click();
    await page.locator('#layout').selectOption('radial');
    check(await page.evaluate(() => Boolean(state.layoutTransition)), 'Layout transition not started');
    await page.waitForFunction(() => !state.layoutTransition);
    check(await page.evaluate(() => state.visibleNodes.every(node => Number.isFinite(node.positionX) && Number.isFinite(node.positionY))), 'Layout produced invalid positions');
    await page.locator('#layout').selectOption('hierarchy');
    await page.emulateMedia({reducedMotion: 'reduce'});
    await page.waitForFunction(() => !state.framePending);
    check(await page.evaluate(() => !state.layoutTransition && !graphMotionEnabled() && state.paused && document.documentElement.dataset.motion === 'off'), 'Live reduced-motion preference not respected');
    check(await page.locator('#motion-toggle').isDisabled(), 'Motion toggle should reflect system reduction');
    await page.emulateMedia({reducedMotion: 'no-preference'});
    await page.waitForFunction(() => graphMotionEnabled());
    check(await page.locator('#motion-toggle').isEnabled(), 'Motion control did not recover');
    reports.push('Ambient motion, pause/idle, saved preference, layout transitions, and reduced motion passed');

    for (const width of [1200, 768, 390, 320]) {
      await page.setViewportSize({width, height: 844});
      if (await page.locator('#chat-panel').isHidden()) await page.locator('#open-chat').click();
      await page.locator('#chat-panel').evaluate(panel => Promise.all(panel.getAnimations().map(animation => animation.finished.catch(() => {}))));
      for (const theme of ['dark', 'light']) {
        await page.locator('#theme-mode').selectOption(theme);
        const bounds = await page.evaluate(() => ({
          viewport: innerWidth,
          page: document.documentElement.scrollWidth,
          panel: byId('chat-panel').getBoundingClientRect().toJSON(),
          heading: document.querySelector('.chat-heading').scrollWidth,
          chatWidth: byId('chat-panel').clientWidth,
          surface: getComputedStyle(byId('chat-panel')).backgroundColor
        }));
        check(bounds.page <= bounds.viewport + 1 && bounds.panel.right <= bounds.viewport + 1 && bounds.panel.left >= 0, `${width}px ${theme}: horizontal overflow`);
        check(bounds.heading <= bounds.chatWidth + 1, `${width}px: chat header overflow`);
        check(bounds.surface === (theme === 'dark' ? 'rgb(19, 26, 41)' : 'rgb(255, 255, 255)'), 'Chat surface not themed');
      }
      const phone = await page.evaluate(() => innerWidth <= 760);
      check(await page.locator('#chat-resizer').isVisible() === !phone, 'Resize handle should hide on phones');
      check(await page.locator('#chat-width').isDisabled() === phone, 'Phone width should be automatic');
    }
    reports.push('Tablet/mobile themes and chat layout passed at 1200, 768, 390, and 320px');
    await page.locator('#theme-mode').selectOption('system');
    check(errors.length === 0, `Browser errors: ${errors.join('; ')}`);
    return reports;
  } finally {
    page.off('pageerror', onError);
    await page.emulateMedia({colorScheme: 'light', reducedMotion: 'no-preference'});
  }
}
