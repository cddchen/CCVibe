import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(path.join(process.cwd(), 'src/features/chat/ChatScreen.tsx'), 'utf8');

describe('chat rewind interaction contract', () => {
  it('offers both rewind scopes from a long-pressed user prompt', () => {
    expect(source).toContain('onLongPress={() => onRewind(turn)}');
    expect(source).toContain("'是否撤回到该消息？'");
    expect(source).toContain("{ text: '取消', style: 'cancel' }");
    expect(source).toContain("{ text: '撤回会话', onPress: () => void applyRewind('conversation') }");
    expect(source).toContain("{ text: '撤回消息和变更', style: 'destructive', onPress: () => void applyRewind('conversation_and_files') }");
  });

  it('restores the selected prompt into the composer only after Host acceptance', () => {
    expect(source).toContain("if (result.status !== 'accepted') return;");
    expect(source).toContain('draftRef.current = turn.prompt;');
    expect(source).toContain('composerInputRef.current?.focus();');
  });
});
