const FUNGIO_OPTS = ['DIRECTOR(A)','ASESOR(A)/REVISOR(A)'];
const GRADOS = [{v:'Licenciatura', n:3},{v:'Maestría', n:4},{v:'Doctorado', n:5}];

let sb = null;
let authRol = 'usuario';
let authMode = 'login';
let alumnos = [];
let docentes = [];
let expedientes = [];
let nextFolio = 1875;
let emitidos = [];
const DOC_TIPOS=['Tesis (texto final)','Acta de examen','Oficio','Constancia','Otro'];

const norm = s => (s||'').toLocaleLowerCase('es');
const sortByNombre = arr => arr.sort((a,b)=>a.nombre.localeCompare(b.nombre,'es'));
const getDocente = nombre => docentes.find(d=>d.nombre===nombre);
const getAlumno = nombre => alumnos.find(a=>a.nombre===nombre);
function toast(msg){ const t=document.getElementById('toast'); t.textContent=msg; t.classList.add('show'); clearTimeout(toast._h); toast._h=setTimeout(()=>t.classList.remove('show'), 2400); }
function showAuthMsg(msg){ const el=document.getElementById('auth-msg'); el.hidden=!msg; el.textContent=msg||''; }
function needSb(){ if(sb) return true; toast('Configura SUPABASE_KEY en config.js'); return false; }
function dateOrNull(v){ return v || null; }
function mapAlumno(row){ return { id:row.id, nombre:row.nombre, matricula:row.matricula||'', sexo:row.sexo||'', tipo:row.tipo||'', fechaReg:row.fecha_reg||'' }; }
function mapDocente(row){ return { id:row.id, nombre:row.nombre, empleado:row.empleado, telefono:row.telefono||'', correo:row.correo||'', sexo:row.sexo||'', grado:row.grado, fechaReg:row.fecha_reg||'' }; }
async function loadAll(){
  const reqs = await Promise.all([
    sb.from('alumnos').select('*'),
    sb.from('docentes').select('*'),
    sb.from('tesis').select('*').order('created_at', { ascending:true }),
    sb.from('tesis_docentes').select('*').order('folio', { ascending:true }),
    sb.from('tesis_documentos').select('*'),
    sb.from('emitidos').select('*').order('created_at', { ascending:true })
  ]);
  const bad = reqs.find(r=>r.error);
  if (bad) throw bad.error;
  const [a,d,t,td,docs,em] = reqs;
  alumnos = a.data.map(mapAlumno);
  docentes = d.data.map(mapDocente);
  const docsBy = {}, filesBy = {};
  td.data.forEach(row=>{ (docsBy[row.tesis_id] ||= []).push({ id:row.id, nombre:row.docente_nombre, fungio:row.fungio, fecha:row.fecha||'', folio:row.folio }); });
  docs.data.forEach(row=>{ (filesBy[row.tesis_id] ||= []).push({ id:row.id, tipo:row.tipo, nombre:row.nombre, size:Number(row.size)||0, fecha:row.fecha||'', url:row.url||'', storage_path:row.storage_path||'' }); });
  expedientes = t.data.map(row=>({
    id:row.id, alumno:row.alumno_nombre, grado:row.grado, titulo:row.titulo, fecha:row.fecha||'',
    ciudad:row.ciudad||'', programa:row.programa||'', punto:row.punto||'', capturo:row.capturo||'',
    archivo:row.archivo||'NO', digital:row.digital||'NO', fechacap:row.fecha_cap||'', obs:row.obs||'',
    docs:docsBy[row.id]||[], documentos:filesBy[row.id]||[]
  }));
  emitidos = em.data.map(row=>({ id:row.id, fecha:row.fecha||'', tipo:row.tipo, dest:row.dest, docente:row.docente, detalle:row.detalle }));
  const maxFolio = td.data.reduce((m,r)=>Math.max(m, r.folio||0), 1874);
  nextFolio = maxFolio + 1;
}
async function saveEmitido(row){
  if (!needSb()) return false;
  const { data, error } = await sb.from('emitidos').insert(row).select().single();
  if (error) { toast(error.message); return false; }
  emitidos.push({ ...row, id:data.id });
  return true;
}
async function uploadDoc(tesisId, file, tipo, fecha){
  const path = `${tesisId}/${Date.now()}_${file.name.replace(/[^\w.\-]+/g,'_')}`;
  const up = await sb.storage.from('documentos').upload(path, file);
  if (up.error) throw up.error;
  const url = sb.storage.from('documentos').getPublicUrl(path).data.publicUrl;
  const { data, error } = await sb.from('tesis_documentos').insert({ tesis_id:tesisId, tipo, nombre:file.name, size:file.size, fecha:dateOrNull(fecha), url, storage_path:path }).select().single();
  if (error) throw error;
  return { id:data.id, tipo, nombre:file.name, size:file.size, fecha, url, storage_path:path };
}
function pillGrado(g){ const cls=g==='Licenciatura'?'lic':(g==='Maestría'?'mae':'doc'); return `<span class="pill ${cls}">${g}</span>`; }
function pillSN(v){ return v==='SI' ? `<span class="pill si">SI</span>` : `<span class="pill no">NO</span>`; }
const today=()=>new Date().toISOString().slice(0,10);
const isDir=f=>f.startsWith('DIRECTOR');
const cargoKey=f=>isDir(f)?'DIR':'ASE';
const MESES=['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
const mesTxt=m=>{ if(!m) return ''; const [y,mm]=m.split('-'); return MESES[+mm-1]+' de '+y; };
const fechaLarga=iso=>(iso?new Date(iso+'T12:00:00'):new Date()).toLocaleDateString('es-MX',{day:'numeric',month:'long',year:'numeric'});
const fmtSize=b=>b>1048576?(b/1048576).toFixed(1)+' MB':Math.max(1,Math.round(b/1024))+' KB';
function cargoTxt(f,nombre){ const fem=(getDocente(nombre)||{}).sexo==='F'; return isDir(f)?(fem?'directora':'director'):(fem?'asesora/revisora':'asesor/revisor'); }
function consecutivos(){ const m={}, c={};
  flatRows().slice().sort((a,b)=>a.e.fecha.localeCompare(b.e.fecha)||a.d.folio-b.d.folio).forEach(r=>{ const k=r.d.nombre+'|'+cargoKey(r.d.fungio); c[k]=(c[k]||0)+1; m[r.d.folio]=c[k]; });
  return m; }
function pad4(n){ return String(n).padStart(4,'0'); }
function flatRows(){ const rows=[]; expedientes.forEach((e,ei)=>e.docs.forEach((d,di)=>rows.push({e,ei,d,di}))); return rows.sort((a,b)=>a.d.folio-b.d.folio); }

document.body.classList.add('role-admin');
document.getElementById('role-admin').addEventListener('click', ()=>setRole('admin'));
document.getElementById('role-usuario').addEventListener('click', ()=>setRole('usuario'));
function setRole(role, silent){
  if (authRol !== 'admin') role = 'usuario';
  document.body.classList.remove('role-admin','role-usuario');
  document.body.classList.add('role-'+role);
  document.getElementById('role-admin').classList.toggle('on', role==='admin');
  document.getElementById('role-usuario').classList.toggle('on', role==='usuario');
  if (!silent) toast(role==='admin' ? 'Modo administrador — edición completa habilitada' : 'Modo usuario — solo lectura, sin permisos de edición');
}

function goTab(name){
  document.querySelectorAll('.tab').forEach(b=>b.classList.toggle('active', b.dataset.tab===name));
  document.querySelectorAll('.section').forEach(s=>s.classList.remove('active'));
  document.getElementById('sec-'+name).classList.add('active');
  if(name==='alumnos') renderAlumnos();
  if(name==='docentes') renderDocentes();
  if(name==='actividad') renderActividad();
  if(name==='constancias') { renderConstModo(); renderConstFilters(); renderConstanciasSelect(); renderConcentrado(); }
  if(name==='bd') renderBD();
  if(name==='busqueda') renderBusqueda();
  if(name==='asignacion') renderAsignacion();
  if(name==='historial') renderHistorial();
}
document.querySelectorAll('.tab').forEach(b=>b.addEventListener('click', ()=>goTab(b.dataset.tab)));
document.getElementById('brand-home').addEventListener('click', ()=>goTab('inicio'));
document.querySelectorAll('.menubtn').forEach(b=>{
  b.addEventListener('click', ()=>{
    goTab(b.dataset.go);
    if(b.dataset.punto) { window._constPuntoFilter = b.dataset.punto; renderConstFilters(); renderConstanciasSelect(); }
  });
});

/* REGISTRO */
let rGradoSel = null, rSlots = [];

function renderGradoRow(){
  const wrap = document.getElementById('r-gradorow');
  wrap.innerHTML = GRADOS.map(g=>`<button type="button" class="gradobtn ${rGradoSel===g.v?'sel':''}" data-g="${g.v}">${g.v}<small>${g.n} docentes</small></button>`).join('');
  wrap.querySelectorAll('.gradobtn').forEach(b=>{
    b.addEventListener('click', ()=>{
      rGradoSel = b.dataset.g;
      const n = GRADOS.find(g=>g.v===rGradoSel).n;
      rSlots = Array.from({length:n}, ()=>({nombre:'', fungio:'', fecha:today()}));
      renderGradoRow(); renderDocSlots();
      toast(`Grado: ${rGradoSel} — se muestran ${n} campos de docente`);
    });
  });
}
function updateHint(i){ const s=rSlots[i], el=document.getElementById('hint-'+i); if(!el) return;
  const d=getDocente(s.nombre); if(!d||!s.fungio){ el.textContent=''; return; }
  const k=cargoKey(s.fungio), prev=flatRows().filter(r=>r.d.nombre===d.nombre&&cargoKey(r.d.fungio)===k).length;
  el.textContent='🔢 Será su tesis No. '+(prev+1)+' como '+s.fungio; }
function renderDocSlots(){
  const wrap = document.getElementById('r-docslots');
  if(!rGradoSel){ wrap.innerHTML = `<p class="lede" style="margin:0;">Elige un grado para mostrar los campos de docente correspondientes.</p>`; return; }
  wrap.innerHTML = rSlots.map((s,i)=>`
    <div class="docslot"><span class="tag">Docente ${i+1}</span>
      <div class="row3">
        <div class="field autowrap" style="margin-bottom:0;"><label>Nombre</label>
          <input class="doc-input" data-i="${i}" autocomplete="off" placeholder="Escribe para buscar…" value="${s.nombre}">
          <div class="suggestions" id="sugg-${i}"></div>
        </div>
        <div class="field" style="margin-bottom:0;"><label>Fungió</label>
          <select class="doc-fungio" data-i="${i}"><option value="">Selecciona…</option>${FUNGIO_OPTS.map(o=>`<option ${s.fungio===o?'selected':''}>${o}</option>`).join('')}</select>
        </div>
        <div class="field" style="margin-bottom:0;"><label>Fecha de asignación</label><input type="date" class="doc-fecha" data-i="${i}" value="${s.fecha||''}"></div>
      </div><small class="synctag" id="hint-${i}" style="display:block;margin-top:8px;"></small></div>`).join('');
  wrap.querySelectorAll('.doc-input').forEach(inp=>{
    const i = +inp.dataset.i; const sugg = document.getElementById('sugg-'+i);
    inp.addEventListener('input', ()=>{
      rSlots[i].nombre = inp.value; updateHint(i); const q = norm(inp.value);
      if(!q){ sugg.classList.remove('show'); return; }
      const matches = docentes.filter(d=>norm(d.nombre).includes(q)).sort((a,b)=>a.nombre.localeCompare(b.nombre,'es')).slice(0,7);
      sugg.innerHTML = matches.length ? matches.map(d=>`<div data-n="${d.nombre.replace(/"/g,'&quot;')}">${d.nombre}<span class="badge">${d.grado}</span></div>`).join('') : `<div class="none">Sin coincidencias entre docentes registrados</div>`;
      sugg.classList.add('show');
      sugg.querySelectorAll('div[data-n]').forEach(opt=>opt.addEventListener('click', ()=>{ inp.value=opt.dataset.n; rSlots[i].nombre=opt.dataset.n; updateHint(i); sugg.classList.remove('show'); }));
    });
    inp.addEventListener('blur', ()=> setTimeout(()=>sugg.classList.remove('show'), 150));
  });
  wrap.querySelectorAll('.doc-fecha').forEach(f=>f.addEventListener('change',()=>{ rSlots[+f.dataset.i].fecha=f.value; }));
  wrap.querySelectorAll('.doc-fungio').forEach(sel=>sel.addEventListener('change', ()=>{ rSlots[+sel.dataset.i].fungio = sel.value; updateHint(+sel.dataset.i); }));
}
(function(){
  const inp = document.getElementById('r-alumno'), sugg = document.getElementById('sugg-alumno');
  inp.addEventListener('input', ()=>{
    const q = norm(inp.value);
    if(!q){ sugg.classList.remove('show'); return; }
    const matches = alumnos.filter(a=>norm(a.nombre).includes(q)).sort((a,b)=>a.nombre.localeCompare(b.nombre,'es')).slice(0,7);
    sugg.innerHTML = matches.length ? matches.map(a=>`<div data-n="${a.nombre.replace(/"/g,'&quot;')}">${a.nombre}<span class="badge">${a.tipo}</span></div>`).join('') : `<div class="none">Nuevo alumno — se registrará con este nombre</div>`;
    sugg.classList.add('show');
    sugg.querySelectorAll('div[data-n]').forEach(opt=>opt.addEventListener('click', ()=>{ inp.value=opt.dataset.n; sugg.classList.remove('show'); }));
  });
  inp.addEventListener('blur', ()=> setTimeout(()=>sugg.classList.remove('show'), 150));
})();

document.getElementById('r-guardar').addEventListener('click', async ()=>{
  const alumno = document.getElementById('r-alumno').value.trim();
  const titulo = document.getElementById('r-titulo').value.trim();
  if(!alumno || !titulo || !rGradoSel){ toast('Falta alumno, título o grado.'); return; }
  if(!needSb()) return;
  const btn = document.getElementById('r-guardar');
  btn.disabled = true;
  let tesisId = null;
  try {
    let alumnoRow = getAlumno(alumno);
    if(!alumnoRow){
      const ins = await sb.from('alumnos').insert({ nombre:alumno, matricula:'', sexo:'', tipo:document.getElementById('r-programa').value, fecha_reg:today() }).select().single();
      if(ins.error) throw ins.error;
      alumnoRow = mapAlumno(ins.data);
      alumnos.push(alumnoRow);
    }
    const tesisIns = await sb.from('tesis').insert({
      alumno_id: alumnoRow.id || null,
      alumno_nombre: alumno,
      grado: rGradoSel,
      titulo,
      fecha: dateOrNull(document.getElementById('r-fecha').value || today()),
      ciudad: document.getElementById('r-ciudad').value,
      programa: document.getElementById('r-programa').value,
      punto: document.getElementById('r-punto').value,
      capturo: document.getElementById('r-capturo').value,
      archivo: document.getElementById('r-archivo').value,
      digital: document.getElementById('r-digital').value,
      fecha_cap: dateOrNull(document.getElementById('r-fechacap').value || today()),
      obs: document.getElementById('r-obs').value
    }).select().single();
    if(tesisIns.error) throw tesisIns.error;
    tesisId = tesisIns.data.id;
    const slots = rSlots.filter(s=>s.nombre.trim());
    for (const s of slots) {
      const folioRes = await sb.rpc('next_folio');
      if(folioRes.error) throw folioRes.error;
      const doc = getDocente(s.nombre.trim());
      const rowIns = await sb.from('tesis_docentes').insert({
        tesis_id: tesisId,
        docente_id: doc ? doc.id : null,
        docente_nombre: s.nombre.trim(),
        fungio: s.fungio || FUNGIO_OPTS[1],
        fecha: dateOrNull(s.fecha || today()),
        folio: folioRes.data
      });
      if(rowIns.error) throw rowIns.error;
    }
    for (const doc of rDocs) {
      if (doc.file) await uploadDoc(tesisId, doc.file, doc.tipo, doc.fecha);
    }
    await loadAll();
    toast(`Tesis guardada — No. de Tesis ${expedientes.length}, ${slots.length} folio(s) generado(s)`);
    resetRegistro();
  } catch (err) {
    if (tesisId) await sb.from('tesis').delete().eq('id', tesisId);
    toast(err.message || 'No se pudo guardar la tesis');
  } finally {
    btn.disabled = false;
  }
});
document.getElementById('r-limpiar').addEventListener('click', resetRegistro);
function resetRegistro(){
  ['r-alumno','r-titulo','r-fecha','r-capturo','r-fechacap','r-obs'].forEach(id=>document.getElementById(id).value='');
  rGradoSel = null; rSlots = []; rDocs = []; renderRDocs();
  renderGradoRow(); renderDocSlots();
}
renderGradoRow(); renderDocSlots();

let rDocs=[];
document.getElementById('rd-tipo').innerHTML=DOC_TIPOS.map(t=>`<option>${t}</option>`).join('');
function renderRDocs(){
  document.getElementById('rd-list').innerHTML = rDocs.length ? `<div class="tablewrap"><table><thead><tr><th>Tipo</th><th>Archivo</th><th>Tamaño</th><th>Fecha</th><th></th></tr></thead><tbody>${rDocs.map((x,i)=>`<tr><td>${x.tipo}</td><td>${x.nombre}</td><td>${fmtSize(x.size)}</td><td>${x.fecha}</td><td><a class="editlink rd-del" data-i="${i}">Quitar</a></td></tr>`).join('')}</tbody></table></div>` : '<p class="lede" style="margin:0;">Aún no se han agregado documentos.</p>';
  document.querySelectorAll('.rd-del').forEach(a=>a.addEventListener('click',()=>{ rDocs.splice(+a.dataset.i,1); renderRDocs(); }));
}
document.getElementById('rd-add').addEventListener('click',()=>{
  const f=document.getElementById('rd-file').files[0];
  if(!f){ toast('Elige un archivo primero.'); return; }
  rDocs.push({ tipo:document.getElementById('rd-tipo').value, nombre:f.name, size:f.size, fecha:document.getElementById('rd-fecha').value||today(), url:URL.createObjectURL(f), file:f });
  document.getElementById('rd-file').value=''; renderRDocs(); toast('Documento agregado a la tesis');
});
renderRDocs();

/* ALUMNOS */
function tesisCountAlumno(nombre){ return expedientes.filter(e=>e.alumno===nombre).length; }
function renderAlumnos(){
  sortByNombre(alumnos);
  document.getElementById('a-count').textContent = alumnos.length;
  document.getElementById('a-tbody').innerHTML = alumnos.map((a,i)=>`
    <tr class="${a._new?'flash':''}">
      <td>${a.nombre}</td><td>${a.matricula||'—'}</td><td>${a.sexo||'—'}</td><td>${a.tipo||'—'}</td>
      <td>${a.fechaReg||'—'}</td><td>${tesisCountAlumno(a.nombre)}</td>
      <td><button class="btn ghost small del-alu admin-only" data-i="${i}">Quitar</button></td>
    </tr>`).join('');
  alumnos.forEach(a=>delete a._new);
  document.querySelectorAll('.del-alu').forEach(b=>b.addEventListener('click', async ()=>{
    if(!needSb()) return;
    const a = alumnos[+b.dataset.i];
    const { error } = await sb.from('alumnos').delete().eq('id', a.id);
    if(error){ toast(error.message); return; }
    alumnos.splice(+b.dataset.i,1);
    renderAlumnos();
  }));
}
document.getElementById('a-agregar').addEventListener('click', async ()=>{
  const nombre = document.getElementById('a-nombre').value.trim();
  if(!nombre){ toast('Escribe el nombre del alumno.'); return; }
  if(!needSb()) return;
  const { data, error } = await sb.from('alumnos').insert({
    nombre,
    matricula: document.getElementById('a-matricula').value,
    sexo: document.getElementById('a-sexo').value,
    tipo: document.getElementById('a-tipo').value,
    fecha_reg: dateOrNull(document.getElementById('a-fecha').value || today())
  }).select().single();
  if(error){ toast(error.message); return; }
  const row = mapAlumno(data); row._new = true; alumnos.push(row);
  ['a-nombre','a-matricula'].forEach(id=>document.getElementById(id).value='');
  renderAlumnos();
  toast('Alumno registrado y ordenado alfabéticamente');
});

/* DOCENTES */
function tesisCountDocente(nombre){ let c=0; expedientes.forEach(e=>e.docs.forEach(d=>{ if(d.nombre===nombre) c++; })); return c; }
function renderDocentes(){
  sortByNombre(docentes);
  document.getElementById('d-count').textContent = docentes.length;
  document.getElementById('d-tbody').innerHTML = docentes.map((d,i)=>`
    <tr class="${d._new?'flash':''}">
      <td>${d.nombre}</td><td>${d.empleado||'—'}</td>
      <td><select class="inline g-edit admin-only" data-i="${i}">${GRADOS.map(g=>`<option ${d.grado===g.v?'selected':''}>${g.v}</option>`).join('')}</select>
          <span class="view-tag view-only">${d.grado}</span></td>
      <td>${d.correo||'—'}</td><td>${d.fechaReg||'—'}</td><td>${tesisCountDocente(d.nombre)}</td>
      <td><button class="btn ghost small del-doc admin-only" data-i="${i}">Quitar</button></td>
    </tr>`).join('');
  docentes.forEach(d=>delete d._new);
  document.querySelectorAll('.g-edit').forEach(sel=>sel.addEventListener('change', async ()=>{
    const d = docentes[+sel.dataset.i];
    const prev = d.grado;
    d.grado = sel.value;
    if(!needSb()){ d.grado = prev; sel.value = prev; return; }
    const { error } = await sb.from('docentes').update({ grado: sel.value }).eq('id', d.id);
    if(error){ d.grado = prev; sel.value = prev; toast(error.message); return; }
    toast('Grado académico actualizado — se refleja de inmediato en Constancias');
  }));
  document.querySelectorAll('.del-doc').forEach(b=>b.addEventListener('click', async ()=>{
    if(!needSb()) return;
    const d = docentes[+b.dataset.i];
    const { error } = await sb.from('docentes').delete().eq('id', d.id);
    if(error){ toast(error.message); return; }
    docentes.splice(+b.dataset.i,1);
    renderDocentes();
  }));
}
document.getElementById('d-agregar').addEventListener('click', async ()=>{
  const nombre = document.getElementById('d-nombre').value.trim();
  if(!nombre){ toast('Escribe el nombre del docente.'); return; }
  if(!needSb()) return;
  const empleadoRaw = document.getElementById('d-empleado').value;
  const { data, error } = await sb.from('docentes').insert({
    nombre,
    empleado: empleadoRaw === '' ? null : Number(empleadoRaw),
    telefono: document.getElementById('d-telefono').value,
    correo: document.getElementById('d-correo').value,
    sexo: document.getElementById('d-sexo').value,
    grado: document.getElementById('d-grado').value,
    fecha_reg: dateOrNull(document.getElementById('d-fecha').value || today())
  }).select().single();
  if(error){ toast(error.message); return; }
  const row = mapDocente(data); row._new = true; docentes.push(row);
  ['d-nombre','d-empleado','d-telefono','d-correo'].forEach(id=>document.getElementById(id).value='');
  renderDocentes();
  toast('Docente insertado en su posición alfabética correcta');
});

/* ACTIVIDAD */
const actState={rows:[]};
function renderActividad(){
  sortByNombre(docentes);
  const years=[...new Set(expedientes.map(e=>e.fecha.slice(0,4)))].sort();
  const ys=document.getElementById('act-anio'), cur=ys.value||'all';
  ys.innerHTML='<option value="all">Todos</option>'+years.map(y=>`<option ${y===cur?'selected':''}>${y}</option>`).join('');
  const g=document.getElementById('act-grado').value, y=ys.value;
  const rows=flatRows().filter(r=>(g==='all'||r.e.grado===g)&&(y==='all'||r.e.fecha.slice(0,4)===y));
  actState.rows=rows;
  const out=docentes.map((d,i)=>{
    const n=(c,gr)=>rows.filter(r=>r.d.nombre===d.nombre&&(c==='ALL'||cargoKey(r.d.fungio)===c)&&(gr==='all'||r.e.grado===gr)).length;
    const cell=(c,gr)=>{ const v=n(c,gr); return v?`<a class="numlink" data-di="${i}" data-c="${c}" data-g="${gr}">${v}</a>`:'<span style="color:var(--ink-soft)">0</span>'; };
    if(!n('ALL','all')) return '';
    return `<tr><td>${d.nombre}</td><td>${cell('DIR','all')}</td><td>${cell('ASE','all')}</td><td>${cell('ALL','Licenciatura')}</td><td>${cell('ALL','Maestría')}</td><td>${cell('ALL','Doctorado')}</td><td><b>${cell('ALL','all')}</b></td></tr>`;
  }).join('') || `<tr><td colspan="7" style="color:var(--ink-soft);">Sin tesis con esos filtros.</td></tr>`;
  const tb=document.getElementById('act-tbody'); tb.innerHTML=out;
  document.getElementById('act-detalle').innerHTML='';
  tb.querySelectorAll('.numlink').forEach(l=>l.addEventListener('click',()=>showDetalle(+l.dataset.di,l.dataset.c,l.dataset.g)));
}
function showDetalle(di,c,gr){
  const d=docentes[di], cons=consecutivos();
  const list=actState.rows.filter(r=>r.d.nombre===d.nombre&&(c==='ALL'||cargoKey(r.d.fungio)===c)&&(gr==='all'||r.e.grado===gr)).sort((a,b)=>a.e.fecha.localeCompare(b.e.fecha));
  const t=(c==='DIR'?'Director(a)':c==='ASE'?'Asesor(a)/Revisor(a)':'Todos los cargos')+(gr!=='all'?' · '+gr:'');
  const box=document.getElementById('act-detalle');
  box.innerHTML=`<div class="card"><h3>${d.nombre} — ${t} (${list.length})</h3><div class="tablewrap"><table>
    <thead><tr><th>Consec. cargo</th><th>Fecha</th><th>Alumno</th><th>Tipo de grado</th><th>Cargo</th><th>Título</th><th>Folio</th></tr></thead>
    <tbody>${list.map(r=>`<tr><td><b>#${cons[r.d.folio]}</b></td><td>${r.e.fecha}</td><td>${r.e.alumno}</td><td>${pillGrado(r.e.grado)}</td><td>${r.d.fungio}</td><td style="max-width:280px;">${r.e.titulo}</td><td>${r.d.folio}</td></tr>`).join('')}</tbody></table></div></div>`;
  box.scrollIntoView({behavior:'smooth',block:'nearest'});
}
document.getElementById('act-grado').addEventListener('change',renderActividad);
document.getElementById('act-anio').addEventListener('change',renderActividad);

/* BD */
function renderBD(){
  const rows = flatRows();
  const cons=consecutivos(); document.getElementById('s-tesis').textContent = expedientes.length;
  document.getElementById('s-const').textContent = rows.length;
  document.getElementById('s-alum').textContent = alumnos.length;
  document.getElementById('s-doc').textContent = docentes.length;
  document.getElementById('bd-tbody').innerHTML = rows.map((r,i)=>{
    const docente = getDocente(r.d.nombre);
    const noTesis = expedientes.indexOf(r.e)+1;
    return `<tr>
      <td>${pad4(i+1)}</td><td>${r.d.folio}</td><td>${r.e.alumno}</td><td>${pillGrado(r.e.grado)}</td>
      <td style="max-width:220px;">${r.e.titulo}</td><td>${r.e.fecha}</td>
      <td>${r.d.nombre}</td><td>${r.d.fungio}</td><td><b>#${cons[r.d.folio]}</b></td><td>${r.d.fecha||'—'}</td><td style="font-size:11px;">${r.e.punto}</td><td>${r.e.ciudad}</td>
      <td>${noTesis}</td><td>${r.e.capturo||'—'}</td><td>${r.e.fechacap||'—'}</td>
      <td>${pillSN(r.e.archivo)}</td><td>${pillSN(r.e.digital)}</td><td>${r.e.programa}</td>
      <td>${docente?docente.empleado:'—'}</td><td style="max-width:160px;">${r.e.obs||'—'}</td><td><a class="numlink bd-docs-open" data-ei="${r.ei}">${(r.e.documentos||[]).length}</a></td>
      <td><button class="btn ghost small del-exp admin-only" data-ei="${r.ei}">Borrar tesis</button></td>
    </tr>`;
  }).join('');
  document.getElementById('bd-docs').innerHTML='';
  document.querySelectorAll('.bd-docs-open').forEach(a=>a.addEventListener('click',()=>showDocsTesis(+a.dataset.ei)));
  document.querySelectorAll('.del-exp').forEach(b=>b.addEventListener('click', async ()=>{
    if(!needSb()) return;
    const e = expedientes[+b.dataset.ei];
    const { error } = await sb.from('tesis').delete().eq('id', e.id);
    if(error){ toast(error.message); return; }
    expedientes.splice(+b.dataset.ei,1);
    toast('Tesis eliminada — los No. de Tesis se recorrieron automáticamente');
    renderBD();
  }));
}

function showDocsTesis(ei){
  const e=expedientes[ei]; e.documentos=e.documentos||[]; const box=document.getElementById('bd-docs');
  box.innerHTML=`<div class="card"><h3>Documentos — No. Tesis ${ei+1} · ${e.alumno}</h3>
    ${e.documentos.length?`<div class="tablewrap"><table><thead><tr><th>Tipo</th><th>Archivo</th><th>Tamaño</th><th>Fecha</th><th></th></tr></thead><tbody>${e.documentos.map((x,i)=>`<tr><td>${x.tipo}</td><td>${x.nombre}</td><td>${fmtSize(x.size)}</td><td>${x.fecha}</td><td><a class="editlink" href="${x.url}" target="_blank" rel="noopener">Ver</a> <a class="editlink admin-only bd-doc-del" data-i="${i}">Quitar</a></td></tr>`).join('')}</tbody></table></div>`:'<p class="lede" style="margin:0 0 14px;">Esta tesis aún no tiene documentos.</p>'}
    <div class="admin-only" style="margin-top:16px;"><div class="row4">
      <div class="field"><label>Tipo de documento</label><select id="bd-tipo">${DOC_TIPOS.map(t=>`<option>${t}</option>`).join('')}</select></div>
      <div class="field"><label>Fecha del documento</label><input id="bd-fecha" type="date"></div>
      <div class="field" style="grid-column:span 2;"><label>Archivo</label><input id="bd-file" type="file"></div></div>
      <button class="btn small" id="bd-add">Agregar documento</button></div></div>`;
  document.getElementById('bd-add').addEventListener('click', async ()=>{
    const f=document.getElementById('bd-file').files[0]; if(!f){ toast('Elige un archivo primero.'); return; }
    if(!needSb()) return;
    try {
      const saved = await uploadDoc(e.id, f, document.getElementById('bd-tipo').value, document.getElementById('bd-fecha').value||today());
      e.documentos.push(saved);
      const idx = expedientes.findIndex(x=>x.id===e.id);
      renderBD(); showDocsTesis(idx); toast('Documento agregado');
    } catch (err) { toast(err.message || 'No se pudo subir el archivo'); }
  });
  box.querySelectorAll('.bd-doc-del').forEach(a=>a.addEventListener('click', async ()=>{
    const x = e.documentos[+a.dataset.i];
    if(!needSb()) return;
    const { error } = await sb.from('tesis_documentos').delete().eq('id', x.id);
    if(error){ toast(error.message); return; }
    if(x.storage_path) await sb.storage.from('documentos').remove([x.storage_path]);
    e.documentos.splice(+a.dataset.i,1);
    const idx = expedientes.findIndex(t=>t.id===e.id);
    renderBD(); showDocsTesis(idx);
  }));
}

/* BÚSQUEDA */
function renderBusqueda(){
  const q = norm(document.getElementById('bu-q').value);
  const rows = flatRows().filter(r=> !q || norm(r.e.alumno).includes(q) || norm(r.d.nombre).includes(q) || norm(r.e.titulo).includes(q) || String(r.d.folio).includes(q));
  document.getElementById('bu-tbody').innerHTML = rows.map(r=>{
    const noTesis = expedientes.indexOf(r.e)+1;
    return `<tr><td>${pad4(flatRows().indexOf(r)+1)}</td><td>${r.d.folio}</td><td>${r.e.alumno}</td><td>${pillGrado(r.e.grado)}</td><td style="max-width:260px;">${r.e.titulo}</td><td>${r.d.nombre}</td><td>${r.d.fungio}</td><td>${noTesis}</td></tr>`;
  }).join('') || `<tr><td colspan="8" style="color:var(--ink-soft);">Sin resultados.</td></tr>`;
}
document.getElementById('bu-q').addEventListener('input', renderBusqueda);

/* CONSTANCIAS */
window._constPuntoFilter = 'todos';
function renderConstFilters(){
  const opts = [
    {v:'todos', l:'Todos'},{v:'individual', l:'Individual'},
    {v:'3.3.1', l:'3.3.1 y 3.3.3'},{v:'3.3.2', l:'3.3.2'}
  ];
  document.getElementById('c-filterrow').innerHTML = opts.map(o=>`<button class="filterbtn ${window._constPuntoFilter===o.v?'sel':''}" data-v="${o.v}">${o.l}</button>`).join('');
  document.querySelectorAll('#c-filterrow .filterbtn').forEach(b=>b.addEventListener('click', ()=>{ window._constPuntoFilter=b.dataset.v; renderConstFilters(); renderConstanciasSelect(); }));
}
function matchesConstFilter(e){
  const f = window._constPuntoFilter;
  if(f==='todos') return true;
  if(f==='individual') return e.programa==='Individual';
  if(f==='3.3.1') return e.punto.startsWith('3.3.1') || e.punto.startsWith('3.3.3');
  if(f==='3.3.2') return e.punto.startsWith('3.3.2');
  return true;
}
function renderConstanciasSelect(){
  const sel = document.getElementById('c-folio');
  const rows = flatRows().filter(r=>matchesConstFilter(r.e));
  sel.innerHTML = `<option value="">Selecciona un folio…</option>` + rows.map(r=>`<option value="${r.d.folio}">Folio ${r.d.folio} — ${r.e.alumno} (${r.d.nombre.split(',')[0]}, ${r.d.fungio})</option>`).join('');
  sel.onchange = ()=>renderConstanciaPreview(+sel.value);
  document.getElementById('c-preview').innerHTML=''; document.getElementById('c-letterwrap').innerHTML='';
}
function renderConstanciaPreview(folio){
  const found = flatRows().find(r=>r.d.folio===folio);
  const box = document.getElementById('c-preview'), letterBox = document.getElementById('c-letterwrap');
  if(!found){ box.innerHTML=''; letterBox.innerHTML=''; return; }
  const {e,d} = found, docente = getDocente(d.nombre), noTesis = expedientes.indexOf(e)+1;
  box.innerHTML = `
    <div class="row2"><div class="field"><label>No. de Tesis</label><input value="${noTesis}" disabled></div><div class="field"><label>Folio (autogenerado)</label><input value="${d.folio}" disabled></div></div>
    <div class="row2"><div class="field"><label>Alumno</label><input value="${e.alumno}" disabled></div>
      <div class="field"><label>Grado del alumno</label><div class="lockrow">
        <input id="c-grado-input" value="${e.grado}" disabled><span class="synctag locked" id="c-lock-tag">🔒 protegido</span>
        <a class="editlink admin-only" id="c-grado-edit">Editar</a></div></div></div>
    <div class="row2"><div class="field"><label>Docente</label><input value="${d.nombre}" disabled></div><div class="field"><label>Fungió</label><input value="${d.fungio}" disabled></div></div>
    <div class="row2">
      <div class="field"><label>No. Empleado del docente</label><div class="lockrow"><input value="${docente?docente.empleado:'— no encontrado —'}" disabled><span class="synctag">🔄 tomado de Docentes</span></div></div>
      <div class="field"><label>Grado académico del docente</label><div class="lockrow"><input value="${docente?docente.grado:'—'}" disabled><span class="synctag">🔄 tomado de Docentes</span></div></div>
    </div>
    <div class="note sage">El No. Empleado y el Grado del docente se leen en vivo desde Docentes. Corrige el dato allá y esta constancia se actualiza sola.</div>
    <div class="row2" style="margin-top:14px;"><div class="field"><label>Dirigida a (captura manual)</label><input id="c-dest" placeholder="Ej. Dr. Nombre Apellido, Director de RH"></div><div class="field"><label>Fecha de emisión</label><input id="c-fecha" type="date" value="${today()}"></div></div><button class="btn" id="c-generar">Generar constancia</button>`;
  document.getElementById('c-grado-edit').addEventListener('click', ()=>{
    const inp = document.getElementById('c-grado-input'); inp.disabled=false; inp.focus();
    document.getElementById('c-lock-tag').textContent='✏️ editando'; document.getElementById('c-lock-tag').classList.remove('locked');
    inp.addEventListener('change', async ()=>{
      const prev = e.grado;
      e.grado=inp.value; inp.disabled=true; document.getElementById('c-lock-tag').textContent='🔒 protegido'; document.getElementById('c-lock-tag').classList.add('locked');
      if(e.id && sb){
        const { error } = await sb.from('tesis').update({ grado: inp.value }).eq('id', e.id);
        if(error){ e.grado = prev; inp.value = prev; toast(error.message); return; }
      }
      toast('Grado del alumno corregido y bloqueado de nuevo');
    }, {once:true});
  });
  document.getElementById('c-generar').addEventListener('click', async ()=>{
    const dest=(document.getElementById('c-dest').value.trim()||'A QUIEN CORRESPONDA'), cons=consecutivos(), fe=document.getElementById('c-fecha').value||today();
    const ok = await saveEmitido({fecha:fe,tipo:'Constancia individual',dest,docente:d.nombre,detalle:e.alumno+' — Folio '+d.folio});
    if(!ok) return;
    letterBox.innerHTML = `<div class="letter"><div class="folio">Folio No. ${d.folio} · Chihuahua, Chih., a ${fechaLarga(fe)}</div>
      <p><b>${dest}</b><br>P R E S E N T E.-</p>
      <p>Por medio de la presente se hace constar que <b>${docente?docente.nombre:d.nombre}</b> (No. de empleado ${docente?docente.empleado:'—'}, grado académico ${docente?docente.grado:'—'}) particip&oacute; como <b>${cargoTxt(d.fungio,d.nombre)}</b> en el trabajo de tesis de <b>${e.grado}</b>
      titulado &ldquo;${e.titulo}&rdquo;, elaborado por <b>${e.alumno}</b>, con No. de Tesis <b>${noTesis}</b>, de fecha ${e.fecha}, en la ciudad de ${e.ciudad}. Corresponde a su tesis No. ${cons[d.folio]} en ese cargo.</p>
      <p>Sin otro particular, quedo de usted.</p><p style="margin-top:30px;">A T E N T A M E N T E</p></div>`;
  });
}

window._cModo='ind';
function renderConstModo(){
  document.getElementById('c-modorow').innerHTML=[['ind','Individual (una tesis)'],['var','Varias / concentrado']].map(([v,l])=>`<button class="filterbtn ${window._cModo===v?'sel':''}" data-v="${v}">${l}</button>`).join('');
  document.querySelectorAll('#c-modorow .filterbtn').forEach(b=>b.addEventListener('click',()=>{ window._cModo=b.dataset.v; renderConstModo(); }));
  const ind=window._cModo==='ind';
  ['c-card-ind','c-letterwrap'].forEach(id=>document.getElementById(id).style.display=ind?'':'none');
  ['c-card-var','cc-letter'].forEach(id=>document.getElementById(id).style.display=ind?'none':'');
}
function renderConcentrado(){
  sortByNombre(docentes);
  const sel=document.getElementById('cc-doc'), cur=sel.value;
  sel.innerHTML=docentes.map(d=>`<option ${d.nombre===cur?'selected':''}>${d.nombre}</option>`).join('');
  const cf=document.getElementById('cc-fecha'); if(!cf.value) cf.value=today();
  document.getElementById('cc-generar').onclick=genConcentrado;
}
async function genConcentrado(){
  const nombre=document.getElementById('cc-doc').value, cargo=document.getElementById('cc-cargo').value, grado=document.getElementById('cc-grado').value;
  const desde=document.getElementById('cc-desde').value, hasta=document.getElementById('cc-hasta').value;
  const dest=(document.getElementById('cc-dest').value.trim()||'A QUIEN CORRESPONDA'), fe=document.getElementById('cc-fecha').value||today();
  const d=getDocente(nombre), cons=consecutivos(), box=document.getElementById('cc-letter');
  const rows=flatRows().filter(r=>r.d.nombre===nombre&&(cargo==='ALL'||cargoKey(r.d.fungio)===cargo)&&(grado==='all'||r.e.grado===grado)&&(!desde||r.e.fecha.slice(0,7)>=desde)&&(!hasta||r.e.fecha.slice(0,7)<=hasta)).sort((a,b)=>a.e.fecha.localeCompare(b.e.fecha));
  if(!rows.length){ box.innerHTML=''; toast('No hay tesis con esos filtros.'); return; }
  const ok = await saveEmitido({fecha:fe,tipo:'Constancia concentrada',dest,docente:nombre,detalle:rows.length+' tesis — '+((!desde&&!hasta)?'todos los años':(desde||'inicio')+' a '+(hasta||'hoy'))});
  if(!ok) return;
  const nd=rows.filter(r=>isDir(r.d.fungio)).length, na=rows.length-nd;
  const periodo=(!desde&&!hasta)?'todos los años registrados':(desde?'de '+mesTxt(desde):'desde el inicio')+(hasta?' a '+mesTxt(hasta):' a la fecha');
  box.innerHTML=`<div class="letter"><div class="folio">Chihuahua, Chih., a ${fechaLarga(fe)}</div>
    <p><b>${dest}</b><br>P R E S E N T E.-</p>
    <p>Por medio de la presente se hace constar que <b>${d.nombre}</b> (No. de empleado ${d.empleado||'—'}, grado académico ${d.grado}) ha participado en <b>${rows.length}</b> trabajo(s) de tesis durante el periodo: ${periodo}; <b>${nd}</b> como director(a) y <b>${na}</b> como asesor(a)/revisor(a), conforme al siguiente concentrado:</p>
    <div class="tablewrap"><table style="font-family:'IBM Plex Sans';">
      <thead><tr><th>Consec. cargo</th><th>Fecha</th><th>Alumno</th><th>Grado</th><th>Título</th><th>Cargo</th></tr></thead>
      <tbody>${rows.map(r=>`<tr><td>#${cons[r.d.folio]}</td><td>${r.e.fecha}</td><td>${r.e.alumno}</td><td>${r.e.grado}</td><td>${r.e.titulo}</td><td>${r.d.fungio}</td></tr>`).join('')}</tbody></table></div>
    <p>Sin otro particular, quedo de usted.</p><p style="margin-top:30px;">A T E N T A M E N T E</p></div>`;
}

function renderHistorial(){
  const rows=emitidos.slice().sort((a,b)=>b.fecha.localeCompare(a.fecha));
  document.getElementById('hi-tbody').innerHTML=rows.map(r=>`<tr><td>${r.fecha}</td><td>${r.tipo}</td><td>${r.dest}</td><td>${r.docente}</td><td>${r.detalle}</td></tr>`).join('')||'<tr><td colspan="5" style="color:var(--ink-soft);">Aún no se ha generado ningún oficio o constancia.</td></tr>';
}
/* ASIGNACIÓN / OFICIO */
function renderAsignacion(){
  const af=document.getElementById('as-fecha'); if(!af.value) af.value=today();
  document.getElementById('as-tbody').innerHTML = expedientes.map((e,i)=>{
    const dir = e.docs.find(d=>d.fungio.startsWith('DIRECTOR')) || e.docs[0];
    const docente = dir ? getDocente(dir.nombre) : null;
    return `<tr><td>${i+1}</td><td>${e.alumno}</td><td>${pillGrado(e.grado)}</td><td>${dir?dir.nombre:'—'}</td>
      <td>${docente?docente.empleado:'—'}</td>
      <td>${dir?(dir.fecha||e.fecha):'—'}</td><td><button class="btn ghost small oficio-btn" data-i="${i}">Generar oficio</button></td></tr>`;
  }).join('') || `<tr><td colspan="6" style="color:var(--ink-soft);">Aún no hay tesis registradas.</td></tr>`;
  document.querySelectorAll('.oficio-btn').forEach(b=>b.addEventListener('click', async ()=>{
    const e = expedientes[+b.dataset.i]; const dir = e.docs.find(d=>d.fungio.startsWith('DIRECTOR')) || e.docs[0];
    const fe=document.getElementById('as-fecha').value||today();
    const ok = await saveEmitido({fecha:fe,tipo:'Oficio de asignación',dest:dir.nombre,docente:dir.nombre,detalle:e.alumno+' — Folio '+dir.folio});
    if(!ok) return;
    document.getElementById('as-oficiowrap').innerHTML = `<div class="letter"><div class="folio">Folio No. ${dir.folio} · Chihuahua, Chih., a ${fechaLarga(fe)}</div>
      <p><b>${dir.nombre}</b><br>P R E S E N T E.-</p>
      <p>Asignación de Director de Tesis</p>
      <p>Por este medio se le comunica su asignación como <b>${cargoTxt(dir.fungio,dir.nombre)}</b> del trabajo de tesis de <b>${e.alumno}</b>,
      grado <b>${e.grado}</b>, titulado &ldquo;${e.titulo}&rdquo;.</p>
      <p style="margin-top:30px;">A T E N T A M E N T E</p></div>`;
  }));
}

function initClient(){
  const key = window.SUPABASE_KEY;
  if (!window.SUPABASE_URL || !key || String(key).includes('REEMPLAZAR')) return false;
  const lib = window.supabase;
  const createClient = lib && (lib.createClient || (lib.default && lib.default.createClient));
  if (!createClient) return false;
  sb = createClient(window.SUPABASE_URL, key);
  return true;
}
function paintAuthMode(){
  const reg = authMode === 'register';
  document.getElementById('auth-title').textContent = reg ? 'Crear cuenta' : 'Iniciar sesión';
  document.getElementById('auth-submit').textContent = reg ? 'Registrarme' : 'Entrar';
  document.getElementById('auth-switch').textContent = reg ? 'Ya tengo cuenta' : 'Crear cuenta';
  document.getElementById('auth-nombre-wrap').hidden = !reg;
  document.getElementById('auth-pass').autocomplete = reg ? 'new-password' : 'current-password';
}
async function enterApp(){
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return;
  let profile = null;
  for (let i = 0; i < 4; i++) {
    const res = await sb.from('profiles').select('*').eq('id', user.id).single();
    if (res.data) { profile = res.data; break; }
    await new Promise(r => setTimeout(r, 250));
  }
  authRol = profile && profile.rol === 'admin' ? 'admin' : 'usuario';
  await loadAll();
  document.getElementById('auth-gate').hidden = true;
  document.getElementById('app-shell').hidden = false;
  setRole(authRol, true);
  goTab(document.querySelector('.tab.active')?.dataset.tab || 'inicio');
}
document.getElementById('auth-switch').addEventListener('click', ()=>{
  authMode = authMode === 'login' ? 'register' : 'login';
  showAuthMsg('');
  paintAuthMode();
});
document.getElementById('auth-pass').addEventListener('keydown', e=>{
  if (e.key === 'Enter') document.getElementById('auth-submit').click();
});
document.getElementById('auth-submit').addEventListener('click', async ()=>{
  if (!sb) { showAuthMsg('Pega la publishable key en config.js (SUPABASE_KEY) y recarga.'); return; }
  const email = document.getElementById('auth-email').value.trim();
  const password = document.getElementById('auth-pass').value;
  const nombre = document.getElementById('auth-nombre').value.trim();
  if (!email || !password) { showAuthMsg('Escribe correo y contraseña.'); return; }
  const btn = document.getElementById('auth-submit');
  btn.disabled = true;
  showAuthMsg('');
  try {
    if (authMode === 'register') {
      const { data, error } = await sb.auth.signUp({ email, password, options: { data: { nombre: nombre || email } } });
      if (error) throw error;
      if (!data.session) {
        showAuthMsg('Cuenta creada. Confirma el correo o desactiva Confirm email en Supabase y vuelve a entrar.');
        return;
      }
    } else {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
    }
    await enterApp();
  } catch (err) {
    showAuthMsg(err.message || 'No se pudo autenticar');
  } finally {
    btn.disabled = false;
  }
});
document.getElementById('btn-salir').addEventListener('click', async ()=>{
  if (sb) await sb.auth.signOut();
  alumnos = []; docentes = []; expedientes = []; emitidos = [];
  authRol = 'usuario';
  document.getElementById('app-shell').hidden = true;
  document.getElementById('auth-gate').hidden = false;
});
(async function boot(){
  if (!initClient()) {
    showAuthMsg('Pega la publishable key en config.js (SUPABASE_KEY) y recarga.');
    return;
  }
  const { data } = await sb.auth.getSession();
  if (data.session) {
    try { await enterApp(); }
    catch (err) { showAuthMsg(err.message || 'No se pudieron cargar los datos'); }
  }
})();
