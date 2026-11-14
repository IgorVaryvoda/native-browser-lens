import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Review } from './Review';
import '../sidepanel/style.css';
import './style.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Review observation={Number(new URLSearchParams(location.search).get('observation'))} />
  </StrictMode>,
);
