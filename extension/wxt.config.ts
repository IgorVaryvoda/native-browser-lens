import { defineConfig } from 'wxt';
import { DEV_KEY } from './src/dev-key';

export default defineConfig({
  srcDir: 'src',
  manifestVersion: 3,
  modules: ['@wxt-dev/module-react'],
  manifest: ({ browser }) => {
    const firefox = browser === 'firefox';
    return {
      name: 'Sirv Lens',
      description: 'Capture browser defects with their evidence, review them, and file them.',
      permissions: [
        'nativeMessaging',
        'storage',
        'tabs',
        'scripting',
        'activeTab',
        ...(firefox ? ['webRequest'] : ['sidePanel', 'debugger', 'favicon']),
      ],
      // Lens reads a site only after the person grants that exact origin from the side panel.
      optional_host_permissions: ['http://*/*', 'https://*/*'],
      // The end-to-end build pre-grants the local fixture origin: a test cannot click Chrome's prompt.
      ...(process.env.LENS_E2E ? { host_permissions: ['http://127.0.0.1/*'] } : {}),
      action: { default_title: 'Open Lens' },
      commands: {
        capture: {
          suggested_key: { default: 'Alt+Shift+L' },
          description: 'Capture the page with its evidence',
        },
      },
      // The key pins the unpacked development ID that `lens register` allows. Store builds drop it.
      ...(firefox
        ? {
            browser_specific_settings: {
              gecko: {
                id: 'lens@sirv.studio',
                strict_min_version: '140.0',
                data_collection_permissions: { required: ['none'] },
              },
            },
          }
        : { key: DEV_KEY }),
    };
  },
});
