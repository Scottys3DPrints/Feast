const { withAppBuildGradle, withGradleProperties } = require('expo/config-plugins');

/**
 * Pins the NDK to a version that is actually installed on this machine.
 *
 * React Native 0.86 asks for NDK 27.1.12297006. When that exact revision is missing,
 * the Android Gradle Plugin tries to auto-install it — and if that download fails it
 * leaves behind an EMPTY directory at ndk/27.1.12297006. Gradle then sees the folder,
 * believes the NDK is present, and fails during configuration with
 * `InstallFailedException` roughly ten minutes into every build. Deleting the stub does
 * not help while the download itself cannot complete.
 *
 * 27.0.12077973 is the same NDK major release (r27) and is fully installed, so the
 * toolchain and ABI expectations match. This is a workaround for a broken local SDK
 * install, not a correction to React Native: if `sdkmanager` is ever able to fetch
 * 27.1.12297006, delete this plugin and let the default apply again.
 *
 * Set both the Gradle property (which expo-modules-core reads) and the literal in
 * app/build.gradle (which is what actually configures the Android extension), because
 * `rootProject.ext.ndkVersion` is computed by a compiled plugin and overriding only the
 * property is not reliable.
 */
const NDK_VERSION = process.env.FEAST_NDK_VERSION ?? '27.0.12077973';

const withNdkVersion = (config) => {
  config = withGradleProperties(config, (cfg) => {
    const properties = cfg.modResults.filter(
      (item) => !(item.type === 'property' && item.key === 'ndkVersion'),
    );
    properties.push({ type: 'property', key: 'ndkVersion', value: NDK_VERSION });
    cfg.modResults = properties;
    return cfg;
  });

  return withAppBuildGradle(config, (cfg) => {
    cfg.modResults.contents = cfg.modResults.contents.replace(
      /ndkVersion\s+rootProject\.ext\.ndkVersion/,
      `ndkVersion "${NDK_VERSION}" // pinned by plugins/withNdkVersion.js`,
    );
    return cfg;
  });
};

module.exports = withNdkVersion;
