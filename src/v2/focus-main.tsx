import React from 'react';
import { createRoot } from 'react-dom/client';
import '../tokens.css';
import './fieldboard.css';
import './focus.css';
import Focus from './Focus';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Focus />
  </React.StrictMode>,
);