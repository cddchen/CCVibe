import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const projectRoot = path.resolve(__dirname, '..');

describe('Home choice sheet glass contract', () => {
  const source = fs.readFileSync(path.join(projectRoot, 'src/features/home/HomeScreen.tsx'), 'utf8');
  const sheetStart = source.indexOf('function HomeChoiceSheet');
  const sheetEnd = source.indexOf('interface GlassPressableProps', sheetStart);
  const sheet = source.slice(sheetStart, sheetEnd);

  it('uses the shared model-choice GlassPanel material tier', () => {
    expect(source).toContain("import { GlassPanel } from '../../ui/glass/GlassPanel';");
    expect(sheet).toContain('<GlassPanel blurIntensity={82} glassEffectStyle="regular" materialElevation={5} materialShape="extraLarge"');
    expect(sheet).not.toContain('<GlassSurface blurIntensity={82}');
  });

  it('keeps the picker bounded while GlassPanel supplies the outer shrink contract', () => {
    const glassPanelSource = fs.readFileSync(path.join(projectRoot, 'src/ui/glass/GlassPanel.tsx'), 'utf8');

    expect(sheet).toContain('panelStyle={styles.pickerMotion}');
    expect(source).toContain("pickerMotion: { maxHeight: '72%', width: '100%' }");
    expect(source).toContain("pickerSheet: { borderTopLeftRadius: 28, borderTopRightRadius: 28, flexShrink: 1, gap: 11, maxHeight: '100%', minHeight: 0");
    expect(glassPanelSource).toContain('{ borderRadius: radius, flexShrink: 1, minHeight: 0 }');
  });
});
