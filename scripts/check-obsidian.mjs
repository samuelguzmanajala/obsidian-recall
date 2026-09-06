// Temporary local-CDP verification; start Obsidian with loopback debugging only, close it afterwards.
const [action = 'inspect'] = process.argv.slice(2);
const targets = await (await fetch('http://127.0.0.1:9223/json/list')).json();
const target = targets.find(t => t.type === 'page' && t.url === 'app://obsidian.md/index.html');
if (!target) throw new Error('Obsidian page not found');
const expressions = {
  inspect: `({remote:p.isRemoteMode(), localContainerAbsent:!p.container, localVaultSyncAbsent:!p.vaultSync, publisher:!!p.remoteSync, notes:app.vault.getMarkdownFiles().length, command:!!app.commands.commands['obsidian-recall:publish-notes'], stats:await p.remoteClient.getStudyStats.execute()})`,
  publish: `(await app.commands.commands['obsidian-recall:publish-notes'].callback(), {published:true,notes:app.vault.getMarkdownFiles().length,stats:await p.remoteClient.getStudyStats.execute()})`,
  view: `(await app.commands.commands['obsidian-recall:open-deck-browser'].callback(), {opened:true})`,
  visible: `({decks:app.workspace.getLeavesOfType('recall-deck-browser').length, errors:[...document.querySelectorAll('.notice')].map(e=>e.textContent).filter(t=>t.includes('Recall')), text:document.querySelector('.recall-deck-browser')?.textContent?.slice(0,400)})`,
  review: `(await app.commands.commands['obsidian-recall:start-review'].callback(), {opened:true})`,
  'review-check': `({views:app.workspace.getLeavesOfType('recall-review').length,questions:document.querySelectorAll('.recall-card-section').length,revealButton:!!document.querySelector('.recall-reveal-btn'),errors:[...document.querySelectorAll('.notice')].map(e=>e.textContent).filter(t=>t.includes('Recall')),reviewsToday:(await p.remoteClient.getStudyStats.execute()).reviewsToday})`,
  finish: `(app.workspace.getLeavesOfType('recall-review').at(-1)?.detach(), await app.commands.commands['obsidian-recall:open-deck-browser'].callback(), {testViewClosed:true})`,
};
if (!expressions[action]) throw new Error(`Expected one of: ${Object.keys(expressions).join(', ')}`);
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
const expression = `(async()=>{if(app.vault.adapter.getBasePath()!=='/Volumes/Disk2/Documentos/SamuelGuzman')throw new Error('Wrong vault'); const p=app.plugins.plugins['obsidian-recall']; if(!p)throw new Error('Recall not loaded');return ${expressions[action]};})()`;
try {
  const result = await new Promise((resolve, reject) => {
    socket.onmessage = event => { const message = JSON.parse(event.data); if(message.id===1) resolve(message); };
    socket.onerror = reject;
    socket.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression,awaitPromise:true,returnByValue:true}}));
  });
  if (result.error || result.result?.exceptionDetails) throw new Error(JSON.stringify(result.error ?? result.result.exceptionDetails));
  console.log(JSON.stringify(result.result.result.value, null, 2));
} finally { socket.close(); }
