import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { copyMessageText } from '../src/features/chat/messageClipboard';

const source = fs.readFileSync(path.join(process.cwd(), 'src/features/chat/ChatScreen.tsx'), 'utf8');
const podLockPaths = ['ios/Podfile.lock', 'ios/Pods/Manifest.lock'].map((relativePath) => path.join(process.cwd(), relativePath));

describe('chat copy interaction contract', () => {
  it('copies the exact source through the clipboard port', async () => {
    const copied: string[] = [];
    await copyMessageText('  **raw markdown**  ', { setStringAsync: async (value) => { copied.push(value); } });
    expect(copied).toEqual(['  **raw markdown**  ']);
  });

  it('surfaces a rejected clipboard write to the caller', async () => {
    await expect(copyMessageText('raw', { setStringAsync: async () => false })).rejects.toThrow('Clipboard rejected');
  });

  it('does not touch the clipboard for empty messages', async () => {
    let writes = 0;
    await copyMessageText('', { setStringAsync: async () => { writes += 1; } });
    expect(writes).toBe(0);
  });

  it('exposes copy actions without using prompt long press for rewind', () => {
    expect(source).toContain("accessibilityLabel=\"复制用户消息\"");
    expect(source).toContain("accessibilityLabel=\"复制助手回复\"");
    expect(source).toContain('<EnrichedMarkdownText');
    expect(source).toContain('<Text selectable style={[styles.streamingText');
    expect(source).not.toContain('onLongPress={() => onRewind(turn)}');
    expect(source).toContain("accessibilityLabel=\"撤回到此消息\"");
  });

  it('keeps copy feedback out of runtime state and handles failure quietly', () => {
    expect(source).toContain('copyMessageText(rawText)');
    expect(source).toContain("setNotice('已复制')");
    expect(source).toContain("setNotice('复制失败，请重试')");
  });

  it('keeps the Expo clipboard native module in both iOS pod locks', () => {
    const existingLocks = podLockPaths.filter(fs.existsSync).map((lockPath) => fs.readFileSync(lockPath, 'utf8'));
    expect(existingLocks.length).toBeGreaterThan(0);
    for (const lock of existingLocks) {
      expect(lock).toContain('- ExpoClipboard (8.0.8):');
      expect(lock).toContain('- ExpoClipboard (from `../node_modules/expo-clipboard/ios`)');
    }
  });

  it('anchors the assistant copy action to the assistant body start', () => {
    expect(source).toContain('style={[styles.messageAction, styles.assistantMessageAction]}');
    expect(source).toContain("assistantMessageAction: { alignSelf: 'flex-start' }");
  });
});
