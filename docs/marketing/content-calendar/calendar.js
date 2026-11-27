'use strict';
const DATA=JSON.parse(document.querySelector('#calendar-data').textContent);
const $=s=>document.querySelector(s);
const OUTREACH=DATA.outreach||{questions:[],records:[],guidance:{}};
const platforms=Object.fromEntries(DATA.platforms.map(p=>[p.id,p]));
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const dayOf=d=>new Intl.DateTimeFormat('en-CA',{timeZone:DATA.timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(d);
const today=dayOf(new Date());
const state={section:location.hash==='#outreach'?'outreach':'calendar',outreachSearch:'',outreachPlatform:'all',outreachStatus:'all',outreachSelected:null,month:today.slice(0,7),view:matchMedia('(max-width:680px)').matches?'agenda':'month',platform:'all',status:'all',kind:'all',search:'',selected:null,library:false};
const labels={scheduled:'Scheduled',published:'Published',draft:'Draft / proposed',blocked:'Filtered'};
const kinds={video:'Video',reel:'Reel',video_post:'Video post',story:'Story',carousel:'Carousel',image:'Image',text:'Text post',launch:'Launch post',reply:'Reply'};
const timeText=t=>t?new Intl.DateTimeFormat('en-IN',{hour:'numeric',minute:'2-digit',timeZone:'UTC'}).format(new Date('2000-01-01T'+t+':00Z')):'Time not recorded';
const dateText=d=>d?new Intl.DateTimeFormat('en-IN',{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'}).format(new Date(d+'T12:00:00Z')):'Publication date not recorded';
const isAttention=e=>e.status==='draft'||e.status==='blocked';
const icon=p=>`<span class="platform-icon ${p}">${platforms[p].short}</span>`;
const safeUrl=u=>{try{const v=new URL(u);return ['file:','https:','http:'].includes(v.protocol)?esc(u):''}catch{return ''}};
const sorted=items=>items.slice().sort((a,b)=>(a.date||'9999').localeCompare(b.date||'9999')||(a.time||'').localeCompare(b.time||'')||a.platform.localeCompare(b.platform));
function matches(e,ignoreDate=false){
 return (state.platform==='all'||e.platform===state.platform)&&
 (state.status==='all'||(state.status==='attention'?isAttention(e):e.status===state.status))&&
 (state.kind==='all'||(state.kind==='video'?['video','reel','video_post'].includes(e.kind):state.kind==='image'?['image','carousel'].includes(e.kind):state.kind==='text'?['text','launch'].includes(e.kind):e.kind===state.kind))&&
 (!state.search||[e.title,e.caption,e.account,platforms[e.platform].name].join(' ').toLowerCase().includes(state.search.toLowerCase()))&&
 (ignoreDate||state.library||state.status==='attention'||e.date?.startsWith(state.month));
}
function eventHtml(e,agenda=false){
 const symbol={scheduled:'•',published:'✓',draft:'◇',blocked:'!'}[e.status];
 const statusLabel=e.statusLabel||labels[e.status];
 const text=e.time?timeText(e.time):statusLabel;
 return `<button class="event ${e.status} ${e.key===state.selected?'selected':''}" data-event="${esc(e.key)}" aria-label="${esc(platforms[e.platform].name+', '+e.title+', '+statusLabel+', '+dateText(e.date)+(e.time?', '+timeText(e.time)+' IST':''))}" aria-pressed="${e.key===state.selected}"><span class="event-meta">${icon(e.platform)}<span>${esc(text)}</span>${!agenda?`<span class="mini-status" title="${statusLabel}">${symbol}</span>`:''}</span><span class="event-title">${esc(e.title.replace(/\s*[|—]\s*Pocket Dev\s*$/,''))}</span>${agenda?`<span class="agenda-account">${esc(e.account)}<br><span class="status ${e.status}">${labels[e.status]}</span></span>`:''}</button>`;
}
function agendaHtml(events,heading=true){
 if(!events.length)return '<div class="empty">No content matches these filters.<button data-reset>Reset filters</button></div>';
 const groups=Map.groupBy?Map.groupBy(sorted(events),e=>e.date||'undated'):(()=>{const m=new Map;for(const e of sorted(events)){const k=e.date||'undated';if(!m.has(k))m.set(k,[]);m.get(k).push(e)}return m})();
 let out='<div class="agenda">';
 for(const [date,items] of groups){if(heading)out+=`<div class="agenda-date"><strong>${date==='undated'?'Published · date not recorded':dateText(date)}</strong><span>${items.length} ${items.length===1?'post':'posts'}</span></div>`;out+=items.map(e=>eventHtml(e,true)).join('')}
 return out+'</div>';
}
function render(){
 const outreachMode=state.section==='outreach';
 $('#publishing-section').hidden=outreachMode;$('#outreach-section').hidden=!outreachMode;$('#export').hidden=outreachMode;
 $('#outreach-nav').classList.toggle('active',outreachMode);
 $('h1').textContent=outreachMode?'Questions & replies':'Content calendar';
 $('.subtitle').textContent=outreachMode?'Find the right conversations and track what happened.':'Your videos, posts and publishing dates in one place.';
 if(outreachMode){for(const id of ['calendar-nav','attention-nav','published-nav'])$('#'+id).classList.remove('active');renderOutreach();return}
 $('#month-label').textContent=state.library?'Published library':state.status==='attention'?'Needs attention':new Intl.DateTimeFormat('en-IN',{month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(state.month+'-01T12:00:00Z'));
 $('#month-view').setAttribute('aria-pressed',String(state.view==='month'&&!state.library));$('#agenda-view').setAttribute('aria-pressed',String(state.view==='agenda'||state.library));
 $('#status').value=state.status;$('#kind').value=state.kind;$('#search').value=state.search;
 $('#calendar-nav').classList.toggle('active',!state.library&&state.status!=='attention');$('#attention-nav').classList.toggle('active',state.status==='attention');$('#published-nav').classList.toggle('active',state.library);
 $('#prev').disabled=state.library||state.status==='attention';$('#next').disabled=state.library||state.status==='attention';
 $('#platforms').innerHTML=DATA.platforms.map(p=>`<button class="channel ${p.id} ${state.platform===p.id?'active':''}" data-platform="${p.id}" aria-pressed="${state.platform===p.id}">${icon(p.id)}<span class="label">${esc(p.name)}<small>${esc(p.account)}</small></span><span class="count">${DATA.events.filter(e=>e.platform===p.id&&e.status==='scheduled').length}</span></button>`).join('');
 const events=sorted(DATA.events.filter(e=>matches(e)));
 $('#result-count').textContent=`${events.length} ${state.library?'published posts':state.status==='attention'?'items needing attention':'dated posts'}${state.platform!=='all'?' · '+platforms[state.platform].account:''}${!state.library&&state.status!=='attention'?' this month':''}`;
 if(state.view==='agenda'||state.library||state.status==='attention'){$('#calendar').innerHTML=agendaHtml(events)}else{
  const first=new Date(state.month+'-01T12:00:00Z');const start=new Date(first);start.setUTCDate(1-(first.getUTCDay()+6)%7);
  const end=new Date(first);end.setUTCMonth(end.getUTCMonth()+1);end.setUTCDate(0);
  const cells=Math.ceil((((first.getUTCDay()+6)%7)+end.getUTCDate())/7)*7;
  let html='<div class="weekdays" aria-hidden="true">'+['MON','TUE','WED','THU','FRI','SAT','SUN'].map(d=>`<span>${d}</span>`).join('')+'</div><div class="month-grid">';
  for(let i=0;i<cells;i++){const d=new Date(start);d.setUTCDate(d.getUTCDate()+i);const day=d.toISOString().slice(0,10);const entries=sorted(DATA.events.filter(e=>matches(e,true)&&e.date===day));
   html+=`<div class="day ${!day.startsWith(state.month)?'outside':''} ${day===today?'today':''}"><div class="day-heading"><span class="date" ${day===today?'aria-current="date"':''}>${d.getUTCDate()}</span><span class="day-count">${entries.length||''}</span></div>${entries.map(e=>eventHtml(e)).join('')}</div>`}
  $('#calendar').innerHTML=html+'</div>';
 }
 const undated=DATA.events.filter(e=>!e.date&&e.status==='published'&&matches(e,true));
 $('#undated').innerHTML=!state.library&&undated.length?`<div class="undated-heading"><span>${undated.length} published posts have no recorded publication date</span><button id="open-library">View library →</button></div>`:'';
 renderDetail();
}
function renderDetail(){
 const e=DATA.events.find(e=>e.key===state.selected);
 if(!e){$('#detail').innerHTML='<div class="empty-detail"><div class="large-icon">▦</div><h3>Select a post</h3><p>Choose any calendar entry to see its caption, original video, account and saved schedule.</p><p>Dashed entries are proposed slots. They have not been scheduled.</p></div>';return}
 const outdated=e.status==='scheduled'&&e.date&&e.date<today;
 const note=[e.note,outdated?'This scheduled date has passed. Publication has not been rechecked.':''].filter(Boolean).join(' ');
 $('#detail').innerHTML=`<div class="detail-head">${icon(e.platform)}<span>${esc(platforms[e.platform].name)}</span></div><h3>${esc(e.title)}</h3><span class="status ${e.status}">${esc(e.statusLabel||labels[e.status])}</span><dl><dt>Account</dt><dd>${esc(e.account)}</dd><dt>${e.status==='draft'?'Proposed':'Date'}</dt><dd>${dateText(e.date)}${e.time?'<br>'+timeText(e.time)+' IST':''}</dd><dt>Format</dt><dd>${esc(kinds[e.kind]||e.kind)}</dd>${e.scheduler?`<dt>Publisher</dt><dd>${esc(e.scheduler)}</dd>`:''}</dl>${note?`<p class="detail-note">${esc(note)}</p>`:''}${e.video?`<video controls preload="none" playsinline ${e.cover?`poster="${safeUrl(e.cover)}"`:''} src="${safeUrl(e.video)}" aria-label="Original video for ${esc(e.title)}"></video><p class="media-info">${e.duration?Math.round(e.duration)+' seconds · ':''}${esc(e.dimensions)} · Original video</p>`:e.cover?`<img class="preview" src="${safeUrl(e.cover)}" alt="${esc(e.title)}" loading="lazy">`:''}${(e.extraVideos||[]).map((src,i)=>`<h4>Attached video ${i+2}</h4><video controls preload="none" playsinline src="${safeUrl(src)}" aria-label="Additional attached video"></video>`).join('')}<div class="detail-actions">${e.questionUrl?`<a target="_blank" rel="noopener" href="${safeUrl(e.questionUrl)}">Open question ↗</a>`:''}${e.url?`<a target="_blank" rel="noopener" href="${safeUrl(e.url)}">${e.kind==='reply'?'View reply':e.status==='blocked'?'View filtered post':'View post'} ↗</a>`:''}<a target="_blank" rel="noopener" href="${safeUrl(e.publisher)}">Open publisher ↗</a>${e.video?`<a target="_blank" href="${safeUrl(e.video)}">Open video ↗</a>`:''}${e.caption?'<button id="copy-caption">Copy caption</button>':''}</div>${e.slides.length>1?`<div class="detail-actions">${e.slides.map((s,i)=>`<a target="_blank" href="${safeUrl(s)}">Slide ${i+1} ↗</a>`).join('')}</div>`:''}${e.caption?`<h4>${e.platform==='reddit'?'Post text':'Caption'}</h4><p class="caption">${esc(e.caption)}</p>`:''}<details><summary>Saved confirmation and source</summary><p>${esc(e.confirmation||'Prepared content only; no remote publishing confirmation.')}</p>${e.verified?`<p>Last saved verification: ${esc(e.verified)}</p>`:''}<a href="${safeUrl(e.sourceUrl)}" target="_blank">Open source record ↗</a></details>`;
}
function reset(){Object.assign(state,{section:'calendar',platform:'all',status:'all',kind:'all',search:'',library:false});render()}
function changeMonth(n){const d=new Date(state.month+'-01T12:00:00Z');d.setUTCMonth(d.getUTCMonth()+n);state.month=d.toISOString().slice(0,7);state.library=false;render()}
function attention(){Object.assign(state,{section:'calendar',status:'attention',library:false,view:'agenda',platform:'all',kind:'all',search:''});const first=sorted(DATA.events.filter(e=>isAttention(e)&&e.date>=today))[0]||sorted(DATA.events.filter(e=>isAttention(e)&&e.date))[0];if(first){state.month=first.date.slice(0,7);state.selected=first.key}render()}
function toast(s){$('#toast').textContent=s;$('#toast').style.display='block';clearTimeout(window.toastTimer);window.toastTimer=setTimeout(()=>$('#toast').style.display='none',2500)}
document.addEventListener('click',async ev=>{
 const question=ev.target.closest('[data-question]');if(question){state.outreachSelected=question.dataset.question;renderOutreach();if(innerWidth<1000)$('#outreach-detail').scrollIntoView({block:'start'});return}
 if(ev.target.closest('#copy-short-reply')){const q=OUTREACH.questions.find(q=>q.id===state.outreachSelected);if(q?.short_draft)await copyOutreachText(q.short_draft);return}
 const event=ev.target.closest('[data-event]');if(event){state.selected=event.dataset.event;render();if(innerWidth<1000)$('#detail').scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'start'});return}
 const platform=ev.target.closest('[data-platform]');if(platform){state.section='calendar';state.platform=state.platform===platform.dataset.platform?'all':platform.dataset.platform;render();return}
 if(ev.target.closest('[data-reset]'))return reset();
 if(ev.target.closest('#open-library'))return library();
 if(ev.target.closest('#copy-caption')){const e=DATA.events.find(e=>e.key===state.selected);try{await navigator.clipboard.writeText(e.caption);toast('Caption copied')}catch{const t=document.createElement('textarea');t.value=e.caption;document.body.append(t);t.select();const ok=document.execCommand('copy');t.remove();toast(ok?'Caption copied':'Select the caption text to copy it')}return}
});
function library(){Object.assign(state,{section:'calendar',status:'published',library:true,view:'agenda'});render()}
$('#prev').onclick=()=>changeMonth(-1);$('#next').onclick=()=>changeMonth(1);
$('#today').onclick=()=>{state.month=today.slice(0,7);state.library=false;render()};
$('#jump-next').onclick=()=>{const e=sorted(DATA.events.filter(e=>e.status==='scheduled'&&e.at&&new Date(e.at)>new Date()&&matches(e,true)))[0];if(e){state.month=e.date.slice(0,7);state.selected=e.key;state.library=false;render()}else toast('No upcoming schedules match your filters')};
$('#month-view').onclick=()=>{state.view='month';state.library=false;if(state.status==='attention')state.status='all';render()};$('#agenda-view').onclick=()=>{state.view='agenda';render()};
$('#search').oninput=ev=>{state.search=ev.target.value;render()};$('#status').onchange=ev=>{state.status=ev.target.value;state.library=false;render()};$('#kind').onchange=ev=>{state.kind=ev.target.value;render()};
$('#clear').onclick=reset;$('#home').onclick=ev=>{ev.preventDefault();reset()};$('#calendar-nav').onclick=reset;$('#attention-nav').onclick=attention;$('#show-attention').onclick=attention;$('#published-nav').onclick=()=>{state.platform='all';state.kind='all';state.search='';library()};
$('#outreach-nav').onclick=()=>{state.section='outreach';render()};
$('#outreach-search').oninput=ev=>{state.outreachSearch=ev.target.value;renderOutreach()};
$('#outreach-platform').onchange=ev=>{state.outreachPlatform=ev.target.value;renderOutreach()};
$('#outreach-status').onchange=ev=>{state.outreachStatus=ev.target.value;renderOutreach()};
$('#outreach-count').textContent=OUTREACH.questions.length;
$('#outreach-example').textContent=OUTREACH.guidance.example||'';
$('#outreach-export').onclick=()=>{const url=URL.createObjectURL(new Blob([JSON.stringify(OUTREACH,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='pocket-dev-questions-and-replies.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)};
$('#refresh').onclick=()=>location.reload();
$('#audit-link').href=DATA.auditUrl;$('#plan-link').href=DATA.planUrl;
$('#generated').textContent='Built '+new Intl.DateTimeFormat('en-IN',{day:'numeric',month:'short',hour:'numeric',minute:'2-digit',timeZone:DATA.timezone}).format(new Date(DATA.generatedAt))+' IST';
$('#sidebar-date').textContent='Plan through 7 Jan 2027';
$('#attention-count').textContent=DATA.events.filter(isAttention).length;
$('#coverage').innerHTML=DATA.platforms.filter(p=>p.id!=='reddit').map(p=>{const videos=DATA.events.filter(e=>e.platform===p.id&&['video','reel','video_post'].includes(e.kind)&&!e.id.startsWith('linkedin-'));const covered=new Set(videos.filter(e=>['published','scheduled'].includes(e.status)).flatMap(e=>e.videoIds||[e.id]).filter(id=>DATA.videoIds.includes(id))).size;return `<span class="coverage-item"><b>${esc(p.id==='personal'?'Personal IG':p.name)}</b><span class="${covered===18?'good':'needs'}">${covered}/18</span></span>`}).join('');
function icalEscape(s){return String(s).replace(/\\/g,'\\\\').replace(/;/g,'\\;').replace(/,/g,'\\,').replace(/\r?\n/g,'\\n')}
function utcStamp(s){return new Date(s).toISOString().replace(/[-:]/g,'').slice(0,15)+'Z'}
function foldIcal(line){const encoder=new TextEncoder();let out='',chunk='';for(const ch of line){if(encoder.encode(chunk+ch).length>73){out+=chunk+'\r\n ';chunk=''}chunk+=ch}return out+chunk}
$('#export').onclick=()=>{const events=DATA.events.filter(e=>e.status==='scheduled'&&e.at&&matches(e,true));if(!events.length)return toast('No confirmed schedules to export');const lines=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Pocket Dev//Publishing calendar//EN','CALSCALE:GREGORIAN','METHOD:PUBLISH','X-WR-CALNAME:Pocket Dev content','X-WR-TIMEZONE:Asia/Kolkata'];for(const e of events){lines.push('BEGIN:VEVENT','UID:'+icalEscape(e.key)+'@pocket-dev.local','DTSTAMP:'+utcStamp(DATA.generatedAt),'DTSTART:'+utcStamp(e.at),'DTEND:'+utcStamp(new Date(new Date(e.at).getTime()+15*60000).toISOString()),'SUMMARY:'+icalEscape(platforms[e.platform].name+': '+e.title),'DESCRIPTION:'+icalEscape(e.account+'\nSaved schedule, verify publication with the publisher.\n\n'+e.caption),'STATUS:CONFIRMED','END:VEVENT')}lines.push('END:VCALENDAR');const blob=new Blob([lines.map(foldIcal).join('\r\n')+'\r\n'],{type:'text/calendar;charset=utf-8'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='pocket-dev-content-calendar.ics';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);toast('Exported '+events.length+' confirmed schedules')};
const upcoming=sorted(DATA.events.filter(e=>e.status==='scheduled'&&e.at&&new Date(e.at)>new Date()))[0];if(upcoming){state.selected=upcoming.key;state.month=upcoming.date.slice(0,7)}
render();

async function copyOutreachText(text){
 try{await navigator.clipboard.writeText(text);toast('Short reply copied')}
 catch{const t=document.createElement('textarea');t.value=text;document.body.append(t);t.select();const ok=document.execCommand('copy');t.remove();toast(ok?'Short reply copied':'Select the reply text to copy it')}
}
function renderOutreach(){
 const stageLabels={review:'Needs review',replied:'Live reply',removed:'Removed',not_fit:'Not a fit',draft:'Draft'};
 const rank={review:0,draft:1,removed:2,replied:3,not_fit:4};
 const counts=Object.fromEntries(Object.keys(stageLabels).map(k=>[k,OUTREACH.questions.filter(q=>q.stage===k).length]));
 const sentDMs=OUTREACH.records.reduce((n,r)=>n+(r.sent_dm_count||0),0);
 $('#outreach-summary').innerHTML=`<span><strong>${OUTREACH.questions.length}</strong> saved questions</span><span><strong>${counts.replied}</strong> live replies</span><span><strong>${counts.removed}</strong> removed</span><span><strong>${sentDMs}</strong> DMs sent</span>`;
 const search=state.outreachSearch.toLowerCase();
 const rows=OUTREACH.questions.filter(q=>(state.outreachPlatform==='all'||q.platform===state.outreachPlatform)&&(state.outreachStatus==='all'||q.stage===state.outreachStatus)&&(!search||[q.question,q.author,q.reason,q.fit].join(' ').toLowerCase().includes(search))).sort((a,b)=>(rank[a.stage]??9)-(rank[b.stage]??9)||a.question.localeCompare(b.question));
 if(!rows.some(q=>q.id===state.outreachSelected))state.outreachSelected=rows[0]?.id||null;
 $('#outreach-result').textContent=`${rows.length} ${rows.length===1?'question':'questions'} · collected 19 Nov 2026 · replies are checked separately from drafts`;
 $('#outreach-list').innerHTML=rows.length?'<div class="question-list">'+rows.map(q=>`<button class="question-row ${q.id===state.outreachSelected?'selected':''}" data-question="${esc(q.id)}" aria-pressed="${q.id===state.outreachSelected}" aria-label="Review question by ${esc(q.author)}: ${esc(q.question)}">${icon(q.platform)}<span class="question-copy"><span class="question-title">${esc(q.question)}</span><span class="question-meta">${esc(q.author)} · ${q.post_date?dateText(q.post_date):'Post date not verified'}</span></span><span class="outreach-status ${q.stage}">${stageLabels[q.stage]||'Needs review'}</span></button>`).join('')+'</div>':'<div class="empty">No saved questions match these filters.</div>';
 const q=OUTREACH.questions.find(q=>q.id===state.outreachSelected);
 if(!q){$('#outreach-detail').innerHTML='<div class="empty-detail"><h3>Select a question</h3><p>Open a source thread, review its fit and see the saved reply status.</p></div>';return}
 const warning=q.stage==='replied'?'Reply recorded as publicly live. Open the reply to check its current visibility.':q.stage==='removed'?'The submitted reply was removed. It is not publicly live and is not queued for reposting.':q.stage==='not_fit'?'No reply sent. Pocket Dev does not match the request closely enough.':'No reply sent. Review the conversation before using a draft.';
 $('#outreach-detail').innerHTML=`<div class="detail-head">${icon(q.platform)}<span>${esc(q.author)}</span></div><h3>${esc(q.question)}</h3><span class="outreach-status ${q.stage}">${stageLabels[q.stage]||'Needs review'}</span><div class="detail-actions"><a href="${safeUrl(q.url)}" target="_blank" rel="noopener">Open question ↗</a>${q.reply_url?`<a href="${safeUrl(q.reply_url)}" target="_blank" rel="noopener">${q.stage==='removed'?'View removed reply':'View reply'} ↗</a>`:''}</div><p class="detail-note">${esc(warning)}</p><h4>${q.stage==='not_fit'?'Why we passed':'Fit and context'}</h4><p class="outreach-reason">${esc(q.reason)}</p><h4>Next step</h4><p class="outreach-reason">${esc(q.next_action||'Review before replying.')}</p>${q.short_draft&&q.stage==='review'?`<h4>Short draft · not sent</h4><p class="caption">${esc(q.short_draft)}</p><div class="detail-actions"><button id="copy-short-reply">Copy short draft</button></div>`:''}${q.reply?`<details><summary>Submitted reply and outcome</summary><p class="caption">${esc(q.reply)}</p><p>${esc(q.verification||'Public visibility not confirmed.')}</p></details>`:''}<details><summary>Source record</summary><p>Saved ${esc(q.saved_on)}. The title is a summary; read the original thread for full context.</p><a href="${safeUrl(q.sourceUrl)}" target="_blank">Open saved log ↗</a></details>`;
}
