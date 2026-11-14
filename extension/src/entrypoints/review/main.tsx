import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Review } from './Review';
import '@/ui/base.css';
import { followSystemTheme } from '@/ui/theme';
import './style.css';

followSystemTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Review observation={Number(new URLSearchParams(location.search).get('observation'))} />
  </StrictMode>,
);
