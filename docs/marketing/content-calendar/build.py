#!/usr/bin/env python3
"""Build the offline content calendar from the saved publishing records. No network calls."""
from pathlib import Path
from datetime import datetime
from zoneinfo import ZoneInfo
from collections import Counter
import json

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
TZ = ZoneInfo('Asia/Kolkata')
def read(name): return json.loads((ROOT / name).read_text())
def local(path):
    return Path(path).as_uri() if path and Path(path).is_absolute() else ''

platforms = [
    {'id':'youtube','name':'YouTube','short':'YT','account':'Pocket Dev by Ani','url':'https://studio.youtube.com/channel/UCvjCaYY5T2dmFcAoUraYIMw/videos'},
    {'id':'facebook','name':'Facebook','short':'FB','account':'Pocket Dev','url':'https://app.metricool.com/planner/calendar?blogId=8167569&userId=6427289'},
    {'id':'instagram','name':'Instagram','short':'IG','account':'@afk_pocket_dev','url':'https://www.instagram.com/afk_pocket_dev/'},
    {'id':'personal','name':'Instagram personal','short':'IP','account':'@hap.pyani','url':'https://www.instagram.com/hap.pyani/'},
    {'id':'linkedin','name':'LinkedIn','short':'LI','account':'ROHIT KUMAR DAS','url':'https://www.linkedin.com/feed/'},
    {'id':'x','name':'X / Twitter','short':'X','account':'@anisirji','url':'https://x.com/anisirji'},
    {'id':'reddit','name':'Reddit','short':'RD','account':'u/anisirji · r/SideProject','url':'https://www.reddit.com/r/SideProject/'}
]
P = {p['id']:p for p in platforms}
yt = read('youtube-queue.json')
catalog = {p['id']:p for p in yt['posts']}
assets = {a['file']:a for a in read('video-assets.json')['assets']}
events=[]
def add(platform,p,source,status=None,kind=None,extra_note=''):
    canonical = catalog.get(p['id'],{})
    raw = status or p.get('status','draft')
    state = 'published' if raw=='published' else 'scheduled' if raw=='scheduled' else 'blocked' if raw in ('removed_by_reddit_filters','removed_by_moderator') else 'draft'
    # Never turn an intended slot or elapsed scheduled slot into a published timestamp.
    at = p.get('published_at') if state=='published' else p.get('scheduled_for') or p.get('at') or p.get('intended_publish_at')
    date = time = None
    if at:
        try:
            dt=datetime.fromisoformat(at.replace('Z','+00:00')).astimezone(TZ)
            date=dt.date().isoformat();time=dt.strftime('%H:%M')
        except ValueError:
            date=at[:10]
    if state=='blocked':date=p.get('date');time=None
    title=p.get('title') or p.get('topic') or p.get('angle') or canonical.get('title') or p['id'].replace('-',' ').capitalize()
    video=p.get('video') or (p.get('videos') or [None])[0] or (p.get('asset') if str(p.get('asset','')).endswith('.mp4') else None)
    if not video and platform!='reddit' and kind not in ('story','carousel','image','text'):
        video=canonical.get('video')
    slides=p.get('slides',[])
    cover=p.get('cover') or p.get('source_cover') or p.get('asset') if kind=='story' else p.get('cover') or p.get('source_cover')
    if not cover and slides:cover=slides[0]
    meta=assets.get(video,{})
    if not cover: cover=canonical.get('cover') or canonical.get('source_cover') or meta.get('cover')
    if cover and not Path(cover).is_file(): cover=None
    note=extra_note
    if platform=='personal' and state=='scheduled':
        note+=' Saved schedule last checked November 18; account access is awaiting WhatsApp verification.'
    if raw=='prepared_not_scheduled': note+=' Proposed slot only. Not scheduled; account verification is pending.'
    if kind=='story':note+=' Story image is prepared. No published or scheduled Story was confirmed.'
    events.append({'key':platform+':'+p['id'],'id':p['id'],'platform':platform,'account':p.get('calendar_account') or P[platform]['account'],'title':title,
        'status':state,'rawStatus':raw,'statusLabel':p.get('status_label',''),'questionUrl':p.get('parent_url',''),'kind':kind or p.get('type') or ('video' if video else 'text'),
        'at':at,'date':date,'time':time,'videoIds':p.get('video_ids',[p['id']]),'extraVideos':[local(v) for v in p.get('videos',[])[1:]],'caption':p.get('actual_caption') or p.get('caption') or p.get('description') or p.get('body',''),
        'video':local(video),'videoPath':video,'cover':local(cover),'slides':[local(s) for s in slides],
        'duration':meta.get('duration_seconds'),'dimensions':f"{meta['width']} × {meta['height']}" if meta.get('width') else '',
        'url':p.get('url') or p.get('permalink',''),'publisher':P[platform]['url'],
        'scheduler':p.get('scheduler') or ('LinkedIn native' if platform=='linkedin' else ''),
        'verified':p.get('native_list_verified_at') or p.get('verified_at') or p.get('confirmed_at') or '',
        'confirmation':p.get('confirmation') or p.get('verification') or '',
        'note':note.strip(),'source':source,'sourceUrl':(ROOT/source).as_uri()})

for f,platform in [('youtube-queue.json','youtube'),('facebook-queue.json','facebook'),('instagram-queue.json','instagram'),('linkedin-video-completion-queue.json','linkedin')]:
    d=read(f)
    for p in d['posts']:add(platform,p,f)
    if platform=='instagram':
        for p in d.get('already_published',[]):add(platform,{'id':p['id'],'title':catalog[p['id']]['title'],'video':catalog[p['id']]['video'],**p,'status':'published'},f)
    if platform=='linkedin':add(platform,{'id':'hero','title':catalog['hero']['title'],**read('launches/linkedin-rohit.json'),**d['existing_video']},f)
