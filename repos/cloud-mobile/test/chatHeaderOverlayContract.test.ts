import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const projectRoot = path.resolve(__dirname, '..');
const chatScreenPath = path.join(projectRoot, 'src/features/chat/ChatScreen.tsx');

function readChatScreen(): string {
  return fs.readFileSync(chatScreenPath, 'utf8');
}

function sourceBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) throw new Error(`source markers not found: ${startMarker} -> ${endMarker}`);
  return source.slice(start, end);
}

describe('chat header overlay layout contract', () => {
  it('renders the transcript before an absolute top chrome and insets its content', () => {
    const source = readChatScreen();
    const screen = sourceBetween(source, 'return (', '\n  );\n}\n\nfunction selectChatState');
    const transcriptIndex = screen.indexOf('<ChatTranscript');
    const topChromeIndex = screen.indexOf('testID="chat-top-chrome"');

    expect(transcriptIndex).toBeGreaterThanOrEqual(0);
    expect(topChromeIndex).toBeGreaterThan(transcriptIndex);
    expect(source).toContain("topChrome: { left: 0, position: 'absolute'");
    expect(source).toContain('topChromeHeight');
    expect(source).toContain('paddingTop: props.topChromeInset');
  });

  it('keeps native automatic top adjustment off and aligns the scroll indicator', () => {
    const source = readChatScreen();
    const transcript = sourceBetween(source, 'const ChatTranscript = memo', 'const TurnTranscriptItem = memo');

    expect(transcript).toContain("contentInsetAdjustmentBehavior=\"never\"");
    expect(transcript).toContain('scrollIndicatorInsets={{ top: props.topChromeInset }}');
  });

  it('uses a separate absolute-fill material layer and content/hairline layers', () => {
    const source = readChatScreen();
    const screen = sourceBetween(source, 'return (', '\n  );\n}\n\nfunction selectChatState');

    expect(screen).toContain('testID="chat-top-chrome"');
    expect(screen).toContain('style={styles.topChromeMaterial}');
    expect(screen).toContain('styles.topChromeContent');
    expect(screen).toContain('styles.topChromeEdge');
    expect(source).toContain('topChromeFallback');
  });
});
