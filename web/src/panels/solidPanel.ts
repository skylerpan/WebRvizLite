import { render } from 'solid-js/web';
import type { Component } from 'solid-js';
import type { DockviewApi, DockviewPanelApi, GroupPanelPartInitParameters, IContentRenderer } from 'dockview';

export interface PanelProps {
  api: DockviewPanelApi;
  containerApi: DockviewApi;
}

/** Adapts a SolidJS component to dockview's IContentRenderer. */
export function solidPanel(component: Component<PanelProps>, className = 'wrl-panel'): IContentRenderer {
  const element = document.createElement('div');
  element.className = className;
  let dispose: (() => void) | undefined;
  return {
    element,
    init(params: GroupPanelPartInitParameters) {
      dispose = render(() => component({ api: params.api, containerApi: params.containerApi }), element);
    },
    dispose() {
      dispose?.();
      dispose = undefined;
    },
  };
}
