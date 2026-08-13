module.exports = function babelConfig(api) {
  api.cache(true);
  return {
    presets: [['babel-preset-expo', { unstable_transformImportMeta: true }]],
    plugins: [
      // ⚠️ MUST be last. Reanimated 4 delegates its worklet transform to
      // react-native-worklets, and the plugin rewrites function bodies — anything
      // registered after it sees already-transformed output. (§4.8)
      'react-native-worklets/plugin',
    ],
  };
};
