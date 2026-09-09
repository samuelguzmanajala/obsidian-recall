// Temporary local-CDP verification; start Obsidian with loopback debugging only, close it afterwards.
const [action = 'inspect'] = process.argv.slice(2);
const targets = await (await fetch('http://127.0.0.1:9223/json/list')).json();
const target = targets.find(t => t.type === 'page' && t.url === 'app://obsidian.md/index.html');
if (!target) throw new Error('Obsidian page not found');
const expressions = {
  'recover-loopback-journal': `(await (async()=>{
    const settings=structuredClone(p.remoteClient.settings);settings.backend.url='http://127.0.0.1:27124';
    const client=new p.remoteClient.constructor(settings,p.remoteClient.transport);
    const key='recall-note-cursors:SamuelGuzman:'+settings.backend.url;
    const journalKey='recall-pending-notes:SamuelGuzman:'+settings.backend.url;
    const sync=new p.remoteSync.constructor(client,JSON.parse(localStorage.getItem(key)??'{}'),v=>localStorage.setItem(key,JSON.stringify(v)),{
      load:()=>JSON.parse(localStorage.getItem(journalKey)??'[]'),save:v=>localStorage.setItem(journalKey,JSON.stringify(v))});
    try {
      const [local,active]=await Promise.all([client.request('/notes'),p.remoteClient.request('/notes')]);
      if(JSON.stringify(local)!==JSON.stringify(active))throw new Error('Endpoint manifests differ; no recovery attempted');
      for(const path of new Set(sync.jobs.map(j=>j.path))){
        const file=app.vault.getAbstractFileByPath(path);if(!file||file.extension!=='md')throw new Error('Missing pending note');
        if(sync.jobs.some(j=>j.path===path&&(j.newPath||j.content===null)))throw new Error('Path changes require manual review');
        await sync.stageCurrent(path,await app.vault.read(file));
      }
      await sync.retry();
      return {endpointManifestsMatched:true,oldQueuePending:sync.pendingCount};
    } finally {sync.close();client.close();}
  })())`,
  'sync-storage': `({url:p.remoteClient.settings.backend.url,keys:Object.keys(localStorage).filter(k=>k.startsWith('recall-note-cursors:')||k.startsWith('recall-pending-notes:')).map(k=>({key:k,count:Object.keys(JSON.parse(localStorage.getItem(k))).length})),cursors:Object.entries(p.remoteSync.state).filter(([k])=>/Diagrama de densidad|Exploracion visual|Diagrama de caja/.test(k))})`,
  'sync-state': `({pendingNotes:p.remoteSync.pendingCount,conflict:p.remoteSync.conflictPath,knownNotes:p.remoteSync.knownPaths.length,jobs:p.remoteSync.jobs.map(j=>({path:j.path,expectedRevision:j.expectedRevision,baseHash:j.baseHash})),status:[...document.querySelectorAll('.status-bar-item')].filter(e=>e.textContent.startsWith('Recall:')).map(e=>({text:e.textContent,title:e.getAttribute('aria-label')??e.title}))})`,
  recovery: `(await new Promise(r=>setTimeout(r,3000)), await app.commands.commands['obsidian-recall:retry-pending'].callback(), {pendingNotes:p.remoteSync.pendingCount,conflict:p.remoteSync.conflictPath,pendingReviews:p.remoteClient.hasPendingReview(),knownNotes:p.remoteSync.knownPaths.length,resolveCommand:!!app.commands.commands['obsidian-recall:resolve-note-conflict'],status:[...document.querySelectorAll('.status-bar-item')].map(e=>e.textContent).filter(t=>t.startsWith('Recall:')),stats:await p.remoteClient.getStudyStats.execute()})`,
  inspect: `({remote:p.isRemoteMode(), localContainerAbsent:!p.container, localVaultSyncAbsent:!p.vaultSync, publisher:!!p.remoteSync, notes:app.vault.getMarkdownFiles().length, command:!!app.commands.commands['obsidian-recall:publish-notes'], stats:await p.remoteClient.getStudyStats.execute()})`,
  publish: `(await app.commands.commands['obsidian-recall:publish-notes'].callback(), {published:true,notes:app.vault.getMarkdownFiles().length,stats:await p.remoteClient.getStudyStats.execute()})`,
  view: `(await app.commands.commands['obsidian-recall:open-deck-browser'].callback(), {opened:true})`,
  visible: `({decks:app.workspace.getLeavesOfType('recall-deck-browser').length, errors:[...document.querySelectorAll('.notice')].map(e=>e.textContent).filter(t=>t.includes('Recall')), text:document.querySelector('.recall-deck-browser')?.textContent?.slice(0,400)})`,
  review: `(await app.commands.commands['obsidian-recall:start-review'].callback(), {opened:true})`,
  'review-check': `({views:app.workspace.getLeavesOfType('recall-review').length,questions:document.querySelectorAll('.recall-card-section').length,revealButton:!!document.querySelector('.recall-reveal-btn'),errors:[...document.querySelectorAll('.notice')].map(e=>e.textContent).filter(t=>t.includes('Recall')),reviewsToday:(await p.remoteClient.getStudyStats.execute()).reviewsToday})`,
  finish: `(app.workspace.getLeavesOfType('recall-review').at(-1)?.detach(), await app.commands.commands['obsidian-recall:open-deck-browser'].callback(), {testViewClosed:true})`,
  'live-refresh': `(await (async()=>{
    await app.commands.commands['obsidian-recall:open-deck-browser'].callback();
    const v=app.workspace.getLeavesOfType('recall-deck-browser')[0].view;
    await v.refresh();
    const header=v.contentEl.querySelector('.recall-header');
    const transport=p.remoteClient.transport;
    let statsRequests=0;
    p.remoteClient.transport=async(...args)=>{if(String(args[0]).endsWith('/stats'))statsRequests++;return transport(...args);};
    try {
      await new Promise(r=>setTimeout(r,11000));
      return {automaticStatsRequests:statsRequests,unchangedDomPreserved:header===v.contentEl.querySelector('.recall-header'),connectionError:!!v.contentEl.querySelector('.recall-connection-error'),reviewsToday:(await p.remoteClient.getStudyStats.execute()).reviewsToday};
    } finally {p.remoteClient.transport=transport;}
  })())`,
  'review-refresh': `(await (async()=>{
    const v=app.workspace.getLeavesOfType('recall-review').at(-1)?.view;
    if(!v)throw new Error('Open test review first');
    await v.loadItems();
    const original=v.items[v.currentIndex];
    v.answerRevealed=true;await v.render();
    await v.live.request();
    const sameId=original?.studyItemId===v.items[v.currentIndex]?.studyItemId;
    const revealed=v.answerRevealed;
    v.answerRevealed=false;await v.render();
    return {sameCard:sameId,revealedAnswerPreserved:revealed,pollingEnabled:!!v.refreshTimer,loadError:v.loadError,reviewsToday:(await p.remoteClient.getStudyStats.execute()).reviewsToday};
  })())`,
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
