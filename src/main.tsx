import { desktop } from './desktop.ts';
import { createRoot } from 'react-dom/client';
import { DesktopRoot } from './components/DesktopRoot.tsx';
import './styles.css';
import './business.css';
import './management.css';
import './desktop.css';

const report=(type:string,line?:number,column?:number)=>{void desktop?.diagnosticReport({type,line,column}).catch(()=>{});};
window.addEventListener('error',e=>report('error',e.lineno,e.colno));
window.addEventListener('unhandledrejection',()=>report('unhandledrejection'));
createRoot(document.getElementById('root')!,{onUncaughtError:()=>report('react_error'),onCaughtError:()=>report('react_error')}).render(<DesktopRoot />);