personal=read('personal-instagram/queue.json')
for p in personal['reels']:add('personal',p,'personal-instagram/queue.json')
for p in personal['supporting_posts']:add('personal',p,'personal-instagram/queue.json',kind=p['type'])
for p in read('personal-instagram/video-completion-queue.json')['posts']:
    add('personal',p,'personal-instagram/video-completion-queue.json')
for p in read('personal-instagram/stories/queue.json')['entries']:
    base=catalog.get(p['id'].removeprefix('story-'),{})
    add('personal',{**p,'title':'Story: '+base.get('title',p['id'].removeprefix('story-').replace('-',' ').capitalize())},'personal-instagram/stories/queue.json',kind='story')
for f in ['launches/linkedin-rohit-followups.json','launches/linkedin-rohit-updates.json']:
    for p in read(f)['posts']:add('linkedin',p,f,kind='video' if p.get('asset') else 'text')
for f in ['launches/reddit-sideproject.json','launches/reddit-sideproject-revised-2026-11-19.json','launches/reddit-sideproject-humanizer-draft-2026-11-19.json']:
    p=read(f);p['id']=p.get('reddit_id','humanizer-draft');add('reddit',p,f,kind='text' if 'humanizer' in f else 'launch',extra_note='Moderator review is the next step. No moderator message delivery has been confirmed.')

x_path=ROOT/'x/queue.json'
if x_path.exists():
    xq=read('x/queue.json')
    for p in xq.get('published',[])+xq.get('posts',[]):
        add('x',p,'x/queue.json',kind='video',extra_note='X account discoverability is currently limited. The second signed-in account is suspended and has no scheduled posts.')
    for p in xq.get('community_posts',[]):
        add('x',p,'x/queue.json',kind='text',extra_note='Posted to the Vibe Coding community; quotes the existing hospital story + demo launch.')

# Keep researched questions separate from scheduled publishing entries. Only actual
# reply attempts appear on the dated calendar; research-only leads stay in their list.
outreach_questions={}
outreach_records=[]
outreach_guidance={}
for path in sorted((ROOT/'outreach').glob('*.json')):
    source=str(path.relative_to(ROOT));log=read(source)
    outreach_records.append(log)
    outreach_guidance=log.get('reply_guidance',outreach_guidance)
    for q in log.get('questions',[]):
        outreach_questions[q['url']]={**q,'sourceUrl':path.as_uri()}
    for i,post in enumerate(log.get('posts',[])):
        if post.get('status') not in ('removed_by_moderator','published','sent','needs_verification'): continue
        community=post.get('parent_url','').split('/r/')[-1].split('/')[0]
        record={**post,'id':'reply-'+post.get('reddit_id',log['date']+'-'+str(i)),
                'title':'Reply: Claude Code approvals away from the computer',
                'body':post.get('reply',''),'url':post.get('reply_url',''),
                'date':log['date'],'calendar_account':post.get('account','')+' · r/'+community,
                'status_label':'Removed' if post.get('status')=='removed_by_moderator' else '',
                'scheduler':'Reddit native'}
        # A sent/owner-visible response is not automatically a publicly published one.
        if record['status']=='sent': record['status']='needs_verification'
        add('reddit',record,source,kind='reply',extra_note=post.get('verification',''))
outreach={'questions':list(outreach_questions.values()),'records':outreach_records,
          'guidance':outreach_guidance,'sourceUrl':(ROOT/'outreach/README.md').as_uri()}

keys=[e['key'] for e in events]
assert len(keys)==len(set(keys)), 'Duplicate calendar event'
# Each completed platform must retain all 18 distinct finished videos.
for platform in ['youtube','facebook','instagram','linkedin','personal']:
    selected=[e for e in events if e['platform']==platform and e['id'] in catalog and e['kind']!='story']
    assert len(selected)==18,(platform,len(selected))
    if platform!='personal': assert all(e['status'] in ('published','scheduled') for e in selected)
assert sum(e['platform']=='personal' and e['rawStatus']=='prepared_not_scheduled' for e in events)==4
assert sum(e['platform']=='linkedin' and e['status']=='scheduled' for e in events)==23
assert all(e['date'] and e['time'] for e in events if e['status']=='scheduled')
assert all(not e['videoPath'] or Path(e['videoPath']).is_file() for e in events)
data={'generatedAt':datetime.now(TZ).isoformat(),'lastAudit':'2026-11-19','timezone':'Asia/Kolkata','platforms':platforms,
      'events':events,'outreach':outreach,'videoCount':18,'videoIds':list(catalog),'auditUrl':(ROOT/'PUBLISHING_AUDIT_2026-11-19.md').as_uri(),
      'planUrl':(ROOT/'research/2026-11-18-audience-and-posting-plan.md').as_uri()}
(HERE/'calendar-data.json').write_text(json.dumps(data,indent=2,ensure_ascii=False)+'\n')
blob=json.dumps(data,ensure_ascii=False).replace('<','\\u003c').replace('\u2028','\\u2028').replace('\u2029','\\u2029')
html=(HERE/'template.html').read_text().replace('__CALENDAR_DATA__',blob)
(HERE/'index.html').write_text(html)
print(json.dumps({'calendar':str(HERE/'index.html'),'events':len(events),'states':dict(Counter(e['status'] for e in events))}))
