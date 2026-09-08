import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('home session refresh contract', () => {
  it('keeps the refresh affordance accessible and loading-aware', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../src/features/home/HomeScreen.tsx'), 'utf8');

    expect(source).toContain('最近会话');
    expect(source).toContain('accessibilityLabel="刷新最近会话"');
    expect(source).toContain("state.sync.status === 'connected'");
    expect(source).toContain('disabled={props.refreshingSessions || !props.canRefreshSessions}');
    expect(source).toContain('props.actions.refreshSessions()');
    expect(source).toContain('props.refreshingSessions\n            ? <ActivityIndicator');
  });
});
