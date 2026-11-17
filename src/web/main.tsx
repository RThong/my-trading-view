import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { applyRenderTheme, RenderPage } from './pages/editor/RenderPage';
import './styles.css';

// /render = 命令行出图用的单图页(见 pages/editor/RenderPage),其余都是看板
const render = location.pathname === '/render';
if (render) applyRenderTheme();

createRoot(document.getElementById('root')!).render(<StrictMode>{render ? <RenderPage /> : <App />}</StrictMode>);
