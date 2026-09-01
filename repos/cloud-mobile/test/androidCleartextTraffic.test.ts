import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Import the pure manifest mutation exported by the config plugin. Keeping
// this separate from Expo's mod runner makes the regression test fast and
// deterministic while still validating the actual prebuild mutation.
// The plugin is CommonJS because Expo loads config plugins directly in Node.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { setAndroidCleartextTraffic } = require('../plugins/withAndroidCleartextTraffic');

const projectRoot = path.resolve(__dirname, '..');

describe('Android cleartext WebSocket configuration', () => {
  it('registers the config plugin in app.json', () => {
    const appConfig = JSON.parse(fs.readFileSync(path.join(projectRoot, 'app.json'), 'utf8'));
    expect(appConfig.expo.plugins).toContain('./plugins/withAndroidCleartextTraffic');
  });

  it('sets usesCleartextTraffic on the Android application manifest', () => {
    const manifest: {
      manifest: { application: Array<{ $: Record<string, string> }> };
    } = {
      manifest: {
        application: [{ $: { 'android:name': '.MainApplication' } }],
      },
    };

    setAndroidCleartextTraffic(manifest);

    expect(manifest.manifest.application[0].$['android:usesCleartextTraffic']).toBe('true');
  });

  it('keeps the checked-in generated manifest aligned with prebuild output', () => {
    const manifestPath = path.join(projectRoot, 'android/app/src/main/AndroidManifest.xml');
    const manifest = fs.readFileSync(manifestPath, 'utf8');
    expect(manifest).toMatch(
      /<application\b[^>]*\bandroid:usesCleartextTraffic="true"[^>]*>/,
    );
  });
});
