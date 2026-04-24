import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.mychat.app',
  appName: 'Mychat',
  webDir: 'frontend',
  server: {
    androidScheme: 'https'
  }
};

export default config;
