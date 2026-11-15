// Entry point of the renderer: mounts the React app.
import { createRoot } from 'react-dom/client';
import App from './app/App';
import './styles/global.css';
import './styles/themes.css';
createRoot(document.getElementById('root')!).render(<App />);
