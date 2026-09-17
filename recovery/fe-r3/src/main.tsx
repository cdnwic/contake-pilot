import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './tokens.css';
import './styles.css';
import App from './App';

document.documentElement.lang = 'he';
document.documentElement.dir = 'rtl';
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);