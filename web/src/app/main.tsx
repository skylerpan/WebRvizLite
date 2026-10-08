import { render } from 'solid-js/web';
import 'dockview/dist/styles/dockview.css';
import './app.css';
import { App } from './App';

const root = document.getElementById('root');
if (!root) throw new Error('#root missing');
render(() => <App />, root);
