/**
 * React Native autolinking overrides for this app (read by Expo's autolinking and the RN CLI).
 *
 * onnxruntime-react-native 1.24.3 ships a `unimodule.json` that declares Android but no
 * `react-native.config.js`. Expo's React Native autolinking therefore skips the package on
 * Android (an Expo-module config plus a gradle file is treated as "linked by Expo modules"),
 * while Expo-modules autolinking only includes its gradle project and registers no package.
 * Result: OnnxruntimePackage is missing from PackageList, NativeModules.Onnxruntime is null,
 * and the package's JS binding crashes with "Cannot read property 'install' of null".
 *
 * This supplies the same Android config that upstream added to the package itself
 * (microsoft/onnxruntime#28266, not in any npm release yet). Remove it once the installed
 * onnxruntime-react-native ships its own react-native.config.js.
 */
module.exports = {
  dependencies: {
    "onnxruntime-react-native": {
      platforms: {
        android: {
          packageImportPath: "import ai.onnxruntime.reactnative.OnnxruntimePackage;",
          packageInstance: "new OnnxruntimePackage()",
        },
      },
    },
  },
};
