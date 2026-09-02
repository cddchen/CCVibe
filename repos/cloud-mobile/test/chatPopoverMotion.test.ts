import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const projectRoot = path.resolve(__dirname, '..');

describe('Chat command popover motion contract', () => {
  it('mounts the scrim independently and keeps the panel out of the Modal fade', () => {
    const source = fs.readFileSync(path.join(projectRoot, 'src/features/chat/ChatScreen.tsx'), 'utf8');
    const start = source.indexOf('function ComposerCommandPopover');
    const end = source.indexOf('function CommandRow', start);
    const component = source.slice(start, end);

    expect(component).toContain('<BottomSheetFrame');
    expect(component).not.toContain('<Modal animationType="fade"');
    expect(component).toContain('enterDelayMs={BOTTOM_SHEET_BACKDROP_DURATION_MS}');
  });

  it('starts the command panel no earlier than the completed backdrop fade', () => {
    const source = fs.readFileSync(path.join(projectRoot, 'src/ui/motion/BottomSheetMotion.tsx'), 'utf8');

    expect(source).toContain('BOTTOM_SHEET_BACKDROP_DURATION_MS = 160');
    expect(source).toContain('FadeIn.duration(BOTTOM_SHEET_BACKDROP_DURATION_MS)');
    expect(source).toContain('props.enterDelayMs ?? BOTTOM_SHEET_BACKDROP_DURATION_MS');
    expect(source).toContain('BOTTOM_SHEET_EXIT_DURATION_MS + MODAL_UNMOUNT_GRACE_MS');
  });

  it('uses immediate bottom scrolling so stream growth has no animation lifecycle race', () => {
    const source = fs.readFileSync(path.join(projectRoot, 'src/features/chat/ChatScreen.tsx'), 'utf8');
    expect(source).toContain('scrollToEnd({ animated: false })');
    expect(source).not.toContain('programmaticScrollRef');
  });

  it('dismisses the composer keyboard before opening a sheet outside its avoiding view', () => {
    const source = fs.readFileSync(path.join(projectRoot, 'src/features/chat/ChatScreen.tsx'), 'utf8');
    expect(source).toContain('Keyboard.dismiss();');
    expect(source).toContain("setConfigPicker('model')");
    expect(source).toContain("setConfigPicker('effort')");
  });

  it('cancels a pending command-to-permission transition when the command sheet is reopened or closed', () => {
    const source = fs.readFileSync(path.join(projectRoot, 'src/features/chat/ChatScreen.tsx'), 'utf8');
    expect(source).toContain('BOTTOM_SHEET_DISMISS_MS + 16');
    expect(source).toContain('commandTransitionTimerRef.current = undefined');
    expect(source).toContain('onClose={closeComposerMenus}');
  });
});
