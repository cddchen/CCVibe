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
    expect(component).not.toContain('enterDelayMs=');
  });

  it('starts the command panel no earlier than the completed backdrop fade', () => {
    const source = fs.readFileSync(path.join(projectRoot, 'src/ui/motion/BottomSheetMotion.tsx'), 'utf8');

    expect(source).toContain('BOTTOM_SHEET_BACKDROP_DURATION_MS = 160');
    expect(source).toContain('FadeIn.duration(BOTTOM_SHEET_BACKDROP_DURATION_MS)');
    expect(source).toContain('onEnterComplete');
    expect(source).toContain('handleBackdropEnterComplete');
    expect(source).toContain('setPanelMounted(true)');
    expect(source).toContain('const [panelMounted, setPanelMounted] = useState(false)');
    expect(source).toContain('const [backdropMounted, setBackdropMounted] = useState(false)');
    expect(source).toContain('key={`panel-${motionCycle}`}');
    expect(source).toContain('advanceMotionCycle();');
    expect(source).not.toContain('enterDelayMs');
    expect(source).toContain('FadeOut.duration(BOTTOM_SHEET_EXIT_DURATION_MS)');
    expect(source).toContain('onExitComplete');
    expect(source).not.toContain('MODAL_UNMOUNT_GRACE_MS');
  });

  it('uses an exact immediate offset so the composer-reserved padding remains visible', () => {
    const source = fs.readFileSync(path.join(projectRoot, 'src/features/chat/ChatScreen.tsx'), 'utf8');
    expect(source).toContain('chatBottomOffset(scrollMetricsRef.current)');
    expect(source).toContain('scrollToOffset({ offset, animated: false })');
    expect(source).not.toContain('scrollToEnd({ animated: false })');
  });

  it('gives asynchronously loaded commands a stable, readable sheet surface', () => {
    const source = fs.readFileSync(path.join(projectRoot, 'src/features/chat/ChatScreen.tsx'), 'utf8');
    const start = source.indexOf('function ComposerCommandPopover');
    const end = source.indexOf('function CommandRow', start);
    const component = source.slice(start, end);

    expect(component).toContain('panelStyle={styles.commandPopoverMotion}');
    expect(component).toContain('containerStyle={styles.commandPopoverContainer}');
    expect(component).not.toContain('forceSolid');
    expect(component).not.toContain('solidColor={theme.colors.surface}');
    expect(component).not.toContain('materialTone="surfaceContainerLowest"');
    expect(component).toContain('blurIntensity={82}');
    expect(component).toContain('glassEffectStyle="regular"');
    expect(component).toContain('materialElevation={5}');
    expect(component).toContain('materialShape="extraLarge"');
    expect(component).toContain('style={styles.commandScroll}');
    expect(source).toContain("commandPopoverMotion: { height: '72%'");
  });

  it('lets the GlassSurface content layer provide a viewport for the command list', () => {
    const source = fs.readFileSync(path.join(projectRoot, 'src/ui/glass/GlassSurface.tsx'), 'utf8');
    const start = source.indexOf('contentLayer: {');
    const end = source.indexOf('\n  },', start);
    const contentLayer = source.slice(start, end);

    expect(contentLayer).toContain('flexGrow: 1');
  });

  it('dismisses the composer keyboard before opening a sheet outside its avoiding view', () => {
    const source = fs.readFileSync(path.join(projectRoot, 'src/features/chat/ChatScreen.tsx'), 'utf8');
    expect(source).toContain('Keyboard.dismiss();');
    expect(source).toContain("setConfigPicker('model')");
    expect(source).toContain("setConfigPicker('effort')");
  });

  it('cancels a pending command-to-permission transition when the command sheet is reopened or closed', () => {
    const source = fs.readFileSync(path.join(projectRoot, 'src/features/chat/ChatScreen.tsx'), 'utf8');
    expect(source).toContain('pendingPermissionPickerRef.current = false');
    expect(source).toContain('handleComposerPopoverDismissed');
    expect(source).toContain('onClose={closeComposerMenus}');
  });

  it('hands a permission transition to native modal dismissal instead of a guessed timer', () => {
    const motionSource = fs.readFileSync(path.join(projectRoot, 'src/ui/motion/BottomSheetMotion.tsx'), 'utf8');
    const screenSource = fs.readFileSync(path.join(projectRoot, 'src/features/chat/ChatScreen.tsx'), 'utf8');

    expect(motionSource).toContain('onDismiss={notifyDismissed}');
    expect(motionSource).toContain('visible={modalVisible}');
    expect(motionSource).toContain('setModalVisible(false)');
    expect(motionSource).toContain('if (dismissalPendingRef.current)');
    expect(motionSource).toContain('notifyDismissed() will reopen it after completion');
    expect(motionSource).not.toContain('setTimeout');
    expect(screenSource).toContain('onDismiss={handleComposerPopoverDismissed}');
    expect(screenSource).not.toContain('BOTTOM_SHEET_DISMISS_MS + 16');
  });

  it('uses the same dismissal handoff for approval and structured input replacement', () => {
    const motionSource = fs.readFileSync(path.join(projectRoot, 'src/ui/motion/BottomSheetMotion.tsx'), 'utf8');
    const screenSource = fs.readFileSync(path.join(projectRoot, 'src/features/chat/ChatScreen.tsx'), 'utf8');

    expect(motionSource).toContain("Platform.OS !== 'ios'");
    expect(screenSource).toContain('requestSheetClosingRef');
    expect(screenSource).toContain('onDismiss={handleApprovalSheetDismissed}');
    expect(screenSource).toContain('onDismiss={handleInputSheetDismissed}');
    expect(screenSource).not.toContain('requestSheetTimerRef');
  });
});
