import * as ReactDOM from 'react-dom';
import { registerReactUIViewAdapter, ReactDOMAdapter } from './ReactUIViewAdapterComponent.base';

// React 16/17 adapter using legacy ReactDOM.render API
const legacyReactDOM = ReactDOM as typeof ReactDOM & {
  render: ReactDOMAdapter['render'];
  unmountComponentAtNode: ReactDOMAdapter['unmount'];
};

const adapter: ReactDOMAdapter = {
  render: (element, container) => {
    legacyReactDOM.render(element, container);
  },
  unmount: (container) => {
    legacyReactDOM.unmountComponentAtNode(container);
  },
};

registerReactUIViewAdapter(adapter);
