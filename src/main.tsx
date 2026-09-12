import { createRoot } from 'react-dom/client';
import { DesktopRoot } from './components/DesktopRoot.tsx';
import './styles.css';
import './business.css';
import './management.css';
import './desktop.css';

createRoot(document.getElementById('root')!).render(<DesktopRoot />);
