'use strict';
const $ = id => document.getElementById(id);
const state = { day: today(), followToday: true, snapshot: null, editing: null, pending: null, busy: false, undo: null, toastTimer: null, shareURL: '', timeMode:'relative', offset:0, preservedTime:null };
function today() { return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date()); }
function localDateTime(value = new Date()) { const d = new Date(value); return new Intl.DateTimeFormat('sv-SE', {timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(d).replace(' ', 'T'); }
function uid() { return 'web-' + Date.now().toString(36) + '-' + Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2,'0')).join(''); }
function el(tag, text, className) { const node = document.createElement(tag); if(text !== undefined) node.textContent = text; if(className) node.className=className; return node; }
function remember(key, value) { try { localStorage.setItem(key, value); } catch {} }
function recalled(key) { try { return localStorage.getItem(key); } catch { return null; } }
async function api(path, options = {}) {
  let response;
  try { response = await fetch(path, {cache:'no-store', ...options, headers:{'Content-Type':'application/json', ...options.headers}}); }
  catch { throw new Error('连接暂时中断，尚未确认保存结果。请连上家里 Wi-Fi 后重试。'); }
  let body; try { body = await response.json(); } catch { throw new Error('服务返回异常，请稍后重试。'); }
  if (!body.success) { const error = new Error(body.error?.message || '操作失败，请重试'); error.code=body.error?.code; if(response.status===401) showScan(); throw error; }
  return body.data;
}
function showScan() { $('main-content').classList.add('hidden'); $('mobile-add').classList.add('hidden'); $('share-button').classList.add('hidden'); $('settings-button').classList.add('hidden'); $('caregivers-button').classList.add('hidden'); for(const id of ['settings-dialog','caregivers-dialog'])if($(id).open)$(id).close(); $('scan-screen').classList.remove('hidden'); }
function babyTitle(name) { return name ? name+'的小奶瓶' : '小奶瓶'; }
function applyCaregivers(options) {
  const changed=state.caregiverOptions?.version!==options.version;
  state.caregiverOptions=options;
  $('caregivers-button').classList.remove('hidden');
  if(changed&&$('record-dialog').open)renderCaregiverChoices();
}
function renderCaregiverChoices() {
  const value=$('caregiver-name').value.trim(), names=state.caregiverOptions?.names||[];
  const container=$('caregiver-options');container.replaceChildren();
  for(const name of names){
    const label=el('label'),radio=el('input');radio.type='radio';radio.name='caregiver';radio.value=name;radio.checked=name===value;
    radio.addEventListener('change',()=>{$('caregiver-name').value=name;$('remember-caregiver').checked=false;$('remember-caregiver-label').classList.add('hidden');state.pending=null;});
    label.append(radio,el('span',name));container.append(label);
  }
  const custom=Boolean(value&&!names.includes(value));
  $('remember-caregiver-label').classList.toggle('hidden',!custom);
  if(!custom)$('remember-caregiver').checked=false;
}
function caregiverError(message){$('caregivers-error').textContent=message;$('caregivers-error').classList.remove('hidden');}
function caregiverRow(name){
  const row=el('div',undefined,'caregiver-row'),input=el('input'),remove=el('button','移除','text-button');
  input.type='text';input.value=name;input.maxLength=20;input.className='name-input';input.setAttribute('aria-label','常用记录人称呼');
  remove.type='button';remove.setAttribute('aria-label','移除'+name);remove.addEventListener('click',()=>row.remove());row.append(input,remove);$('caregiver-rows').append(row);
}
function populateCaregivers(options){
  state.caregiversVersion=options.version;$('caregiver-rows').replaceChildren();options.names.forEach(caregiverRow);$('new-caregiver').value='';$('caregivers-error').classList.add('hidden');
}
async function openCaregivers(){
  try{const options=await api('/api/caregivers');applyCaregivers(options);populateCaregivers(options);$('caregivers-dialog').showModal();}catch(error){toast(error.message);}
}
async function saveCaregivers(event){
  event.preventDefault();if(state.savingCaregivers)return;
  if($('new-caregiver').value.trim()){caregiverError('新称呼还没添加，请先点“添加”，或清空输入后保存。');return;}
  const names=[...document.querySelectorAll('#caregiver-rows input')].map(input=>input.value.trim());
  if(!names.length||names.length>12||names.some(name=>!name||Array.from(name).length>20)||new Set(names).size!==names.length){caregiverError('请保留1至12位不同的记录人，每个称呼1至20字。');return;}
  state.savingCaregivers=true;$('caregivers-save').disabled=true;$('caregivers-dismiss').disabled=true;
  try{const options=await api('/api/caregivers',{method:'PUT',body:JSON.stringify({names,version:state.caregiversVersion})});applyCaregivers(options);$('caregivers-dialog').close();toast('常用名单已更新，历史记录保持原样');}
  catch(error){
    if(error.code==='CAREGIVERS_CONFLICT')try{const latest=await api('/api/caregivers');applyCaregivers(latest);populateCaregivers(latest);error.message='家人已更新名单，已加载最新设置。你可以继续修改或关闭。';}catch{}
    caregiverError(error.message);
  }finally{state.savingCaregivers=false;$('caregivers-save').disabled=false;$('caregivers-dismiss').disabled=false;}
}
function applySettings(settings) {
  state.settings=settings;
  const title=babyTitle(settings.baby_name);
  document.title=title;$('brand-title').textContent=title;$('brand-link').setAttribute('aria-label',title+'首页');
  $('family-caption').textContent=settings.baby_name?settings.baby_name+'的小日常':'宝宝的小日常';
  $('settings-button').classList.remove('hidden');
  if(!settings.setup_complete&&!state.namePrompted){state.namePrompted=true;openSettings(settings);}
}
function openSettings(settings) {
  state.settingsVersion=settings.version;
  state.firstSetup=!settings.setup_complete;
  $('settings-title').textContent=state.firstSetup?'宝宝叫什么昵称？':'修改宝宝昵称';
  $('baby-name').value=settings.baby_name;$('name-preview').textContent=babyTitle(settings.baby_name);
  $('settings-skip').classList.toggle('hidden',!state.firstSetup);$('settings-error').classList.add('hidden');
  $('settings-dialog').showModal();
}
async function saveSettings(name) {
  if(state.savingSettings)return;
  state.savingSettings=true;
  for(const id of ['settings-save','settings-skip','settings-dismiss'])$(id).disabled=true;
  $('settings-error').classList.add('hidden');
  try {
    const settings=await api('/api/settings',{method:'PUT',body:JSON.stringify({baby_name:name.trim(),version:state.settingsVersion})});
    applySettings(settings);$('settings-dialog').close();toast(settings.baby_name?'宝宝昵称已保存':'已使用“小奶瓶”');
  } catch(error) {
    if(error.code==='SETTINGS_CONFLICT') {
      try {
        const latest=await api('/api/settings');
        applySettings(latest);openSettings(latest);
        error.message='家人已更新昵称，已为你加载最新设置。你可以继续修改，也可以直接关闭。';
      } catch(refreshError) {
        error.message='家人已更新昵称，暂时无法读取最新设置。请关闭后重新打开，或稍后重试。';
      }
    }
    $('settings-error').textContent=error.message;$('settings-error').classList.remove('hidden');
  } finally {
    state.savingSettings=false;
    for(const id of ['settings-save','settings-skip','settings-dismiss'])$(id).disabled=false;
  }
}
function toast(text, undo = null) {
  clearTimeout(state.toastTimer); state.undo=undo; $('toast-text').textContent=text; $('undo-button').classList.toggle('hidden', !undo); $('toast').classList.remove('hidden');
  state.toastTimer=setTimeout(() => { $('toast').classList.add('hidden'); state.undo=null; }, undo ? 15000 : 4500);
}
function formatDay(day) { const d=new Date(day+'T12:00:00+08:00'); return new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'long',day:'numeric',weekday:'long'}).format(d); }
function updateLatest() {
  const latest=state.snapshot?.latest;
  if(!latest) { $('last-time').textContent='还没有记录'; $('last-detail').textContent='记下第一顿吧'; return; }
  const mins=Math.max(0,Math.floor((Date.now()-Date.parse(latest.fed_at))/60000));
  const prefix=latest.fed_at.slice(0,10)===today() ? '' : latest.fed_at.slice(5,10).replace('-','/')+' ';
  $('last-time').textContent=prefix+latest.fed_at.slice(11,16);
  $('last-detail').textContent=latest.amount_ml+' 毫升 · '+(mins<1?'刚刚':mins<60?mins+'分钟前':mins<1440?Math.floor(mins/60)+'小时'+(mins%60?mins%60+'分':'')+'前':Math.floor(mins/1440)+'天前');
}
function render(data) {
  state.snapshot=data;
  applySettings(data.settings);
  applyCaregivers(data.caregivers);
  const isToday=state.day===today();
  $('today-label').textContent=(isToday?'今天 · ':'')+formatDay(state.day);
  $('summary-label').textContent=isToday?'今日已喝':'当日已喝'; $('list-title').textContent=isToday?'今天的每一顿':formatDay(state.day)+'的记录';
  $('total').textContent=data.total_ml; $('count-pill').textContent=data.count+' 顿'; $('view-date').value=state.day; $('view-date').max=today(); $('next-day').disabled=state.day>=today();
  updateLatest();
  const container=$('records'); container.replaceChildren();
  if(!data.records.length) { const box=el('div',undefined,'empty-state'); box.append(el('span','♡','empty-icon'),el('h3',isToday?'今天的第一顿，等你来记':'这一天还没有记录'),el('p',isToday?'点下面的“记一顿奶”，\n把这一顿好好记下来。':'可以补记这一天实际喝下的奶量。')); container.append(box); }
  for(const r of data.records) {
    const article=el('article',undefined,'record'); article.dataset.recordId=r.id;
    article.append(el('time',r.fed_at.slice(11,16),'record-time'));
    const main=el('div',undefined,'record-main'), amount=el('strong',String(r.amount_ml)); amount.append(el('small','毫升')); main.append(amount);
    main.append(el('div',r.caregiver+'记录'+(r.note?' · '+r.note:''),'record-meta')); article.append(main);
    const edit=el('button',undefined,'edit-button'); edit.setAttribute('aria-label','修改'+r.fed_at.slice(11,16)+'的'+r.amount_ml+'毫升记录');
    edit.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m16 3 5 5L8 21H3v-5zM13 6l5 5"/></svg>';
    edit.addEventListener('click',()=>openForm(r));article.append(edit);container.append(article);
  }
  const days=$('day-list'); days.replaceChildren();
  for(const d of data.days) { const b=el('button',d.day.slice(5).replace('-','/'),'day-chip'+(d.day===state.day?' active':'')); b.append(el('small',d.total_ml+'毫升 · '+d.count+'顿')); b.addEventListener('click',()=>chooseDay(d.day));days.append(b); }
  renderCharts(data);
}
function svgNode(tag, attributes={}, text) {
  const node=document.createElementNS('http://www.w3.org/2000/svg',tag);
  for(const [key,value] of Object.entries(attributes))node.setAttribute(key,String(value));
  if(text!==undefined)node.textContent=text;
  return node;
}
function drawChart(id,points,{daily=false,label,readout}) {
  const container=$(id);container.replaceChildren();
  const W=360,H=195,left=43,right=344,top=24,bottom=153;
  const valid=points.filter(p=>p.value!==null);
  const peak=Math.max(0,...valid.map(p=>p.value));
  const step=peak<=300?50:peak<=1000?100:200;
  const ceiling=Math.max(100,Math.ceil(peak/step)*step);
  const x=(p,i)=>left+(daily?p.minute/1440:i/Math.max(1,points.length-1))*(right-left);
  const y=value=>bottom-value/ceiling*(bottom-top);
  const svg=svgNode('svg',{viewBox:`0 0 ${W} ${H}`,role:'group',tabindex:0,'aria-label':label+'，点按或用左右方向键查看数值',class:'milk-chart-svg'});
  svg.append(svgNode('title',{},label));
  svg.append(svgNode('text',{x:left,y:12,class:'chart-unit'},'毫升'));
  for(const value of [0,ceiling/2,ceiling]) {
    svg.append(svgNode('line',{x1:left,x2:right,y1:y(value),y2:y(value),class:'chart-grid'}));
    svg.append(svgNode('text',{x:left-8,y:y(value)+4,'text-anchor':'end',class:'chart-axis'},String(value)));
  }
  for(const tick of daily?[0,6,12,18,24]:[0,7,14,21,29]) {
    const tx=left+(daily?tick/24:tick/29)*(right-left);
    const text=daily?String(tick).padStart(2,'0')+':00':points[tick]?.date.slice(5).replace('-','/');
    svg.append(svgNode('text',{x:tx,y:176,'text-anchor':daily&&tick===24?'end':tick===29?'end':'middle',class:'chart-axis'},text||''));
  }
  let segment=[];
  function appendSegment() {
    if(segment.length>1)svg.append(svgNode('polyline',{points:segment.join(' '),class:'chart-line'}));
    segment=[];
  }
  points.forEach((p,i)=>{if(p.value===null){appendSegment();return;}segment.push(`${x(p,i)},${y(p.value)}`);});appendSegment();
  points.forEach((p,i)=>{if(p.value!==null)svg.append(svgNode('circle',{cx:x(p,i),cy:y(p.value),r:3.7,class:'chart-dot'}));});
  if(!valid.length)svg.append(svgNode('text',{x:(left+right)/2,y:83,'text-anchor':'middle',class:'chart-empty'},'暂无喝奶记录'));
  const guide=svgNode('line',{x1:0,x2:0,y1:top,y2:bottom,class:'chart-guide hidden'});
  const selected=svgNode('circle',{r:5.5,cx:0,cy:0,class:'chart-selected hidden'});svg.append(guide,selected);
  let index=Math.max(0,points.length-1);
  function select(next) {
    if(!points.length){$(readout).textContent='记录后即可看到曲线';return;}
    index=Math.max(0,Math.min(points.length-1,next));
    const p=points[index],px=x(p,index);guide.setAttribute('x1',px);guide.setAttribute('x2',px);guide.classList.remove('hidden');
    selected.classList.toggle('hidden',p.value===null);
    if(p.value!==null){selected.setAttribute('cx',px);selected.setAttribute('cy',y(p.value));}
    $(readout).textContent=daily?`${p.time} · ${p.value} 毫升`:`${p.date.slice(5).replace('-','/')} · ${p.value===null?'暂无记录':p.value+' 毫升 · '+p.count+' 顿'}`;
  }
  svg.addEventListener('pointerdown',event=>{
    const rect=svg.getBoundingClientRect(),px=(event.clientX-rect.left)/rect.width*W;
    let closest=0;points.forEach((p,i)=>{if(Math.abs(x(p,i)-px)<Math.abs(x(points[closest],closest)-px))closest=i;});select(closest);
  });
  svg.addEventListener('keydown',event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();select(event.key==='Home'?0:event.key==='End'?points.length-1:index+(event.key==='ArrowLeft'?-1:1));}});
  container.append(svg);select(index);
}
function renderCharts(data) {
  const signature=JSON.stringify([data.date,data.records.map(r=>[r.id,r.amount_ml,r.fed_at]),data.trend]);
  if(state.chartSignature===signature)return;
  state.chartSignature=signature;
  $('daily-chart-date').textContent=data.date.slice(5).replace('-','/');
  const daily=[...data.records].sort((a,b)=>a.fed_at.localeCompare(b.fed_at)||a.created_at.localeCompare(b.created_at)).map(r=>({value:r.amount_ml,time:r.fed_at.slice(11,16),minute:Number(r.fed_at.slice(11,13))*60+Number(r.fed_at.slice(14,16))+Number(r.fed_at.slice(17,19))/60}));
  drawChart('daily-chart',daily,{daily:true,label:data.date+'每顿喝奶量曲线',readout:'daily-chart-value'});
  const trend=(data.trend||[]).map(p=>({...p,value:p.total_ml}));
  $('trend-chart-range').textContent=data.trend_start?data.trend_start.slice(5).replace('-','/')+'—'+data.trend_end.slice(5).replace('-','/'):'';
  const recorded=trend.filter(p=>p.value!==null);
  $('trend-chart-summary').textContent=`已记录 ${recorded.reduce((sum,p)=>sum+p.value,0)} 毫升 · ${recorded.length} 天有记录`;
  drawChart('trend-chart',trend,{label:'截至'+data.date+'近30天每日总奶量曲线',readout:'trend-chart-value'});
  const table=$('trend-chart-table');table.replaceChildren();
  for(const point of [...trend].reverse()){const row=el('tr');row.append(el('td',point.date),el('td',point.value===null?'暂无记录':point.value+' 毫升'),el('td',point.value===null?'—':String(point.count)));table.append(row);}
}
let loadSequence=0;
async function load({quiet=false}={}) {
  if(state.followToday)state.day=today();
  const seq=++loadSequence, day=state.day;
  try { const data=await api('/api/records?date='+day); if(seq!==loadSequence)return; render(data); $('connection').classList.add('hidden'); }
  catch(error) { if(seq!==loadSequence)return; if(error.code==='SCAN_REQUIRED')return; $('connection').textContent=state.snapshot?'连接中断，当前显示上次读取的记录。恢复后会自动更新。':error.message; $('connection').classList.remove('hidden'); if(!quiet && !state.snapshot)$('records').replaceChildren(el('p','暂时无法读取记录，请检查连接后点“刷新”。','empty-state')); }
}
function chooseDay(day) { state.day=day; state.followToday=day===today(); load(); }
function openForm(record=null) {
  state.editing=record;state.pending=null;$('record-form').reset();$('form-error').classList.add('hidden');
  $('form-title').textContent=record?'修改这一顿':'喝了多少奶？';$('form-eyebrow').textContent=record?'记错了，改一下就好':'记下这一顿';$('save-button').textContent=record?'保存修改':'保存这一顿';
  $('amount').value=record?record.amount_ml:'';
  const stamp=record?localDateTime(record.fed_at):state.day===today()?localDateTime():state.day+'T12:00';
  $('fed-date').value=stamp.slice(0,10);$('fed-date').max=today();$('fed-clock').value=stamp.slice(11,16);
  state.timeMode=record?'preserved':state.day===today()?'relative':'manual';state.offset=0;state.preservedTime=record?.fed_at || null;
  $('manual-time').open=state.timeMode==='manual';
  const storedPerson=record?.caregiver || recalled('milk-caregiver');
  const names=state.caregiverOptions?.names||[];
  const person=record?record.caregiver:storedPerson|| (names.includes('爸爸')?'爸爸':names[0]||'');
  $('caregiver-name').value=person;$('remember-caregiver').checked=false;renderCaregiverChoices();
  $('note').value=record?.note || '';$('delete-button').classList.toggle('hidden',!record);updateChips();updateTime();$('record-dialog').showModal();
}
function normalizeClock(value) {
  const text=value.normalize('NFKC').trim();
  const match=/^(\d{1,2}):(\d{2})$/.exec(text)||/^(\d{1,2})(\d{2})$/.exec(text);
  if(!match||Number(match[1])>23||Number(match[2])>59)return null;
  return match[1].padStart(2,'0')+':'+match[2];
}
function selectedTime() {
  if(state.timeMode==='preserved')return state.preservedTime;
  if(state.timeMode==='relative')return localDateTime(new Date(Date.now()-state.offset*60000))+':00+08:00';
  const day=$('fed-date').value,clock=normalizeClock($('fed-clock').value);
  if(!day||!clock)return null;
  return day+'T'+clock+':00+08:00';
}
function updateTime() {
  const stamp=selectedTime();
  const time=stamp?stamp.slice(11,16):'请填写时间';
  const relativeTime=stamp&&stamp.slice(0,10)!==today()?stamp.slice(5,10).replace('-','/')+' '+time:time;
  $('time-preview').textContent=state.timeMode==='relative'?(state.offset?state.offset+'分钟前':'刚刚')+' · '+relativeTime:stamp?(stamp.slice(0,10)===today()?'今天':stamp.slice(5,10).replace('-','/'))+' '+time:time;
  document.querySelectorAll('[data-offset]').forEach(b=>b.setAttribute('aria-pressed',String(state.timeMode==='relative'&&Number(b.dataset.offset)===state.offset)));
}
function updateChips() { for(const b of document.querySelectorAll('[data-amount]'))b.classList.toggle('selected',b.dataset.amount===$('amount').value); }
function formError(message) { $('form-error').textContent=message;$('form-error').classList.remove('hidden'); }
async function save(event) {
  event.preventDefault();if(state.busy)return;
  const amount=Number($('amount').value);
  if(!Number.isInteger(amount)||amount<1||amount>1000) {formError('请填写实际喝下的奶量（1至1000毫升整数）。');$('amount').focus();return;}
  const caregiver=$('caregiver-name').value.trim();
  if(!caregiver||Array.from(caregiver).length>20){formError('请选择或填写记录人，称呼为1至20字。');$('caregiver-name').focus();return;}
  const rememberCaregiver=!$('remember-caregiver-label').classList.contains('hidden')&&$('remember-caregiver').checked;
  const signature=JSON.stringify({amount,caregiver,rememberCaregiver,note:$('note').value,mode:state.timeMode,offset:state.offset,date:$('fed-date').value,clock:normalizeClock($('fed-clock').value)||$('fed-clock').value});
  // Freeze the timestamp as well as the request ID after the first attempt so
  // retrying an uncertain network response cannot create a second feeding.
  const fed=state.pending?.signature===signature?state.pending.fed:selectedTime();
  if(!fed||!Number.isFinite(Date.parse(fed))) {formError('请输入有效时间，例如1730代表17:30。');$('manual-time').open=true;return;}
  if(Date.parse(fed)>Date.now()+300000) {formError('喝奶时间不能是未来时间，请检查一下。');return;}
  const payload={amount_ml:amount,fed_at:fed,caregiver,remember_caregiver:rememberCaregiver,note:$('note').value};
  if(state.editing)payload.version=state.editing.version;
  if(!state.pending||state.pending.signature!==signature)state.pending={signature,id:uid(),fed};
  payload.request_id=state.pending.id;
  if(!state.editing && !state.pending.confirmed) {
    const similar=state.snapshot?.records.find(r=>r.amount_ml===amount&&Math.abs(Date.parse(r.fed_at)-Date.parse(payload.fed_at))<300000);
    if(similar&&!confirm('附近时间已经有一条'+amount+'毫升的记录。确定是另一顿，需要再记一次吗？'))return;
    state.pending.confirmed=true;
  }
  state.busy=true;$('save-button').disabled=true;$('form-error').classList.add('hidden');
  try {
    const path=state.editing?'/api/records/'+state.editing.id:'/api/records';
    const data=await api(path,{method:state.editing?'PUT':'POST',body:JSON.stringify(payload)});
    remember('milk-caregiver',caregiver);state.day=data.record.fed_at.slice(0,10);state.followToday=state.day===today();$('record-dialog').close();state.pending=null;
    toast(state.editing?'已修改这一顿':'已记下 '+amount+' 毫升'); await load();
  } catch(error) { formError(error.message); if(error.code==='VERSION_CONFLICT')load({quiet:true}); }
  finally {state.busy=false;$('save-button').disabled=false;}
}
async function deleteRecord() {
  const record=state.editing;if(!record||state.busy)return;
  if(!confirm('删除 '+record.fed_at.slice(11,16)+' 的 '+record.amount_ml+' 毫升记录？删除后可以马上撤销。'))return;
  state.busy=true;$('delete-button').disabled=true;
  try {const data=await api('/api/records/'+record.id,{method:'DELETE',body:JSON.stringify({version:record.version,request_id:uid()})});$('record-dialog').close();await load();toast('已删除这条记录',data.record);}
  catch(error){formError(error.message);}finally{state.busy=false;$('delete-button').disabled=false;}
}
async function undoDelete() {
  const r=state.undo;if(!r)return;$('undo-button').disabled=true;
  try {await api('/api/records/'+r.id+'/restore',{method:'POST',body:JSON.stringify({version:r.version,request_id:uid()})});await load();toast('已恢复这条记录');}
  catch(error){toast(error.message);}finally{$('undo-button').disabled=false;}
}
async function share() {
  try { const data=await api('/api/share');state.shareURL=data.url;$('share-message').textContent='';$('share-qr').src='/api/qr.svg';$('share-dialog').showModal(); }
  catch(error){toast(error.message);}
}
$('settings-button').addEventListener('click',async()=>{try{openSettings(await api('/api/settings'));}catch(error){toast(error.message);}});
$('caregivers-button').addEventListener('click',openCaregivers);$('manage-caregivers').addEventListener('click',openCaregivers);
$('caregiver-name').addEventListener('input',()=>{state.pending=null;renderCaregiverChoices();});
$('caregivers-form').addEventListener('submit',saveCaregivers);
$('add-caregiver').addEventListener('click',()=>{
  const name=$('new-caregiver').value.trim(),names=[...document.querySelectorAll('#caregiver-rows input')].map(input=>input.value.trim());
  if(!name||Array.from(name).length>20){caregiverError('请填写1至20字的称呼。');return;}
  if(names.includes(name)||names.length>=12){caregiverError(names.includes(name)?'这个称呼已在名单里。':'常用名单最多12位。');return;}
  caregiverRow(name);$('new-caregiver').value='';$('caregivers-error').classList.add('hidden');
});
$('new-caregiver').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();$('add-caregiver').click();}});
$('caregivers-dismiss').addEventListener('click',()=>{if(!state.savingCaregivers)$('caregivers-dialog').close();});
$('caregivers-dialog').addEventListener('cancel',event=>{if(state.savingCaregivers)event.preventDefault();});
$('baby-name').addEventListener('input',()=>{$('name-preview').textContent=babyTitle($('baby-name').value.trim());});
$('settings-form').addEventListener('submit',event=>{event.preventDefault();saveSettings($('baby-name').value);});
$('settings-skip').addEventListener('click',()=>saveSettings(''));
function dismissSettings(){if(!state.savingSettings)$('settings-dialog').close();}
$('settings-dismiss').addEventListener('click',dismissSettings);
$('settings-dialog').addEventListener('cancel',event=>{event.preventDefault();dismissSettings();});
document.querySelectorAll('.add-button').forEach(b=>b.addEventListener('click',()=>openForm()));
document.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',()=>$(b.dataset.close).close()));
document.querySelectorAll('[data-amount]').forEach(b=>b.addEventListener('click',()=>{$('amount').value=b.dataset.amount;updateChips();}));
document.querySelectorAll('[data-offset]').forEach(b=>b.addEventListener('click',()=>{state.timeMode='relative';state.offset=Number(b.dataset.offset);state.pending=null;$('manual-time').open=false;updateTime();}));
for(const id of ['fed-date','fed-clock'])$(id).addEventListener('input',()=>{state.timeMode='manual';updateTime();});
$('fed-clock').addEventListener('blur',()=>{const normalized=normalizeClock($('fed-clock').value);if(normalized)$('fed-clock').value=normalized;updateTime();});
for(const id of ['fed-clock','amount'])for(const event of ['focus','click'])$(id).addEventListener(event,()=>$(id).select());
$('manual-time').addEventListener('toggle',()=>{if($('manual-time').open&&$('record-dialog').open)$('fed-clock').focus();});
$('amount').addEventListener('keydown',event=>{if(event.key==='Enter'&&$('manual-time').open){event.preventDefault();$('fed-clock').focus();}});
function updateThemeChoice(){const choice=document.documentElement.dataset.themeChoice||'system';const names={light:'白天',dark:'夜间',system:'系统'};$('theme-button').setAttribute('aria-label','显示模式：'+names[choice]);$('theme-icon').textContent={light:'☀',dark:'☾',system:'◐'}[choice];document.querySelectorAll('button[data-theme-choice]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.themeChoice===choice)));}
$('theme-button').addEventListener('click',()=>{updateThemeChoice();$('theme-dialog').showModal();});
document.querySelectorAll('button[data-theme-choice]').forEach(b=>b.addEventListener('click',()=>{window.setMilkTheme(b.dataset.themeChoice);updateThemeChoice();$('theme-dialog').close();}));
updateThemeChoice();
$('amount').addEventListener('input',updateChips);$('record-form').addEventListener('submit',save);$('delete-button').addEventListener('click',deleteRecord);$('undo-button').addEventListener('click',undoDelete);
$('history-button').addEventListener('click',()=>{$('history-panel').classList.toggle('hidden');$('history-button').textContent=$('history-panel').classList.contains('hidden')?'看历史 ↗':'收起历史 ↑';});
$('view-date').addEventListener('change',event=>{if(event.target.value)chooseDay(event.target.value);});$('back-today').addEventListener('click',()=>chooseDay(today()));
function shiftDay(delta){const d=new Date(state.day+'T12:00:00+08:00');d.setUTCDate(d.getUTCDate()+delta);chooseDay(new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(d));}
$('previous-day').addEventListener('click',()=>shiftDay(-1));$('next-day').addEventListener('click',()=>shiftDay(1));$('refresh-button').addEventListener('click',()=>load());$('share-button').addEventListener('click',share);$('retry-auth').addEventListener('click',()=>location.reload());
$('copy-link').addEventListener('click',async()=>{try {if(navigator.clipboard&&window.isSecureContext)await navigator.clipboard.writeText(state.shareURL);else{const t=el('textarea');t.value=state.shareURL;document.body.append(t);t.select();const ok=document.execCommand('copy');t.remove();if(!ok)throw new Error();}$('share-message').textContent='链接已复制，可以发给家人。';}catch{$('share-message').textContent='家庭访问链接：'+state.shareURL;}});
document.addEventListener('visibilitychange',()=>{if(!document.hidden)load({quiet:true});});
setInterval(()=>{if(!document.hidden)load({quiet:true});},20000);setInterval(updateLatest,30000);
setInterval(()=>{if($('record-dialog').open&&state.timeMode==='relative')updateTime();},15000);
$('view-date').value=state.day;load();
