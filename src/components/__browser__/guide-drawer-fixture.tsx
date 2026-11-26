import { createRoot } from 'react-dom/client';
import GuideDrawer from '../GuideDrawer';
import '../../app/globals.css';

createRoot(document.getElementById('root')!).render(
  <>
    <main className="mx-auto max-w-7xl px-6 pt-8 text-slate-100" style={{ minHeight: '250vh' }}>
      <h1 className="page-title">Shift Briefing</h1>
      <p className="mt-4">No sample shift data.</p>
    </main>
    <GuideDrawer />
  </>,
);
