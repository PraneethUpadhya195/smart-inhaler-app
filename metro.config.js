// Learn more: https://docs.expo.dev/guides/customizing-metro/
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// Firebase v10+ (including v11 and v12) ships its React Native bundle via
// package.json "exports" conditions. Without this flag, Metro falls back to
// the browser bundle, which breaks getAuth() and other Firebase APIs on device.
config.resolver.unstable_enablePackageExports = true;
config.resolver.assetExts.push('onnx');

module.exports = config;
