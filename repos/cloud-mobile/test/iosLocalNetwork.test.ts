import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const localNetworkUsageDescription = 'Cloud needs access to your local network to connect to your Cloud Agent Host.';

describe('iOS local-network connection configuration', () => {
  it('declares a local-network permission description in Expo and the checked-in native project', () => {
    const appConfig = JSON.parse(fs.readFileSync(path.join(projectRoot, 'app.json'), 'utf8')) as {
      readonly expo: { readonly ios: { readonly infoPlist: Readonly<Record<string, unknown>> } };
    };
    const infoPlist = fs.readFileSync(path.join(projectRoot, 'ios/Cloud/Info.plist'), 'utf8');

    expect(appConfig.expo.ios.infoPlist.NSLocalNetworkUsageDescription).toBe(localNetworkUsageDescription);
    expect(infoPlist).toContain('<key>NSLocalNetworkUsageDescription</key>');
    expect(infoPlist).toContain(`<string>${localNetworkUsageDescription}</string>`);
  });
});
