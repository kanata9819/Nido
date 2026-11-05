// レンダラー（画面）の入口。index.html の <div id="root"> に App を描画する。
import { createRoot } from 'react-dom/client';
import App from './App';
import './assets/global.css';
import './assets/themes.css';
createRoot(document.getElementById('root')!).render(<App />);
