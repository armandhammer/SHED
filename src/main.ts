import '@fontsource/barlow-condensed/400.css';
import '@fontsource/barlow-condensed/500.css';
import '@fontsource/barlow-condensed/600.css';
import '@fontsource/barlow-condensed/700.css';
import '@fontsource/b612-mono/400.css';
import './style.css';
import { startApp } from './ui/app';
import { currentDevice } from './ui/device';
import { startShruthiApp } from './ui/shruthi-app';

const root = document.getElementById('app')!;
if (currentDevice() === 'shruthi') startShruthiApp(root);
else startApp(root);
