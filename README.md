# Smart Inhaler App

A React Native (Expo) mobile application designed to connect with a Smart Inhaler (via BLE) to track usage, monitor battery, and provide real-time session logging. 

## 🏗️ Architecture

The application is structured into modular services to ensure maintainability and separation of concerns:

- **UI / Screens**: React Navigation is used to handle transitions between the Dashboard, Session Logs, Device Settings, etc.
- **Firebase Auth (`services/authService.js`)**: Handles anonymous user authentication so users can use the app without an account initially, while keeping data securely scoped.
- **Firestore Storage (`services/storageService.js`)**: Persists session data, device metadata (MAC address, battery level), and configuration settings.
- **BLE Simulation / Engine (`services/simulationService.js`)**: Currently handles simulated inhalation sessions for testing. This is architected to be swapped out seamlessly with actual BLE hardware.

## 🚀 Setup Instructions

### 1. Firebase Configuration
You need to connect this app to your own Firebase project.
1. Go to the [Firebase Console](https://console.firebase.google.com/) and create a new project.
2. Add a new **Web App** to your project to get your Firebase configuration object.
3. Enable **Firestore Database** in Native mode.
4. Enable **Authentication** and turn on the **Anonymous** sign-in method.
5. In your project, copy `firebase/example_config.js` to `firebase/config.js`:
   ```bash
   cp firebase/example_config.js firebase/config.js
   ```
6. Paste your Firebase credentials into `firebase/config.js`.

*(Note: `firebase/config.js` is added to `.gitignore` to prevent leaking your API keys.)*

### 2. Install Dependencies
Make sure you have Node.js installed, then run:
```bash
npm install
```

### 3. Run the App
To start the Expo development server:
```bash
npx expo start
```
- Press `a` to open in an Android Emulator.
- Press `i` to open in an iOS Simulator.
- Scan the QR code with the **Expo Go** app on your physical device.

## 🔮 Future Hardware Integration (ESP32 via BLE)

The application is currently using a `simulationService` to generate fake inhalation sessions. To integrate with the actual ESP32 hardware:

1. **Add BLE Library**: Install `react-native-ble-plx` or Expo's BLE module to enable Bluetooth Low Energy support.
2. **Replace Simulation**: Create a `bleService.js` that implements the same interface as `simulationService.js`.
3. **ESP32 Firmware**: Ensure your ESP32 broadcasts a specific BLE Service UUID and Characteristic UUIDs for:
   - Inhalation detection (Notify)
   - Battery level (Read/Notify)
   - Device status (Read)
4. **Permissions**: The app will need `BLUETOOTH_SCAN` and `BLUETOOTH_CONNECT` permissions requested at runtime for Android 12+, and `NSBluetoothAlwaysUsageDescription` for iOS.
