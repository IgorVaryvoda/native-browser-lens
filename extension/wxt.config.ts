import { defineConfig } from 'wxt';
import { DEV_KEY } from './src/dev-key';

export default defineConfig({
  srcDir: 'src',
  manifestVersion: 3,
  modules: ['@wxt-dev/module-react'],
  manifest: ({ browser }) => ({
    name: 'Sirv Lens',
    description: 'Capture browser defects with their evidence, review them, and file them.',
    permissions: ['nativeMessaging', 'storage', ...(browser === 'firefox' ? [] : ['sidePanel'])],
    action: { default_title: 'Open Lens' },
    // The key pins the unpacked development ID that `lens register` allows. Store builds drop it.
    ...(browser === 'firefox'
      ? { browser_specific_settings: { gecko: { id: 'lens@sirv.studio', strict_min_version: '140.0', data_collection_permissions: { required: ['none'] } } } }
      : { key: DEV_KEY }),
  }),
});
