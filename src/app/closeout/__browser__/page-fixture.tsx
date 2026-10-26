import { createRoot } from 'react-dom/client';
import CloseoutPage from '../page';
import LogPage from '../../log/page';
import '../../globals.css';
(window as unknown as { __toasts: string[] }).__toasts = [];
createRoot(document.getElementById('root')!).render(window.location.pathname === '/log' ? <LogPage /> : <CloseoutPage />);
