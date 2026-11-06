import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import * as Haptics from 'expo-haptics';
import { Tabs } from 'expo-router/js-tabs';
import { StatusBar } from 'expo-status-bar';
import type { ComponentProps } from 'react';
import type { ColorValue } from 'react-native';

import { watchFreezeOnset } from '@/services/AlertEngine';
import { getAppServices } from '@/state/bootstrap';
import { ServicesProvider } from '@/state/ServicesContext';
import { colors } from '@/ui/theme';

type IconName = ComponentProps<typeof MaterialCommunityIcons>['name'];

const tabIcon = (name: IconName) => {
  function TabIcon({ color, size }: { color: ColorValue; size: number }) {
    return <MaterialCommunityIcons name={name} color={color as string} size={size} />;
  }
  return TabIcon;
};

const services = getAppServices();

// Haptic warning when a freezing episode starts, whatever screen is open.
watchFreezeOnset(services.acquisition.alerts, () => {
  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
});

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
        <Tabs.Screen
          name="index"
          options={{ title: 'Connect', tabBarIcon: tabIcon('bluetooth-connect') }}
        />
        <Tabs.Screen
          name="session"
          options={{ title: 'Session', tabBarIcon: tabIcon('record-circle-outline') }}
        />
        <Tabs.Screen
          name="dashboard"
          options={{ title: 'Live', tabBarIcon: tabIcon('chart-line') }}
        />
        <Tabs.Screen
          name="bilateral"
          options={{ title: 'L vs R', tabBarIcon: tabIcon('compare-horizontal') }}
        />
        <Tabs.Screen
          name="history"
          options={{ title: 'History', tabBarIcon: tabIcon('history') }}
        />
        <Tabs.Screen
          name="debug"
          options={{ title: 'Debug', tabBarIcon: tabIcon('wrench-outline') }}
        />
      </Tabs>
    </ServicesProvider>
  );
}
