import { createRoot } from 'react-dom/client';
import EnrollPage from '../page';
import '../../globals.css';

const canvas = document.createElement('canvas');
canvas.width = 640;
canvas.height = 480;
const context = canvas.getContext('2d')!;
context.fillStyle = '#466b74';
context.fillRect(0, 0, 640, 480);
const stream = canvas.captureStream(10);
Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () => stream });
let posts = 0;
window.fetch = async (input) => {
  const enrolling = String(input) === '/api/enroll';
  if (enrolling) posts++;
  return Response.json(enrolling ? { photosCount: 3 } : { suggestions: [] });
};
Object.assign(window, { __cameraFixture: {
  end: () => {
    const track = stream.getVideoTracks()[0];
    track.stop();
    // Physical unplug emits ended; programmatic stop deliberately does not.
    track.dispatchEvent(new Event('ended'));
  },
  posts: () => posts,
} });
createRoot(document.getElementById('root')!).render(<EnrollPage />);
