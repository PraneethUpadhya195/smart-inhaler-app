import React from "react";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { createStackNavigator } from "@react-navigation/stack";
import { Ionicons } from "@expo/vector-icons";

import DashboardScreen from "../screens/DashboardScreen";
import HistoryScreen from "../screens/HistoryScreen";
import SessionDetailScreen from "../screens/SessionDetailScreen";
import DeviceScreen from "../screens/DeviceScreen";
import SettingsScreen from "../screens/SettingsScreen";

import { COLORS } from "../utils/theme";

const Tab = createBottomTabNavigator();
const HistoryStack = createStackNavigator();

// ─── History Stack (History List + Session Detail) ────────────────────────────

function HistoryNavigator() {
  return (
    <HistoryStack.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: COLORS.surface },
        headerTintColor: COLORS.text,
        headerTitleStyle: { fontWeight: "bold" },
      }}
    >
      <HistoryStack.Screen
        name="HistoryList"
        component={HistoryScreen}
        options={{ title: "Session History" }}
      />
      <HistoryStack.Screen
        name="SessionDetail"
        component={SessionDetailScreen}
        options={{ title: "Session Detail" }}
      />
    </HistoryStack.Navigator>
  );
}

// ─── Tab Icon Helper ──────────────────────────────────────────────────────────

function tabIcon(name) {
  return ({ focused, color, size }) => (
    <Ionicons name={focused ? name : `${name}-outline`} size={size} color={color} />
  );
}

// ─── Bottom Tab Navigator ──────────────────────────────────────────────────────

export default function AppNavigator() {
  return (
    <Tab.Navigator
      screenOptions={{
        tabBarActiveTintColor: COLORS.primary,
        tabBarInactiveTintColor: COLORS.textMuted,
        tabBarStyle: {
          backgroundColor: COLORS.surface,
          borderTopColor: COLORS.border,
          paddingBottom: 6,
          height: 60,
        },
        headerStyle: { backgroundColor: COLORS.surface },
        headerTintColor: COLORS.text,
        headerTitleStyle: { fontWeight: "bold" },
      }}
    >
      <Tab.Screen
        name="Dashboard"
        component={DashboardScreen}
        options={{ tabBarIcon: tabIcon("home"), title: "Dashboard" }}
      />
      <Tab.Screen
        name="History"
        component={HistoryNavigator}
        options={{
          tabBarIcon: tabIcon("list"),
          title: "History",
          headerShown: false, // HistoryNavigator has its own header
        }}
      />
      <Tab.Screen
        name="Device"
        component={DeviceScreen}
        options={{ tabBarIcon: tabIcon("bluetooth"), title: "Device" }}
      />
      <Tab.Screen
        name="Settings"
        component={SettingsScreen}
        options={{ tabBarIcon: tabIcon("settings"), title: "Settings" }}
      />
    </Tab.Navigator>
  );
}
