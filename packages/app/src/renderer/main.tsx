import './migrateStorage.ts';
import './theme/theme.ts';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './theme/tokens.css';
import './ui/ui.css';
import './style.css';
import './shell.css';
createRoot(document.getElementById('root')!).render(<App />);
