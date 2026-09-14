import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { copyMessageText } from '../src/features/chat/messageClipboard';

const projectRoot = path.resolve(__dirname, '..');
const screenSource = fs.readFileSync(path.join(projectRoot, 'src/features/chat/ChatScreen.tsx'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
};
const packageLock = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package-lock.json'), 'utf8')) as {
  packages?: Record<string, { version?: string }>;
};
const appJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'app.json'), 'utf8')) as {
  expo?: { plugins?: unknown[] };
};
const rendererPatchPath = path.join(projectRoot, 'patches/react-native-enriched-markdown+0.5.0.patch');
const rendererPatchSource = fs.existsSync(rendererPatchPath)
  ? fs.readFileSync(rendererPatchPath, 'utf8')
  : '';
const rendererAddedSource = rendererPatchSource
  .split('\n')
  .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
  .join('\n');
const nestedCodeMarkdownFixture = [
  '2. outer item',
  '   - nested item',
  '     ```json',
  '     {"ok":true}',
  '     ```',
  '   - next nested item',
  '     ```text',
  '     output from the tool',
  '     ```',
  '3. following item',
  '',
  'inline `const answer = 42` code',
].join('\n');
const inlineCodeGeometryMarkdownFixture = [
  '前文 `短代码` 后文',
  '`行首` 普通文本 `行尾`',
  '窄宽 `very-long-code-span-that-wraps-across-visual-lines` suffix',
  '# 标题 `标题代码`',
  '- 列表 **粗体** `中文🧪` suffix',
  '> 引用 `quote code`',
  '',
  '```text',
  'one line',
  '```',
  '',
  '```text',
  'first line',
  'second line',
  '```',
].join('\n');
const githubTableMarkdownFixture = [
  '和分支 A 的差别：',
  '',
  '| | 工具结果回来（B） | 对完话再发一句（A） |',
  '|---|---|---|',
  '| 触发 | 尾部 user 有 `tool_result` | 尾部没有 |',
  '| 上游身份 | 复用 pending 的 session/cascade/step+1 | 全新，step=0 |',
  '| 历史 | pending 里的原生 contents + 原样 FC/FR | 只有文本；工具轮细节没有 |',
  '| system | 首轮那份，不重建 | 从这次请求重建 |',
  '| pending | 必须命中，否则 400 | 不查 Map |',
  '',
  '## 你作为用户会感觉到的缺口',
  '',
  '新提问时模型看不到上一轮工具调用的原始输出，只能看到当时生成的文本结论。',
].join('\n');

