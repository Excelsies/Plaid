import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeSelf } from '../helpers.mjs';

const schema = readFileSync(new URL('../../extensions/schemas/org.gnome.shell.extensions.plaid.gschema.xml',
  import.meta.url), 'utf8');

function schemaDefault(key) {
  const block = schema.match(new RegExp(`<key name="${key}"[\\s\\S]*?</key>`))?.[0];
  return block?.match(/<default>([^<]*)<\/default>/)?.[1];
}

// A build of this fork is not an upstream release: the updater would replace
// it with one.
test('release-check-enabled: off by default, so a fresh install checks nothing', async () => {
  const value = schemaDefault('release-check-enabled');
  assert.equal(value, 'false');
  const self = makeSelf({ 'release-check-enabled': value === 'true' });
  self.ext.path = '/home/user/.local/share/gnome-shell/extensions/plaid@plyply99';
  let fetched = 0;
  self.updater._communicate = async () => {
    fetched++;
    return '{}';
  };
  await self.updater.checkForUpdates();
  assert.equal(fetched, 0);
});
