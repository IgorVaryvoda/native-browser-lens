import rrwebPlayer from 'rrweb-player';
import '@/ui/base.css';
import { followSystemTheme } from '@/ui/theme';
import 'rrweb-player/dist/style.css';
import '@/ui/page.css';
import './style.css';
import { LensClient } from '@/lens-client';

followSystemTheme();
const id = Number(new URLSearchParams(location.search).get('capture'));
const status = document.getElementById('status')!;
const client = new LensClient();

try {
  const capture = await client.request({ method: 'getCapture', params: { id } });
  document.getElementById('title')!.textContent = capture.pageTitle || capture.pageUrl;
  if (!capture.recording) throw new Error('This capture has no recording.');
  const events = JSON.parse(await (await client.readBlob(capture.recording)).text());
  const seconds = Math.round((events.at(-1).timestamp - events[0].timestamp) / 1000);
  status.textContent = `${seconds} s before the capture · inputs masked`;
  new rrwebPlayer({
    target: document.getElementById('player')!,
    props: { events, width: Math.min(1032, innerWidth - 48), autoPlay: false, showController: true },
  });
} catch (error) {
  status.textContent = (error as Error).message;
  status.setAttribute('role', 'alert');
} finally {
  client.disconnect();
}
