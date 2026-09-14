import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useRouter } from 'expo-router';
import type { JSX } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text, useTheme, type MD3Theme } from 'react-native-paper';

import { CLOUD_DESIGN_TOKENS } from '../../ui/theme/cloudTheme';

export default function HelpScreen(): JSX.Element {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const theme = useTheme<MD3Theme>();

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.colors.background }]}>
      <View style={styles.header}>
        <Pressable
          accessibilityLabel="返回设置"
          accessibilityRole="button"
          onPress={() => router.back()}
          style={({ pressed }) => [
            styles.backButton,
            { backgroundColor: theme.colors.surface },
            pressed && styles.pressed,
          ]}
          testID="help-back"
        >
          <MaterialCommunityIcons color={theme.colors.onBackground} name="chevron-left" size={29} />
        </Pressable>
        <Text allowFontScaling style={[styles.headerTitle, { color: theme.colors.onBackground }]}>帮助</Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: Math.max(insets.bottom, 28) }]}
        showsVerticalScrollIndicator={false}
      >
        <Text allowFontScaling style={[styles.title, { color: theme.colors.onBackground }]}>连接 Cloud Host</Text>
        <Text allowFontScaling style={[styles.intro, { color: theme.colors.onSurfaceVariant }]}>Cloud 手机端连接运行在另一台电脑上的 Agent Host。先在服务端电脑启动 Host，再把地址和 Token 填入 Cloud。</Text>

        <GuideStep number="1" title="准备服务端电脑" theme={theme}>
          <Text allowFontScaling style={[styles.body, { color: theme.colors.onSurface }]}>在服务端电脑安装 Node.js 22+（即 22 或更高版本），并完成 Claude Code / Claude Agent SDK 所需的本机登录和配置。手机端不运行 Agent、不直接读取配置；Host/SDK 使用服务端电脑上的 Claude Code 配置（包括可用 MCP/skills）。</Text>
        </GuideStep>

        <GuideStep number="2" title="启动 Cloud Agent Host" theme={theme}>
          <Text allowFontScaling style={[styles.body, { color: theme.colors.onSurface }]}>在服务端电脑的终端运行下面的命令：</Text>
          <CopyableBlock label="启动命令" value="npx @cddchen/cloud@latest start --global" theme={theme} testID="help-start-command" />
          <Text allowFontScaling style={[styles.body, { color: theme.colors.onSurface }]}>start 默认在后台运行，默认监听 8787 端口。启动输出会显示可连接地址和生成的 Token；也可以显式设置自己的 Token：</Text>
          <CopyableBlock label="自定义 Token" value="npx @cddchen/cloud@latest start --global --token=replace-with-a-high-entropy-token" theme={theme} testID="help-token-command" />
          <Text allowFontScaling style={[styles.note, { color: theme.colors.onSurfaceVariant }]}>请保存终端输出的地址和 Token。页面中的命令、地址都可以长按选择并复制。</Text>
        </GuideStep>

        <GuideStep number="3" title="查看或停止后台 Host" theme={theme}>
          <CopyableBlock label="查看状态和连接信息" value="npx @cddchen/cloud@latest status" theme={theme} testID="help-status-command" />
          <CopyableBlock label="停止后台 Host" value="npx @cddchen/cloud@latest stop" theme={theme} testID="help-stop-command" />
        </GuideStep>

        <GuideStep number="4" title="在 Cloud 中填写连接信息" theme={theme}>
          <Text allowFontScaling style={[styles.body, { color: theme.colors.onSurface }]}>服务端电脑和手机在同一受信局域网时，直接使用启动输出的地址。在不开放公网端口时，可以在两台设备都安装并加入同一个 Tailscale 或 WireGuard 加密组网，然后在 Cloud 的 Host 中填写形如 http://&lt;组网 IP&gt;:&lt;端口&gt; 的地址：</Text>
          <CopyableBlock label="组网地址格式" value="http://xxx:yyy" theme={theme} testID="help-network-url-format" />
          <CopyableBlock label="组网地址示例" value="http://100.64.0.2:8787" theme={theme} testID="help-network-url" />
          <Text allowFontScaling style={[styles.body, { color: theme.colors.onSurface }]}>如果 Host 使用了其他端口，把 8787 换成实际端口。Token 单独填写在 Token 输入框中。</Text>
          <Text allowFontScaling style={[styles.warning, { color: theme.colors.error }]}>不要把 Token 拼进 URL，也不要填写类似 `?token=...` 的查询参数。</Text>
        </GuideStep>

        <GuideStep number="5" title="公网部署的安全要求" theme={theme}>
          <Text allowFontScaling style={[styles.body, { color: theme.colors.onSurface }]}>如果必须通过公网连接，请在 Host 前配置 TLS 反向代理，并使用高熵 Bearer Token。Cloud 中填写 HTTPS/WSS 地址，例如：</Text>
          <CopyableBlock label="公网地址示例" value="https://<域名> 或 wss://<域名>" theme={theme} testID="help-public-url" />
          <Text allowFontScaling style={[styles.note, { color: theme.colors.onSurfaceVariant }]}>Tailscale 和 WireGuard 需要你自行完成安装、登录和组网；Cloud 不会自动配置 VPN、扫描 Host 或提供中继服务。</Text>
        </GuideStep>
      </ScrollView>
    </SafeAreaView>
  );
}

