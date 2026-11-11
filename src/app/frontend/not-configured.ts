/** Shown by the views while the backend URL or token is missing. */
export function renderNotConfigured(el: HTMLElement): void {
  const box = el.createDiv({ cls: 'recall-not-configured' });
  box.setAttribute('role', 'status');
  box.createEl('p', { text: 'Recall needs a backend. Set the backend URL and token in Settings → Recall, then reload the plugin.' });
}
