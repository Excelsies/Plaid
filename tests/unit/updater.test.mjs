import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSelf } from '../helpers.mjs';

test('updater: destroy cancels the check and its subprocess waits', async () => {
  const self = makeSelf({ 'release-check-enabled': true });
  self.ext = { path: '/home/u/.local/share/gnome-shell/extensions/plaid@plyply99', metadata: { version: 5131 } };
  const up = self.updater;
  const seen = [];
  up._communicate = (argv, cancellable) => { seen.push(cancellable); up.destroy(); return Promise.resolve(JSON.stringify({ tag_name: 'v99.0', assets: [{ name: 'plaid@plyply99.zip', browser_download_url: 'https://x/z.zip' }] })); };
  let installs = 0;
  up._install = async () => { installs++; };
  await up.checkForUpdates();
  assert.equal(installs, 0);
  assert.equal(seen.length, 1);
  assert.equal(seen[0], up._cancellable);
  assert.equal(up._cancellable.is_cancelled(), true);
});

test('updater: a destroyed updater does not start a check', async () => {
  const self = makeSelf({ 'release-check-enabled': true });
  const up = self.updater;
  up.destroy();
  let checks = 0;
  up._communicate = async () => { checks++; return ''; };
  await up.checkForUpdates();
  assert.equal(checks, 0);
});
