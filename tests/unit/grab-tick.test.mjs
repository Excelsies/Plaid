import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSelf, frameClock } from '../helpers.mjs';

// before-update comes once per stage view: the grab loop ticks for one.

test('grab loop: the tick runs once per frame, for the view showing the grabbed window\'s monitor', () => {
  const self = makeSelf({ enabled: true });
  const clock = frameClock();
  const oldDisplay = global.display;
  global.display = { ...(oldDisplay ?? {}), get_monitor_geometry: m => [{ x: 0, y: 0, width: 2560, height: 1440 },
    { x: 2560, y: 0, width: 1920, height: 1080 }][m] };
  const view = (x, y, w, h) => ({ get_layout(r) { Object.assign(r, { x, y, width: w, height: h }); } });
  const views = [view(0, 0, 2560, 1440), view(2560, 0, 1920, 1080)];
  try {
    let mon = 1;
    const win = { get_monitor: () => mon, get_compositor_private: () => ({}), get_frame_rect: () => ({ width: 1, height: 1 }) };
    let ticks = 0;
    self.grab.resizeTick = () => ticks++;
    self._grabOp = 1;
    self.grab.startGrabLoop(win, 'resize');
    for (const v of views) clock.frame(v);
    assert.equal(ticks, 1, 'one of two views');
    mon = 0;
    clock.frame(views[1]);
    assert.equal(ticks, 1, 'not the other monitor\'s view');
    clock.frame(views[0]);
    assert.equal(ticks, 2);
    // No view given, or no monitor: it runs.
    clock.frame();
    mon = -1;
    clock.frame(views[1]);
    assert.equal(ticks, 4);
    self.grab.stopLiveResizeLoop();
  } finally {
    global.display = oldDisplay;
    clock.restore();
  }
});
