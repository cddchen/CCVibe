// Config plugins are loaded by Expo's Node-based prebuild runtime, so this
// file intentionally uses CommonJS instead of depending on a transpiler.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { withAndroidManifest } = require('expo/config-plugins');

/**
 * Keep local-network WebSocket connections working in standalone Android
 * builds. The client intentionally supports ws:// for a host running on the
 * same LAN; Android otherwise rejects cleartext traffic in release builds.
 *
 * This is a config plugin (rather than a one-off native edit) so `expo
 * prebuild` and future native regeneration keep the setting in sync.
 */
function setAndroidCleartextTraffic(androidManifest) {
  const application = androidManifest?.manifest?.application?.[0];
  if (!application) {
    throw new Error('Android manifest is missing its application element');
  }

  application.$ ??= {};
  application.$['android:usesCleartextTraffic'] = 'true';
  return androidManifest;
}

function withAndroidCleartextTraffic(config) {
  return withAndroidManifest(config, (manifestConfig) => {
    setAndroidCleartextTraffic(manifestConfig.modResults);
    return manifestConfig;
  });
}

module.exports = withAndroidCleartextTraffic;
module.exports.setAndroidCleartextTraffic = setAndroidCleartextTraffic;
