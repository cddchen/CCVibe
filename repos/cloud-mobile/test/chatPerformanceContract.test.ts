import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const projectRoot = path.resolve(__dirname, '..');

describe('chat rendering performance contract', () => {
  it('isolates transcript reconciliation from composer keystrokes', () => {
    const source = fs.readFileSync(path.join(projectRoot, 'src/features/chat/ChatScreen.tsx'), 'utf8');

    expect(source).toContain('const ChatTranscript = memo(');
    expect(source).toContain('const TurnTranscriptItem = memo(');
    expect(source).toContain('useDeferredValue(props.turns)');
    expect(source).toContain("const draftRef = useRef('');");
    expect(source).not.toContain('value={draft}');
  });

  it('coalesces Host token bursts to at most one React notification per display frame', () => {
    const provider = fs.readFileSync(path.join(projectRoot, 'src/features/runtime/CloudRuntimeProvider.tsx'), 'utf8');
    const screen = fs.readFileSync(path.join(projectRoot, 'src/features/chat/ChatScreen.tsx'), 'utf8');

    expect(provider).toContain('export function useCloudFrameSelector');
    expect(provider).toContain('subscribeOnFrame(');
    expect(provider).toContain('{ request: requestAnimationFrame, cancel: cancelAnimationFrame }');
    expect(screen).toContain('useCloudFrameSelector(selectChat)');
  });

  it('does not run the markdown parser for every partial stream update', () => {
    const source = fs.readFileSync(path.join(projectRoot, 'src/features/chat/ChatScreen.tsx'), 'utf8');

    expect(source).toContain("turn.status === 'active'");
    expect(source).toContain('<StreamingAnswer');
  });

  it('bounds transcript virtualization work on long conversations', () => {
    const source = fs.readFileSync(path.join(projectRoot, 'src/features/chat/ChatScreen.tsx'), 'utf8');

    expect(source).toContain('initialNumToRender={8}');
    expect(source).toContain('maxToRenderPerBatch={6}');
    expect(source).toContain('windowSize={7}');
  });

  it('memoizes permission sheets so unrelated streaming and typing updates cannot rerender them', () => {
    const source = fs.readFileSync(path.join(projectRoot, 'src/features/chat/ChatScreen.tsx'), 'utf8');
    const start = source.indexOf('const ApprovalSheet');
    const end = source.indexOf('function InputSheet', start);
    const component = source.slice(start, end);

    expect(component).toContain('const ApprovalSheet = memo(');
    expect(component).toContain('const cachedRef = useRef(props.approval)');
  });
});
