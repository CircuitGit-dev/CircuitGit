/** Browser navigation only; the static guide does not connect an Agent or gateway. */
export function mountWorkflowLink(host) {
  const url = new URL('../workflow/index.html', import.meta.url);
  const link = document.createElement('a');
  link.href = url.href;
  link.target = '_blank';
  link.rel = 'noopener';
  link.className = 'studio-workflow-link';
  link.textContent = '流程指南 ↗';
  link.title = '真实电路全流程、操作步骤与能力边界';
  document.getElementById('studio-toolbar')?.append(link);
  const unregister = host.registerCommand({
    id: 'help.workflow', menu: 'help', label: '全流程实战与能力边界…',
    run: () => window.open(url.href, '_blank', 'noopener'),
  });
  return {destroy() {unregister(); link.remove();}};
}
