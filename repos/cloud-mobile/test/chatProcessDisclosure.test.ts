import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.join(process.cwd(), 'src/features/chat/ChatScreen.tsx'), 'utf8');

describe('chat process disclosure contract', () => {
  it('renders reasoning and tool details in bounded nested scroll views', () => {
    expect(source).toContain('function BoundedProcessContent');
    expect(source).toContain('nestedScrollEnabled');
    expect(source).toContain('processContentMaxHeight');
    expect(source).toContain('<BoundedProcessContent ');
    expect(source).toContain('part.kind === \'reasoning\'');
    expect(source).toContain('part.output !== undefined');
    expect(source).toContain('part.error !== undefined');
    expect(source).toContain("part.kind === 'system' ? <BoundedProcessContent");
    expect(source).toContain('lineHeight={21}');
  });

  it('keeps process details selectable and preserves disclosure state by part id', () => {
    expect(source).toContain('selectable');
    expect(source).toContain('partOpen[part.id] === true');
    expect(source).toContain('onToggle={() => setPartOpen');
  });

  it('renders normalized SDK activity in the active process title', () => {
    expect(source).toContain("activity === 'requesting_model'");
    expect(source).toContain('正在请求 Claude');
    expect(source).toContain("activity === 'compacting_context'");
    expect(source).toContain('正在压缩上下文');
  });

});
