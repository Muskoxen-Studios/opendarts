import { createApp } from 'vue';
import App from './App.vue';
import './style.css';
import { stopAudio, unlockAudio } from './audio.ts';

document.addEventListener('pointerdown', unlockAudio);
document.addEventListener('keydown', unlockAudio);
document.addEventListener('visibilitychange', () => { if (document.hidden) stopAudio(); });

createApp(App).mount('#app');
