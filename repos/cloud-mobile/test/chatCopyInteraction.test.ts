import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { copyMessageText } from '../src/features/chat/messageClipboard';

const source = fs.readFileSync(path.join(process.cwd(), 'src/features/chat/ChatScreen.tsx'), 'utf8');

describe('chat copy interaction contract', () => {
  it('copies the exact source through the clipboard port', async () => {
    const copied: string[] = [];
    await copyMessageText('  **raw markdown**  ', { setStringAsync: async (value) => { copied.push(value); } });
    expect(copied).toEqual(['  **raw markdown**  ']);
  });

  it('surfaces a rejected clipboard write to the caller', async () => {
    await expect(copyMessageText('raw', { setStringAsync: async () => false })).rejects.toThrow('Clipboard rejected');
  });

  it('exposes copy actions without using prompt long press for rewind', () => {
    expect(source).toContain("accessibilityLabel=\"复制用户消息\"");
    expect(source).toContain("accessibilityLabel=\"复制助手回复\"");
    expect(source).toContain('selectableMarkdownRules');
    expect(source).toContain('<Text selectable style={[styles.streamingText');
    expect(source).not.toContain('onLongPress={() => onRewind(turn)}');
    expect(source).toContain("accessibilityLabel=\"撤回到此消息\"");
  });

  it('keeps copy feedback out of runtime state and handles failure quietly', () => {
    expect(source).toContain('copyMessageText(rawText)');
    expect(source).toContain("setNotice('已复制')");
    expect(source).toContain("setNotice('复制失败，请重试')");
  });
});
