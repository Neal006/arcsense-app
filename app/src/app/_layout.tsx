import { Tabs } from 'expo-router/js-tabs';
import { StatusBar } from 'expo-status-bar';

import { getAppServices } from '@/state/bootstrap';
import { ServicesProvider } from '@/state/ServicesContext';
import { colors } from '@/ui/theme';

const services = getAppServices();

export default function RootLayout() {
  return (
    <ServicesProvider services={services}>
      <StatusBar style="light" />
      <Tabs
        screenOptions={{
          headerStyle: { backgroundColor: colors.bg },
          headerTintColor: colors.text,
          tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.border },
          tabBarActiveTintColor: colors.accent,
          tabBarInactiveTintColor: colors.textDim,
        }}
      >
        <Tabs.Screen name="index" options={{ title: 'Connect' }} />
        <Tabs.Screen name="session" options={{ title: 'Session' }} />
        <Tabs.Screen name="history" options={{ title: 'History' }} />
        <Tabs.Screen name="debug" options={{ title: 'Debug' }} />
      </Tabs>
    </ServicesProvider>
  );
}
