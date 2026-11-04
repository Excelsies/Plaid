import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSelf } from '../helpers.mjs';

// The drop preview: a gliding one (fade in, glide between targets) and the
// plain one that jumps.

function preview() {
  return {
    visible: false, opacity: 255, style: '', eases: [], removed: 0, pos: null, size: null,
    ease(p) { this.eases.push(p); },
    remove_all_transitions() { this.removed++; },
    set_position(x, y) { this.pos = [x, y]; },
    set_size(w, h) { this.size = [w, h]; },
  };
}

function previewSelf() {
  const self = makeSelf({ 'border-radius': 12 });
  self._dropPreview = preview();
  return self;
}

test('glide: fades in at its first target, glides to the next, never re-eases the same one', () => {
  const self = previewSelf();
  const p = self._dropPreview;
  self.dragPreview.showDropPreview(10, 20, 300, 200, true);
  assert.equal(p.visible, true);
  assert.equal(p.opacity, 0);
  assert.deepEqual([p.pos, p.size], [[10, 20], [300, 200]]);
  assert.deepEqual(p.eases.map(e => [e.opacity, e.duration]), [[255, 120]]);
  assert.match(p.style, /border-radius: 12px/);
  assert.deepEqual(self._dropPreviewTarget, { x: 10, y: 20, w: 300, h: 200 });
  self.dragPreview.showDropPreview(10, 20, 300, 200, true);
  assert.equal(p.eases.length, 1);
  self.dragPreview.showDropPreview(400, 20, 300, 200, true);
  assert.deepEqual(p.eases[1], { x: 400, y: 20, width: 300, height: 200, opacity: 255, duration: 80, mode: 0 });
});

test('hide: stops the glide and forgets the target', () => {
  const self = previewSelf();
  const p = self._dropPreview;
  self.dragPreview.showDropPreview(10, 20, 300, 200, true);
  const removed = p.removed;
  self.dragPreview.hideDropPreview();
  assert.equal(p.visible, false);
  assert.equal(p.removed, removed + 1);
  assert.equal(self._dropPreviewTarget, null);
  // Shown again: it fades in again.
  self.dragPreview.showDropPreview(10, 20, 300, 200, true);
  assert.equal(p.eases.at(-1).duration, 120);
});

test('plain: jumps with the plain style, no target recorded', () => {
  const self = previewSelf();
  const p = self._dropPreview;
  self.dragPreview.showDropPreview(10, 20, 300, 200, true);
  self.dragPreview.hideDropPreview();
  self.dragPreview.showDropPreview(5, 5, 100, 100);
  assert.equal(p.visible, true);
  assert.doesNotMatch(p.style, /border-radius/);
  assert.deepEqual([p.pos, p.size], [[5, 5], [100, 100]]);
  assert.equal(p.eases.length, 1, 'no ease');
  assert.equal(self._dropPreviewTarget, null);
});

test('plain after a glide: a later glide to the same target moves the preview back', () => {
  const self = previewSelf();
  const p = self._dropPreview;
  self.dragPreview.showDropPreview(10, 20, 300, 200, true);
  self.dragPreview.showDropPreview(400, 20, 300, 200);
  assert.deepEqual(p.pos, [400, 20]);
  self.dragPreview.showDropPreview(10, 20, 300, 200, true);
  assert.deepEqual(p.eases.at(-1), { x: 10, y: 20, width: 300, height: 200, opacity: 255, duration: 80, mode: 0 });
});

test('plain after an interrupted fade: shown opaque, the fade stopped', () => {
  const self = previewSelf();
  const p = self._dropPreview;
  self.dragPreview.showDropPreview(10, 20, 300, 200, true);
  p.opacity = 90; // the fade, part way
  self.dragPreview.hideDropPreview();
  const removed = p.removed;
  self.dragPreview.showDropPreview(5, 5, 100, 100);
  assert.equal(p.opacity, 255);
  assert.ok(p.removed > removed, 'transitions stopped');
});