interface GuideStepProps {
  readonly number: string;
  readonly title: string;
  readonly theme: MD3Theme;
  readonly children: JSX.Element | JSX.Element[];
}

function GuideStep(props: GuideStepProps): JSX.Element {
  return (
    <View style={[styles.step, { borderColor: props.theme.colors.outlineVariant }]}>
      <View style={[styles.stepNumber, { backgroundColor: props.theme.colors.primaryContainer }]}>
        <Text allowFontScaling style={[styles.stepNumberText, { color: props.theme.colors.primary }]}>{props.number}</Text>
      </View>
      <View style={styles.stepBody}>
        <Text allowFontScaling style={[styles.stepTitle, { color: props.theme.colors.onSurface }]}>{props.title}</Text>
        {props.children}
      </View>
    </View>
  );
}

interface CopyableBlockProps {
  readonly label: string;
  readonly value: string;
  readonly theme: MD3Theme;
  readonly testID: string;
}

function CopyableBlock(props: CopyableBlockProps): JSX.Element {
  return (
    <View style={[styles.codeBlock, { backgroundColor: props.theme.colors.surfaceVariant }]} testID={props.testID}>
      <Text allowFontScaling style={[styles.codeLabel, { color: props.theme.colors.onSurfaceVariant }]}>{props.label}</Text>
      <Text allowFontScaling selectable style={[styles.codeText, { color: props.theme.colors.onSurface, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' }]}>{props.value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  header: {
    minHeight: 58,
    paddingHorizontal: CLOUD_DESIGN_TOKENS.spacingPage,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  backButton: {
    width: CLOUD_DESIGN_TOKENS.minTouchTarget,
    height: CLOUD_DESIGN_TOKENS.minTouchTarget,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: CLOUD_DESIGN_TOKENS.minTouchTarget / 2,
  },
  headerSpacer: { width: CLOUD_DESIGN_TOKENS.minTouchTarget, height: CLOUD_DESIGN_TOKENS.minTouchTarget },
  headerTitle: { fontSize: 20, lineHeight: 26, fontWeight: '700' },
  pressed: { opacity: 0.68 },
  content: {
    paddingHorizontal: CLOUD_DESIGN_TOKENS.spacingPage,
    paddingTop: 12,
    gap: 18,
  },
  title: { fontSize: 30, lineHeight: 36, fontWeight: '800', letterSpacing: -0.8 },
  intro: { fontSize: 15, lineHeight: 23 },
  step: {
    paddingTop: 18,
    paddingBottom: 18,
    paddingHorizontal: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 20,
    flexDirection: 'row',
    gap: 12,
  },
  stepNumber: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center', borderRadius: 12 },
  stepNumberText: { fontSize: 15, lineHeight: 20, fontWeight: '800' },
  stepBody: { flex: 1, minWidth: 0, gap: 10 },
  stepTitle: { fontSize: 17, lineHeight: 23, fontWeight: '700' },
  body: { fontSize: 14, lineHeight: 22 },
  note: { fontSize: 12, lineHeight: 19 },
  warning: { fontSize: 13, lineHeight: 20, fontWeight: '600' },
  codeBlock: { paddingHorizontal: 12, paddingVertical: 10, borderRadius: 12, gap: 5 },
  codeLabel: { fontSize: 11, lineHeight: 16, fontWeight: '600' },
  codeText: { fontSize: 13, lineHeight: 20, fontFamily: 'Menlo' },
});
