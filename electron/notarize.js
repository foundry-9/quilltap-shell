const { spawnSync } = require('child_process');
const { notarize } = require('@electron/notarize');

exports.default = async function afterSign(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;

  // When the unsigned-fallback path in build-electron.ts is active it sets
  // CSC_IDENTITY_AUTO_DISCOVERY=false and unsets the Apple API key vars; the
  // build is being ad-hoc signed via `-c.mac.identity=-`. electron-builder's
  // own ad-hoc pass leaves the nested Electron Framework in a state that
  // `codesign --verify --deep --strict` accepts but macOS 15+ dyld refuses to
  // map (it still sees a Team ID delta between outer and framework and aborts
  // with "non-platform have different Team IDs"). A forced deep ad-hoc resign
  // here, before electron-builder produces the .dmg / .zip, brings every
  // nested Mach-O into agreement.
  if (process.env.CSC_IDENTITY_AUTO_DISCOVERY === 'false') {
    console.log(`Deep ad-hoc resigning ${appPath} to harmonize nested signatures...`);
    const result = spawnSync('codesign', ['--force', '--deep', '--sign', '-', appPath], {
      stdio: 'inherit',
    });
    if (result.status !== 0) {
      throw new Error(`codesign --force --deep --sign - exited with status ${result.status}`);
    }
    console.log('Deep ad-hoc resign complete.');
    return;
  }

  if (!process.env.APPLE_API_KEY || !process.env.APPLE_API_KEY_ID || !process.env.APPLE_API_KEY_ISSUER) {
    console.log('Skipping notarization: APPLE_API_KEY, APPLE_API_KEY_ID, or APPLE_API_KEY_ISSUER not set');
    return;
  }

  console.log(`Notarizing ${appPath}...`);

  await notarize({
    appPath,
    appleApiKey: process.env.APPLE_API_KEY,
    appleApiKeyId: process.env.APPLE_API_KEY_ID,
    appleApiIssuer: process.env.APPLE_API_KEY_ISSUER,
  });

  console.log('Notarization complete!');
};