describe('completed assistant enriched markdown contract', () => {
  it('pins the native renderer and configures its math dependency off', () => {
    expect(packageJson.dependencies?.['react-native-enriched-markdown']).toBe('0.5.0');
    expect(packageLock.packages?.['node_modules/react-native-enriched-markdown']?.version).toBe('0.5.0');
    expect(packageLock.packages?.['node_modules/katex']).toBeUndefined();

    const plugin = appJson.expo?.plugins?.find((entry): entry is [string, { enableMath?: boolean }] => (
      Array.isArray(entry) && entry[0] === 'react-native-enriched-markdown'
    ));
    expect(plugin?.[1].enableMath).toBe(false);
    const podfileSource = fs.readFileSync(path.join(projectRoot, 'ios/Podfile'), 'utf8');
    const gradlePropertiesSource = fs.readFileSync(path.join(projectRoot, 'android/gradle.properties'), 'utf8');
    expect(podfileSource).toContain('# react-native-enriched-markdown@0.5.0: math is intentionally disabled');
    expect(podfileSource).toContain("ENV['ENRICHED_MARKDOWN_ENABLE_MATH'] = '0'");
    expect(gradlePropertiesSource).toContain('# react-native-enriched-markdown@0.5.0: math is intentionally disabled');
    expect(gradlePropertiesSource).toContain('enrichedMarkdown.enableMath=false');
  });

  it('applies the upstream nested list/code-block renderer fix reproducibly', () => {
    expect(packageJson.scripts?.postinstall).toBe('patch-package');
    expect(packageJson.devDependencies?.['patch-package']).toBe('8.0.1');
    expect(fs.existsSync(rendererPatchPath)).toBe(true);
    expect(rendererPatchSource).toContain('ListItemRenderer.m');
    expect(rendererPatchSource).toContain('skipRanges');
    expect(rendererPatchSource).toContain('CodeBlockAttributeName');
    expect(rendererPatchSource).toContain('ListDepthAttribute');
    expect(rendererPatchSource).toContain('CodeBlockIndentAttributeName');
    expect(rendererPatchSource).toContain('targetIndent = MAX(previousIndent, totalIndent)');
    expect(rendererPatchSource).toContain('firstLineHeadIndent += additionalIndent');
    expect(rendererPatchSource).toContain('availableWidth = textContainer.size.width - indent');
  });

  it('keeps completed answers selectable while using the GitHub renderer', () => {
    expect(screenSource).toContain("import { EnrichedMarkdownText } from 'react-native-enriched-markdown';");
    expect(screenSource).toContain('<EnrichedMarkdownText');
    expect(screenSource).toContain('flavor="github"');
    expect(screenSource).toContain('selectable');
    expect(screenSource).toContain('md4cFlags={assistantMarkdownMd4cFlags}');
    expect(screenSource).toContain('const assistantMarkdownMd4cFlags = { underline: false, latexMath: false }');
    expect(screenSource).not.toContain('flavor="commonmark"');
  });

  it('keeps a legal GFM table boundary with the following heading', () => {
    const lines = githubTableMarkdownFixture.split('\n');
    const header = '| | 工具结果回来（B） | 对完话再发一句（A） |';
    const separator = '|---|---|---|';
    const heading = '## 你作为用户会感觉到的缺口';
    const headerIndex = lines.indexOf(header);
    const separatorIndex = lines.indexOf(separator);
    const headingIndex = lines.indexOf(heading);

    expect(headerIndex).toBeGreaterThan(-1);
    expect(separatorIndex).toBe(headerIndex + 1);
    expect(separator).toMatch(/^\|(?:---\|){3}$/);
    expect(lines.slice(headerIndex, headingIndex)).toEqual([
      header,
      separator,
      '| 触发 | 尾部 user 有 `tool_result` | 尾部没有 |',
      '| 上游身份 | 复用 pending 的 session/cascade/step+1 | 全新，step=0 |',
      '| 历史 | pending 里的原生 contents + 原样 FC/FR | 只有文本；工具轮细节没有 |',
      '| system | 首轮那份，不重建 | 从这次请求重建 |',
      '| pending | 必须命中，否则 400 | 不查 Map |',
      '',
    ]);
    expect(headingIndex).toBeGreaterThan(separatorIndex);
    expect(githubTableMarkdownFixture).toContain('新提问时模型看不到上一轮工具调用的原始输出');
  });

  it('keeps nested json/text fences and inline code in the markdown contract', () => {
    expect(nestedCodeMarkdownFixture).toMatch(/^2\. outer item\n {3}- nested item\n {5}```json\n/m);
    expect(nestedCodeMarkdownFixture).toMatch(/^ {3}- next nested item\n {5}```text\n/m);
    expect(nestedCodeMarkdownFixture).toMatch(/ {5}```\n3\. following item/m);
    expect(nestedCodeMarkdownFixture).toContain('inline `const answer = 42` code');
    expect(screenSource).toContain('markdown={content}');
  });

  it('keeps the iOS inline-code geometry fixtures covered', () => {
    expect(inlineCodeGeometryMarkdownFixture).toContain('前文 `短代码` 后文');
    expect(inlineCodeGeometryMarkdownFixture).toContain('`行首` 普通文本 `行尾`');
    expect(inlineCodeGeometryMarkdownFixture).toContain('suffix');
    expect(inlineCodeGeometryMarkdownFixture).toContain('# 标题 `标题代码`');
    expect(inlineCodeGeometryMarkdownFixture).toContain('- 列表 **粗体** `中文🧪` suffix');
    expect(inlineCodeGeometryMarkdownFixture).toContain('> 引用 `quote code`');
    expect(inlineCodeGeometryMarkdownFixture).toMatch(/```text\none line\n```/);
    expect(inlineCodeGeometryMarkdownFixture).toMatch(/```text\nfirst line\nsecond line\n```/);
  });

  it('uses the resolved code font metrics and exact per-line glyph ranges on iOS', () => {
    expect(rendererAddedSource).toContain('blockFont.pointSize');
    expect(rendererAddedSource).toContain('NSFontAttributeName');
    expect(rendererAddedSource).toContain('[layoutManager.textStorage attribute:NSFontAttributeName');
    expect(rendererAddedSource).not.toContain('[textStorage attribute:NSFontAttributeName');
    expect(rendererAddedSource).toContain('lineHeight');
    expect(rendererAddedSource).toContain('NSRange intersect = NSIntersectionRange');
    expect(rendererAddedSource).toContain('boundingRectForGlyphRange:intersect');
    expect(rendererAddedSource).toContain('locationForGlyphAtIndex:intersect.location');
    expect(rendererAddedSource).toContain('codeFont.ascender');
    expect(rendererAddedSource).toContain('fabs(codeFont.descender)');
    expect(rendererAddedSource).not.toContain('usedRect.origin.x + origin.x');
    expect(rendererAddedSource).not.toContain('findReferenceHeightForRange');
  });

  it('keeps Android selectable Markdown on the platform selection movement method', () => {
    expect(rendererPatchSource).toContain(
      'android/src/main/java/com/swmansion/enriched/markdown/utils/text/view/LinkLongPressMovementMethod.kt',
    );
    expect(rendererAddedSource).toContain('import android.text.method.ArrowKeyMovementMethod');
    expect(rendererAddedSource).toContain('class LinkLongPressMovementMethod : ArrowKeyMovementMethod()');
    expect(rendererAddedSource).toContain('private var pressedLink: LinkSpan? = null');
    expect(rendererAddedSource).toContain('pressedLink = findLinkSpan(widget, buffer, event)');
    expect(rendererAddedSource).toContain('tappedLink.onClick(widget)');
    expect(rendererAddedSource).toContain('isTouchWithinTextBounds');
    expect(rendererAddedSource).not.toContain('Selection.removeSelection');
    expect(rendererAddedSource).not.toContain('import android.text.method.LinkMovementMethod');
  });

  it('lets inline code inherit the parent text metrics', () => {
    const inlineCodeStyle = screenSource.slice(screenSource.indexOf('code: {'), screenSource.indexOf('codeBlock: {'));
    expect(inlineCodeStyle).toContain('backgroundColor: theme.colors.surfaceVariant');
    expect(inlineCodeStyle).toContain('borderColor: theme.colors.outlineVariant');
    expect(inlineCodeStyle).not.toContain('fontFamily');
    expect(inlineCodeStyle).not.toContain('fontSize');
  });

  it('removes external code-block margins that can become list marker paragraphs', () => {
    const codeBlockStyle = screenSource.slice(screenSource.indexOf('codeBlock: {'), screenSource.indexOf('blockquote: {'));
    expect(codeBlockStyle).toContain('fontSize: 13');
    expect(codeBlockStyle).toContain('lineHeight: 18');
    expect(codeBlockStyle).toContain('padding: 4');
    expect(codeBlockStyle).toContain('marginBottom: 0');
    expect(codeBlockStyle).toContain('marginTop: 0');
  });

  it('keeps streaming answers on the existing plain Text path', () => {
    const answerBranch = screenSource.slice(screenSource.indexOf('{answerParts.map('), screenSource.indexOf('{turn.status === \'failed\''));
    expect(answerBranch).toContain('turn.status === \'complete\'');
    expect(answerBranch).toContain('<StreamingAnswer');
    expect(answerBranch).toContain('<MarkdownAnswer');
    expect(screenSource).toContain('<Text selectable style={[styles.streamingText');
  });

  it('keeps the full raw assistant copy action and Unicode content intact', async () => {
    expect(screenSource).toContain('onPress={() => onCopy(content)}');
    expect(screenSource).toContain('markdown={content}');
    expect(screenSource).toContain('onLinkPress={({ url }) => { void Linking.openURL(url); }}');

    const content = '跨段落 **加粗** 链接 🔒 中文 emoji 👩‍💻';
    const copied: string[] = [];
    await copyMessageText(content, { setStringAsync: async (value) => { copied.push(value); } });
    expect(copied).toEqual([content]);
  });

  it('keeps virtualized long-message measurement settings in place', () => {
    expect(screenSource).toContain('onContentSizeChange={props.onContentSizeChange}');
    expect(screenSource).toContain('removeClippedSubviews={Platform.OS === \'android\'}');
    expect(screenSource).toContain('windowSize={7}');
  });
});
