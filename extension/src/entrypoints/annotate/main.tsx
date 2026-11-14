import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Editor } from './Editor';
import '../sidepanel/style.css';
import './style.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Editor capture={Number(new URLSearchParams(location.search).get('capture'))} />
  </StrictMode>,
);
