import { registerRootComponent } from 'expo';

import App from './App';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);

if (__DEV__) {
  // Dev builds only: on-device pipeline conformance run, a no-op unless the host script
  // requested one (tools/device_conformance/README.md).
  require('./tools/device_conformance/appRunner').runIfRequested();
}
