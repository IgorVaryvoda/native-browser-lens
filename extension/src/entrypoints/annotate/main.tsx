import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Editor } from './Editor';
import '@/ui/base.css';
import { followSystemTheme } from '@/ui/theme';
import './style.css';

followSystemTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Editor capture={Number(new URLSearchParams(location.search).get('capture'))} />
  </StrictMode>,
);
