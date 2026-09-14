import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const projectRoot = path.resolve(__dirname, '..');
const connectionScreenPath = path.join(projectRoot, 'src/features/connection/ConnectionScreen.tsx');
const helpScreenPath = path.join(projectRoot, 'src/features/help/HelpScreen.tsx');
const helpRoutePath = path.join(projectRoot, 'app/help.tsx');
const layoutPath = path.join(projectRoot, 'app/_layout.tsx');

function read(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8');
}

describe('settings help route and Host guide contract', () => {
  it('exposes the help action only from the settings list and opens the native help route', () => {
    const connectionScreen = read(connectionScreenPath);
    expect(connectionScreen).toContain("router.push('/help')");
    expect(connectionScreen).toContain('testID="connection-help"');
    expect(connectionScreen).toContain('onOpenHelp');

    const listStart = connectionScreen.indexOf('function HostList(');
    const editorStart = connectionScreen.indexOf('interface HostEditorProps');
    expect(listStart).toBeGreaterThanOrEqual(0);
    expect(editorStart).toBeGreaterThan(listStart);
    const list = connectionScreen.slice(listStart, editorStart);
    expect(list).toContain('onOpenHelp');
    expect(list).toContain('testID="connection-help"');

    const editor = connectionScreen.slice(editorStart);
    expect(editor).not.toContain('testID="connection-help"');
  });

  it('registers a thin native route with safe-area, scroll, and native back behavior', () => {
    const helpRoute = read(helpRoutePath);
    const helpScreen = read(helpScreenPath);
    const layout = read(layoutPath);

    expect(helpRoute).toContain("from '../src/features/help/HelpScreen'");
    expect(helpRoute).toContain('<HelpScreen />');
    expect(layout).toContain('<Stack.Screen name="help"');
    expect(helpScreen).toContain('<SafeAreaView');
    expect(helpScreen).toContain('<ScrollView');
    expect(helpScreen).toContain('router.back()');
    expect(helpScreen).toContain('testID="help-back"');
    expect(helpScreen).toContain('allowFontScaling');
  });

  it('keeps operational examples selectable and the guide aligned with current Host security boundaries', () => {
    const helpScreen = read(helpScreenPath);

    expect(helpScreen).toContain('Node.js 22+');
    expect(helpScreen).toContain('npx @cddchen/cloud@latest start --global');
    expect(helpScreen).toContain('--token=replace-with-a-high-entropy-token');
    expect(helpScreen).toContain('Host/SDK 使用服务端电脑上的 Claude Code 配置');
    expect(helpScreen).toContain('npx @cddchen/cloud@latest status');
    expect(helpScreen).toContain('npx @cddchen/cloud@latest stop');
    expect(helpScreen).toContain('8787');
    expect(helpScreen).toContain('Tailscale');
    expect(helpScreen).toContain('WireGuard');
    expect(helpScreen).toContain('http://&lt;组网 IP&gt;:&lt;端口&gt;');
    expect(helpScreen).toContain('http://xxx:yyy');
    expect(helpScreen).toContain('http://100.64.0.2:8787');
    expect(helpScreen).toContain('Token 单独');
    expect(helpScreen).toContain('不要把 Token 拼进 URL');
    expect(helpScreen).toContain('TLS');
    expect(helpScreen).toContain('高熵');
    expect(helpScreen).toContain('selectable');
    expect(helpScreen).not.toMatch(/https?:\/\/[^'"`\s]+\?token=/iu);
  });
});
