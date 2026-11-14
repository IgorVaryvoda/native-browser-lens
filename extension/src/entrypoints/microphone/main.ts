import '@/ui/base.css';
import '@/ui/page.css';
import { followSystemTheme } from '@/ui/theme';

// A side panel cannot show the microphone prompt; a tab of the same extension can, and the
// browser then remembers the answer for the side panel too.
followSystemTheme();
const state = document.getElementById('state')!;
navigator.mediaDevices
  .getUserMedia({ audio: true })
  .then((stream) => {
    stream.getTracks().forEach((track) => track.stop());
    state.textContent = 'Lens can use the microphone now. Close this tab and press Record again in the side panel.';
  })
  .catch((error: Error) => {
    state.textContent = `The microphone stays off: ${error.message}. Allow it for Lens in the browser's site settings, then reload this tab.`;
  });
