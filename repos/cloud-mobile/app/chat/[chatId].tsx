import { useLocalSearchParams } from 'expo-router';
import { Text, View } from 'react-native';
import type { JSX } from 'react';
import { useEffect } from 'react';

import ChatScreen, { parseChatRouteParam } from '../../src/features/chat/ChatScreen';
import { useCloudActions } from '../../src/features/runtime/CloudRuntimeProvider';

export default function ChatRoute(): JSX.Element {
  const { chatId: rawChatId } = useLocalSearchParams<{ chatId: string }>();
  const actions = useCloudActions();
  const chatUri = parseChatRouteParam(rawChatId);

  useEffect(() => {
    if (chatUri !== undefined) void actions.subscribeChat(chatUri);
  }, [actions, chatUri]);

  if (chatUri === undefined) return <View><Text>无效的对话地址</Text></View>;
  return <ChatScreen chatUri={chatUri} />;
}
