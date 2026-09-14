import { useLocalSearchParams, useNavigation } from 'expo-router';
import { Text, View } from 'react-native';
import type { JSX } from 'react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ParamListBase } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';

import ChatScreen, { parseChatRouteParam } from '../../src/features/chat/ChatScreen';
import { useCloudActions, useCloudSelector } from '../../src/features/runtime/CloudRuntimeProvider';

type ChatNavigation = NativeStackNavigationProp<ParamListBase>;

export default function ChatRoute(): JSX.Element {
  const { chatId: rawChatId } = useLocalSearchParams<{ chatId: string }>();
  const actions = useCloudActions();
  const syncStatus = useCloudSelector((state) => state.sync.status);
  const navigation = useNavigation<ChatNavigation>();
  const chatUri = parseChatRouteParam(rawChatId);
  const navigationReadyRef = useRef(false);
  const [navigationReady, setNavigationReady] = useState(false);

  useLayoutEffect(() => {
    // Keep this route-level completion across chatId changes: a param update
    // reuses the focused native screen and does not emit another transition.
    if (navigationReadyRef.current) setNavigationReady(true);
    return navigation.addListener('transitionEnd', (event) => {
      if (!event.data.closing && navigation.isFocused()) {
        navigationReadyRef.current = true;
        setNavigationReady(true);
      }
    });
  }, [navigation]);

  useEffect(() => {
    // Navigation must mount immediately; subscription starts only once the
    // current Host is connected and repeats when a reconnect returns to
    // connected. Projection waits for native-stack transitionEnd below.
    if (chatUri !== undefined && syncStatus === 'connected') void actions.subscribeChat(chatUri);
  }, [actions, chatUri, syncStatus]);

  if (chatUri === undefined) return <View><Text>无效的对话地址</Text></View>;
  return <ChatScreen chatUri={chatUri} navigationReady={navigationReady} />;
}
