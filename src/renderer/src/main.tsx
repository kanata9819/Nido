// Entry point of the renderer: mounts the React app.
import { createRoot } from 'react-dom/client';
import App from './App';
import './assets/global.css';
import './assets/themes.css';
createRoot(document.getElementById('root')!).render(<App />);
