import React from 'react';
import { createRoot } from 'react-dom/client';
import '../tokens.css';
import './fieldboard.css';
import Tower from './Tower';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Tower />
  </React.StrictMode>,
);