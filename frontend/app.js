const FUNGIO_OPTS = ['DIRECTOR(A)','ASESOR(A)/REVISOR(A)'];
const GRADOS = [{v:'Licenciatura', n:3},{v:'Maestría', n:4},{v:'Doctorado', n:5}];

let sb = null;
let authRol = 'usuario';
// Pruebas: false entra directo. Ponlo en true para volver a pedir inicio de sesión.
const LOGIN_ACTIVO = false;
let authMode = 'login';
let alumnos = [];
let docentes = [];
let expedientes = [];
let emitidos = [];
let mysqlOk = false;
const DOC_TIPOS=['Tesis (texto final)','Acta de examen','Oficio','Constancia','Otro'];
function currentRole(){ return document.body.classList.contains('role-admin') ? 'admin' : 'usuario'; }
function isAdminUi(){ return currentRole()==='admin'; }
function apiHeaders(){
  return { 'Content-Type':'application/json', 'X-Rol': currentRole(), 'X-Usuario': isAdminUi() ? 'Administrador' : 'Usuario' };
}
async function apiGet(path){
  const res = await fetch(path, { headers: apiHeaders() });
  const data = await res.json().catch(()=>({}));
  if (!res.ok) {
    const err = new Error(data.error || 'Error al consultar MySQL');
    err.status = res.status; err.data = data;
    throw err;
  }
  return data;
}
async function apiSend(path, method, body){
  const res = await fetch(path, { method, headers: apiHeaders(), body: body!=null ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(()=>({}));
  if (!res.ok) {
    const err = new Error(data.error || 'Error al guardar');
    err.status = res.status; err.data = data;
    throw err;
  }
  return data;
}

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
  try {
    const salud = await apiGet('/api/salud');
    if (salud && salud.ok) {
      mysqlOk = true;
      const docs = await apiGet('/api/docentes?page=1&limit=500');
      docentes = (docs.rows || []).map(row => ({
        id: row.id, nombre: row.nombre, empleado: row.num_empleado, telefono: row.telefono || '',
        correo: row.correo || '', sexo: row.sexo || '', grado: '', fechaReg: '', tesis: Number(row.no_tesis) || 0
      }));
      paintBdTotals();
      return;
    }
  } catch (_) { mysqlOk = false; }
  if (!sb) throw new Error('No se pudo conectar a MySQL. Enciende Apache/MySQL en XAMPP y recarga.');
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
  td.data.forEach(row=>{ (docsBy[row.tesis_id] ||= []).push({ id:row.id, nombre:row.docente_nombre, fungio:row.fungio, fecha:row.fecha||'', folio:row.folio||'', punto:row.punto||'' }); });
  docs.data.forEach(row=>{ (filesBy[row.tesis_id] ||= []).push({ id:row.id, tipo:row.tipo, nombre:row.nombre, size:Number(row.size)||0, fecha:row.fecha||'', url:row.url||'', storage_path:row.storage_path||'' }); });
  expedientes = t.data.map(row=>({
    id:row.id, alumno:row.alumno_nombre, grado:row.grado, titulo:row.titulo, fecha:row.fecha||'',
    ciudad:row.ciudad||'', programa:row.programa||'', punto:row.punto||'', capturo:row.capturo||'',
    archivo:row.archivo||'NO', digital:row.digital||'NO', fechacap:row.fecha_cap||'', obs:row.obs||'',
    docs:docsBy[row.id]||[], documentos:filesBy[row.id]||[]
  }));
  emitidos = em.data.map(row=>({ id:row.id, fecha:row.fecha||'', tipo:row.tipo, dest:row.dest, docente:row.docente, detalle:row.detalle }));
}
async function saveEmitido(row){
  if (mysqlOk) {
    try {
      await apiSend('/api/historial', 'POST', {
        tipo: row.tipo, detalle: [row.dest, row.docente, row.detalle].filter(Boolean).join(' · '),
        valor_nuevo: row.fecha || today()
      });
      return true;
    } catch (err) { toast(err.message); return false; }
  }
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
function fechaOficio(iso){
  const d = iso ? new Date(String(iso).slice(0,10)+'T12:00:00') : new Date();
  if (Number.isNaN(d.getTime())) return fechaLarga(iso);
  return d.getDate() + ' ' + MESES[d.getMonth()] + ' ' + d.getFullYear();
}
function mesAnioCap(iso){
  const t = mesAnioTxt(iso);
  if (!t || t==='—') return '—';
  return t.charAt(0).toUpperCase() + t.slice(1);
}
function nombresAlumnoCarta(txt){
  const n = alumnoTxt(txt).split(/\n+/).map(s=>s.trim()).filter(Boolean);
  if (n.length <= 1) return n[0] || '';
  if (n.length === 2) return n[0] + ' y ' + n[1];
  return n.slice(0, -1).join(', ') + ' y ' + n[n.length - 1];
}
const REF_CONST = {
  '3.3.1': '3.3.1 TESIS DIRIGIDAS Y CONCLUIDAS',
  '3.3.2': '3.3.2 REVISOR DE TESIS',
  '3.3.3': '3.3.3 TESINAS ASESORADAS Y/O REVISADAS Y CONCLUIDAS'
};
function tipoConstanciaDe(punto, filtro){
  const f = String(filtro||window._constPuntoFilter||'');
  if (REF_CONST[f]) return f;
  const p = String(punto||'').toUpperCase();
  if (p.includes('3.3.2')) return '3.3.2';
  if (p.includes('3.3.3')) return '3.3.3';
  if (p.includes('3.3.1')) return '3.3.1';
  return document.getElementById('c-tipo')?.value || '3.3.1';
}
function cargoConstancia(fungio, sexo){
  const f = String(fungio||'').toUpperCase();
  const fem = String(sexo||'').toUpperCase()==='F' || /ORA\b|ORA\)/.test(f);
  const dir = isDir(fungio||'') || f.includes('DIRECTOR');
  if (dir) return fem ? 'DIRECTORA' : 'DIRECTOR';
  return fem ? 'REVISORA' : 'REVISOR';
}
let ultimaCartaOpts = null;
function htmlCartaConstancia(opts){
  ultimaCartaOpts = opts;
  const tipo = opts.tipo || '3.3.1';
  const ref = REF_CONST[tipo] || REF_CONST['3.3.1'];
  const fe = opts.fecha || today();
  const dir = isDir(opts.fungio||'');
  const yy = String(fe).slice(2,4);
  const folioRaw = String(opts.folio||'').trim();
  const hayFolio = folioRaw && folioRaw !== '*';
  const sip = hayFolio ? `SIP/${dir?'DIR':'REV'}/${esc(folioRaw)}/${yy}` : '';
  const folioHtml = hayFolio ? `<div class="carta-folio-ok">${sip}</div>` : `<div><span class="carta-folio-falta">No se ha asignado ningún folio</span></div>`;
  const fem = String(opts.sexo||'').toUpperCase()==='F';
  const art = fem ? 'la docente' : 'el docente';
  const cargo = cargoConstancia(opts.fungio, opts.sexo);
  const es332 = tipo === '3.3.2';
  const col2 = es332 ? 'NIVEL' : 'GRADO Y PROGRAMA EDUCATIVO';
  const col3 = es332 ? 'TÍTULO DE LA TESIS' : 'TÍTULO DE TESIS';
  const emp = opts.empleado || '—';
  return `<div id="constancia-print"><article class="carta">
    <div class="carta-head">
      <img class="carta-logo" src="/img/logo-uach.svg" alt="Universidad Autónoma de Chihuahua">
      <img class="carta-logo carta-logo-fca" src="/img/logo-fca.jpg" alt="Facultad de Contaduría y Administración">
    </div>
    <div class="carta-ref">
      <div class="ref-label">REFERENCIA:</div>
      <div class="ref-punto">${ref}</div>
      ${folioHtml}
      <div>Asunto: Constancia</div>
      <div>Chihuahua, Chih., a ${esc(fechaOficio(fe))}</div>
    </div>
    <p class="dest">LAG. LUIS FERNANDO RUIZ ROCHA<br>REPRESENTANTE INSTITUCIONAL ANTE EL PRODEP<br>PRESENTE.-</p>
    <p>La que suscribe <b>SECRETARIA DE INVESTIGACIÓN Y POSGRADO</b> de la <b>FACULTAD DE CONTADURÍA Y ADMINISTRACIÓN</b> de la Universidad Autónoma de Chihuahua hace <b>CONSTAR</b> que ${art} <b>${esc(opts.docente)}</b>, con número de empleado ${esc(emp)} participó como <b>${cargo}</b> de la siguiente Tesis, el cual es requisito de titulación.</p>
    <table class="carta-table">
      <colgroup>
        <col style="width:26%"><col style="width:20%"><col style="width:32%"><col style="width:22%">
      </colgroup>
      <thead><tr><th>NOMBRE DEL ALUMNO</th><th>${col2}</th><th>${col3}</th><th>FECHA DE CONCLUSIÓN</th></tr></thead>
      <tbody><tr>
        <td class="nom">${esc(opts.alumno)}</td>
        <td>${esc(opts.grado)||'—'}</td>
        <td>${esc(opts.titulo)}</td>
        <td class="fecha">${esc(opts.fechaConcl)||'—'}</td>
      </tr></tbody>
    </table>
    <div class="carta-cierre">
      <p><b>ATENTAMENTE</b><br>&ldquo;LUCHAR PARA LOGRAR, LOGRAR PARA DAR&rdquo;</p>
      <p class="carta-firma">M.A.R.H. ERIKA NANCY RODRÍGUEZ QUINTANA<br>SECRETARIA DE INVESTIGACIÓN Y POSGRADO</p>
    </div>
  </article></div>
  <div class="carta-acciones">
    <button type="button" class="btn" id="c-imprimir">Imprimir / PDF</button>
    <button type="button" class="btn ghost" id="c-word">Descargar Word</button>
  </div>
  <p class="note sage carta-acciones">Imprimir abre el diálogo del sistema: elige una impresora o “Guardar como PDF”. Word descarga un .doc editable.</p>`;
}
function imprimirCarta(){
  const prev = document.title;
  document.title = ' ';
  const esOficio = !!document.querySelector('#constancia-print .carta.oficio');
  document.documentElement.classList.toggle('print-oficio', esOficio);
  const restore = ()=>{
    document.title = prev;
    document.documentElement.classList.remove('print-oficio');
    window.removeEventListener('afterprint', restore);
  };
  window.addEventListener('afterprint', restore);
  window.print();
}
const logoPngCache = {};
function loadImage(src){
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('No se pudo cargar ' + src));
    img.src = src;
  });
}
async function imgToPngDataUrl(src, boxW, boxH){
  const key = src + '|' + boxW + 'x' + boxH;
  if (logoPngCache[key]) return logoPngCache[key];
  let img;
  if (/\.svg(\?|$)/i.test(src)) {
    const svg = await (await fetch(src)).text();
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    try { img = await loadImage(url); }
    finally { URL.revokeObjectURL(url); }
  } else {
    img = await loadImage(src);
  }
  const canvas = document.createElement('canvas');
  canvas.width = boxW;
  canvas.height = boxH;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, boxW, boxH);
  const scale = Math.min(boxW / img.naturalWidth, boxH / img.naturalHeight);
  const dw = img.naturalWidth * scale;
  const dh = img.naturalHeight * scale;
  ctx.drawImage(img, (boxW - dw) / 2, (boxH - dh) / 2, dw, dh);
  const data = canvas.toDataURL('image/png');
  logoPngCache[key] = data;
  return data;
}
function wordImg(src, w, h){
  return `<img src="${src}" width="${w}" height="${h}" alt="" style="width:${w}px;height:${h}px;border:0;" />`;
}
function bajarWord(html, nombre){
  const blob = new Blob(['\uFEFF' + html], { type: 'application/msword' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (nombre || 'Constancia') + '.doc';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1500);
  toast('Se descargó el Word. Ábrelo para editarlo.');
}
async function descargarCartaWord(nombre){
  const o = ultimaCartaOpts;
  if (!o){
    toast('Genera el documento primero.');
    return;
  }
  if (String(o.kind||'').startsWith('oficio-')) {
    return descargarOficioWord(nombre);
  }
  let uachPng, fcaPng;
  try {
    uachPng = await imgToPngDataUrl('/img/logo-uach.svg', 92, 92);
    fcaPng = await imgToPngDataUrl('/img/logo-fca.jpg', 80, 106);
  } catch (err) {
    toast('No se pudieron incrustar los logos: ' + err.message);
    return;
  }
  const tipo = o.tipo || '3.3.1';
  const ref = REF_CONST[tipo] || REF_CONST['3.3.1'];
  const fe = o.fecha || today();
  const dir = isDir(o.fungio || '');
  const yy = String(fe).slice(2, 4);
  const folioRaw = String(o.folio || '').trim();
  const hayFolio = folioRaw && folioRaw !== '*';
  const sip = hayFolio ? `SIP/${dir ? 'DIR' : 'REV'}/${esc(folioRaw)}/${yy}` : '';
  const folioBloque = hayFolio
    ? `<b>${sip}</b><br/>`
    : `<span style="background:#000000;color:#FFFFFF;font-weight:bold;padding:1px 8px;">No se ha asignado ningún folio</span><br/>`;
  const fem = String(o.sexo || '').toUpperCase() === 'F';
  const art = fem ? 'la docente' : 'el docente';
  const cargo = cargoConstancia(o.fungio, o.sexo);
  const es332 = tipo === '3.3.2';
  const col2 = es332 ? 'NIVEL' : 'GRADO Y PROGRAMA EDUCATIVO';
  const col3 = es332 ? 'TÍTULO DE LA TESIS' : 'TÍTULO DE TESIS';
  const emp = o.empleado || '—';
  const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<title>${esc(nombre || 'Constancia')}</title>
<!--[if gte mso 9]><xml>
<w:WordDocument>
  <w:View>Print</w:View>
  <w:Zoom>100</w:Zoom>
  <w:DoNotOptimizeForBrowser/>
</w:WordDocument>
</xml><![endif]-->
<style>
@page Section1 {
  size: 21.59cm 27.94cm;
  margin: 1.7cm 2cm 1.8cm 2cm;
  mso-header-margin: 0;
  mso-footer-margin: 0;
  mso-page-orientation: portrait;
}
div.Section1 { page: Section1; }
body, table, td, p, span, div {
  font-family: Arial, Helvetica, sans-serif;
  font-size: 11.5pt;
  color: #111111;
}
p.just {
  margin: 0 0 12pt 0;
  text-align: justify;
  line-height: 145%;
}
p.dest {
  margin: 0 0 14pt 0;
  text-align: left;
  font-weight: bold;
  line-height: 145%;
}
p.ref {
  margin: 0;
  text-align: right;
  line-height: 145%;
}
p.cierre {
  margin: 0;
  text-align: center;
  line-height: 150%;
}
table.logos { width: 100%; border: none; border-collapse: collapse; margin: 0 0 8pt 0; }
table.logos td { border: none; padding: 0; vertical-align: top; }
table.datos {
  width: 100%;
  border-collapse: collapse;
  margin: 14pt 0 0 0;
}
table.datos th, table.datos td {
  border: 1px solid #111111;
  padding: 8pt 7pt;
  text-align: center;
  vertical-align: middle;
  font-size: 11pt;
  line-height: 135%;
}
table.datos th {
  font-size: 9.5pt;
  text-transform: uppercase;
  font-weight: bold;
}
</style>
</head>
<body>
<div class="Section1">
<table class="logos" cellpadding="0" cellspacing="0">
  <tr>
    <td width="50%" align="left">${wordImg(uachPng, 92, 92)}</td>
    <td width="50%" align="right">${wordImg(fcaPng, 80, 106)}</td>
  </tr>
</table>
<table class="logos" cellpadding="0" cellspacing="0" style="margin-bottom:14pt;">
  <tr>
    <td width="38%">&nbsp;</td>
    <td width="62%" align="right">
      <p class="ref"><b>REFERENCIA:</b><br/>
      <b>${ref}</b><br/>
      ${folioBloque}
      Asunto: Constancia<br/>
      Chihuahua, Chih., a ${esc(fechaOficio(fe))}</p>
    </td>
  </tr>
</table>
<p class="dest">LAG. LUIS FERNANDO RUIZ ROCHA<br/>
REPRESENTANTE INSTITUCIONAL ANTE EL PRODEP<br/>
PRESENTE.-</p>
<p class="just">La que suscribe <b>SECRETARIA DE INVESTIGACIÓN Y POSGRADO</b> de la <b>FACULTAD DE CONTADURÍA Y ADMINISTRACIÓN</b> de la Universidad Autónoma de Chihuahua hace <b>CONSTAR</b> que ${art} <b>${esc(o.docente)}</b>, con número de empleado ${esc(emp)} participó como <b>${cargo}</b> de la siguiente Tesis, el cual es requisito de titulación.</p>
<table class="datos" cellspacing="0" cellpadding="8">
  <tr>
    <th width="26%">NOMBRE DEL ALUMNO</th>
    <th width="20%">${col2}</th>
    <th width="32%">${col3}</th>
    <th width="22%">FECHA DE CONCLUSIÓN</th>
  </tr>
  <tr>
    <td width="26%" align="left">${esc(o.alumno)}</td>
    <td width="20%">${esc(o.grado) || '—'}</td>
    <td width="32%">${esc(o.titulo)}</td>
    <td width="22%" nowrap="nowrap" style="padding:10pt 8pt;">${esc(o.fechaConcl) || '—'}</td>
  </tr>
</table>
<p class="cierre" style="margin-top:42pt;"><b>ATENTAMENTE</b><br/>
&ldquo;LUCHAR PARA LOGRAR, LOGRAR PARA DAR&rdquo;</p>
<p class="cierre" style="margin-top:40pt;"><b>M.A.R.H. ERIKA NANCY RODRÍGUEZ QUINTANA</b><br/>
SECRETARIA DE INVESTIGACIÓN Y POSGRADO</p>
</div>
</body>
</html>`;
  bajarWord(html, nombre);
}
function bindImprimirCarta(nombreArchivo){
  const imp = document.getElementById('c-imprimir');
  const word = document.getElementById('c-word');
  if (imp) imp.addEventListener('click', imprimirCarta);
  if (word) word.addEventListener('click', ()=>descargarCartaWord(nombreArchivo || 'Constancia'));
}
function programaEsDoctorado(p){ return /doctor/i.test(String(p||'')); }
function programaEsMaestria(p){ return /maestr/i.test(String(p||'')); }
function gradoCortoPrograma(p){
  if (programaEsDoctorado(p)) return 'Doctorado';
  if (programaEsMaestria(p)) return 'Maestría';
  return 'Posgrado';
}
function gradoLargoPrograma(p){
  const t = String(p||'').trim();
  if (t) return t;
  return 'posgrado';
}
function tieneTituloNombre(n){
  return /^(c\.|lic\.?|licenciado|licenciada|mtro\.?|mtra\.?|m\.a\.|m\.c\.|mae\.?|dr\.?|dra\.?|ing\.?)\b/i.test(String(n||'').trim());
}
function nombreAlumnoOficio(nombre, sexo, programa){
  const n = String(nombre||'').trim();
  if (!n) return '—';
  if (tieneTituloNombre(n)) return n;
  if (programaEsDoctorado(programa)) return (String(sexo||'').toUpperCase()==='F' ? 'MTRA. ' : 'MTRO. ') + n;
  return 'C. ' + n;
}
function sexoDocenteOficio(nombre){
  const n = String(nombre||'');
  if (/^dra\.?\b/i.test(n.trim())) return 'F';
  const d = docentes.find(x => String(x.nombre||'').toLowerCase() === n.toLowerCase());
  return d && d.sexo ? d.sexo : '';
}
function cargoDirectorOficio(nombre){
  return String(sexoDocenteOficio(nombre)).toUpperCase()==='F' ? 'directora' : 'director';
}
function codigoOficioAsignacion(r, folio){
  const f = String(folio||r.folio_a||r.folio_m||'').trim();
  if (/^SIP\//i.test(f)) return f;
  const anio = r.anio || new Date().getFullYear();
  if (programaEsDoctorado(r.programa)) return `SIP/DR/${f}-${anio}`;
  if (programaEsMaestria(r.programa)) return `SIP/MA/${f}-${anio}`;
  return `SIP/${f}-${anio}`;
}
function fechaLargaDel(iso){
  return String(fechaLarga(iso) || '').replace(/ de (\d{4})$/i, ' del $1');
}
function nombreDocenteOficio(nombre){
  const n = String(nombre||'').trim();
  if (!n) return '—';
  if (tieneTituloNombre(n)) return n;
  return (String(sexoDocenteOficio(n)).toUpperCase()==='F' ? 'Dra. ' : 'Dr. ') + n;
}
function codigoOficioComite(r, folio){
  const f = String(folio||r.folio_a||'').trim();
  if (/^SIP/i.test(f)) return f.replace(/\//g, '-');
  const anio = r.anio || new Date().getFullYear();
  const num = /^\d+$/.test(f) ? f.padStart(4, '0') : f;
  return `SIP-DA-${num}-${anio}`;
}
function dirigidoPorTxt(nombre){
  const n = String(nombre||'—').trim();
  const fem = String(sexoDocenteOficio(n)).toUpperCase()==='F' || /^dra\.?\b/i.test(n);
  return (fem ? 'la ' : 'el ') + n;
}
function miembrosComiteDeCampos(){
  const v = id => (document.getElementById(id)?.value || '').trim();
  const out = [];
  const c1 = v('as-com-cont1'), c2 = v('as-com-cont2'), est = v('as-com-est'), met = v('as-com-met');
  if (c1) out.push({ rol:'Asesor de Contenido', nombre:c1 });
  if (c2) out.push({ rol:'Asesor de Contenido', nombre:c2 });
  if (est) out.push({ rol:'Asesor de Estadística', nombre:est });
  if (met) out.push({ rol:'Asesor de Metodología', nombre:met });
  return out;
}
function sugerirNombresComite(relacionados, director){
  const dir = norm(director);
  const seen = new Set(dir ? [dir] : []);
  const names = [];
  (relacionados || []).forEach(x => {
    const n = String(x.docente || '').trim();
    const k = norm(n);
    if (!n || seen.has(k)) return;
    seen.add(k);
    names.push(n);
  });
  return names;
}
function rellenarCamposComite(nombres){
  const ids = ['as-com-cont1','as-com-cont2','as-com-est','as-com-met'];
  ids.forEach((id, i) => {
    const el = document.getElementById(id);
    if (el && !el.value.trim() && nombres[i]) el.value = nombres[i];
  });
}
function paintDocentesDatalist(){
  const html = docentes.map(d => `<option value="${esc(d.nombre)}"></option>`).join('');
  ['as-docentes-dl','bd-docentes-dl'].forEach(id => {
    const dl = document.getElementById(id);
    if (dl) dl.innerHTML = html;
  });
}
function textosRolesComite(){
  return [
    ['Asesor de Contenido:', 'Especialista en el área temática de la investigación. Su función principal es asesorar al estudiante en la fundamentación teórica y el contenido disciplinar de la tesis, garantizando la rigurosidad y pertinencia académica del trabajo. Revisa los capítulos relacionados con el marco teórico, la revisión de literatura y el desarrollo de los contenidos, brindando recomendaciones para su mejora.'],
    ['Asesor Metodológico:', 'Encargado de orientar sobre el diseño y el enfoque metodológico del estudio. Asesora al estudiante en la elección y aplicación de métodos de investigación apropiados, en la elaboración de instrumentos de recolección de datos y en la estructura general del proyecto de investigación. Además, revisa la coherencia entre los objetivos planteados, la metodología propuesta y los resultados esperados, sugiriendo mejoras para garantizar la validez y confiabilidad del estudio.'],
    ['Asesor Estadístico:', 'Brinda apoyo específico en el análisis cuantitativo de los datos del estudio. Colabora con el estudiante en la selección de técnicas estadísticas adecuadas, en el procesamiento y análisis de los datos recopilados, y en la interpretación correcta de los resultados estadísticos obtenidos. Se asegura de que el componente estadístico de la tesis sea sólido, pertinente y esté correctamente reportado en el documento.'],
    ['Asesor Procedimental:', 'Funge como orientador en los aspectos procedimentales y formales del proceso de investigación. Se asegura de que el estudiante cumpla con los procedimientos administrativos, requisitos institucionales y cronogramas establecidos para el desarrollo y la presentación de la tesis. Apoya en la preparación de los documentos requeridos (como protocolos, solicitudes de evaluación ética, informes de avance, entre otros) y verifica que la tesis cumpla con los lineamientos formales para su defensa y conclusión. Asimismo, coordina el trabajo de los asesores y preside las reuniones del comité de tesis.']
  ];
}
function pieOficioHtml(){
  return `<div class="oficio-pie"><p><b>FACULTAD DE CONTADURÍA Y ADMINISTRACIÓN</b><br>
Campus Universitario # 2<br>
Circuito Universitario No. IC.P.31125<br>
Teléfonos: 52(614) 442.0000<br>
52(614) 442.0030<br>
Chihuahua, Chih., MÉXICO<br>
www.fca.uach.mx</p></div>`;
}
function encabezadoOficioHtml(ofNo, asunto, fecha, ciudadLinea){
  const ciudad = ciudadLinea || ('Chihuahua, Chihuahua a ' + fechaLarga(fecha));
  return `<div class="oficio-top">
      <img class="carta-logo" src="/img/logo-uach.svg" alt="Universidad Autónoma de Chihuahua">
      <div class="oficio-meta">
        <div><b>Oficio:</b> ${esc(ofNo)}</div>
        <div><b>Asunto:</b> ${esc(asunto)}</div>
        <div>${esc(ciudad)}</div>
      </div>
    </div>`;
}
function accionesCartaHtml(){
  return `<div class="carta-acciones">
      <button type="button" class="btn" id="c-imprimir">Imprimir / PDF</button>
      <button type="button" class="btn ghost" id="c-word">Descargar Word</button>
    </div>
    <p class="note sage carta-acciones">Imprimir abre el diálogo del sistema: elige una impresora o “Guardar como PDF”. Word descarga un .doc editable.</p>`;
}
function htmlOficioAlumno(o){
  const dirCargo = o.dirCargo;
  const DirCargo = dirCargo.charAt(0).toUpperCase() + dirCargo.slice(1);
  const programa = o.programa;
  const grado = o.gradoCorto;
  const estudio = programaEsDoctorado(programa) ? 'doctorado' : (programaEsMaestria(programa) ? 'maestría' : 'posgrado');
  return `<div id="constancia-print">
  <article class="carta oficio">
    ${encabezadoOficioHtml(o.ofNo, o.asunto, o.fecha)}
    <div class="oficio-cuerpo">
      <p class="oficio-dest">${esc(o.dest)}</p>
      <p class="oficio-presente">P R E S E N T E.-</p>
      <p>Por medio de la presente, me permito informarle que, con el propósito de que continúe con la culminación de su ${estudio} y continuar con su proceso de titulación, le ha sido asignado su ${dirCargo} de tesis, este nombramiento tiene como finalidad dar seguimiento al cumplimiento de los requisitos establecidos para la acreditación del programa de ${esc(programa)}, en conformidad con lo dictaminado por el Consejo Técnico. Para su conocimiento, se anexa la resolución correspondiente.</p>
      <p class="oficio-h">${esc(DirCargo)} de tesis</p>
      <table class="oficio-tabla">
        <colgroup><col style="width:62%"><col style="width:38%"></colgroup>
        <tr><td>${esc(o.docente)}</td><td>${esc(o.telDoc)}</td></tr>
        <tr><td>Correo:</td><td>${esc(o.correoDoc)}</td></tr>
      </table>
      <p>Con esta asignación usted debe tomar en cuenta que, de acuerdo a las políticas de investigación, para que un estudiante de la F.C.A. obtenga el Grado de ${esc(grado)} será necesario:</p>
      <ol class="oficio-ol">
        <li>Cumplir con los requisitos del Capítulo III “De la Titulación del Posgrado” del Reglamento General Académico, artículos 100, 101, 102 y 103, además de los establecidos en el artículo 78 del Reglamento General de Investigación y Posgrado y el artículo 187 del Reglamento Interior de la Facultad.</li>
        <li>Realizar un mínimo de dos predefensas ante el comité de grado asignado por la Coordinación de Investigación. Estas predefensas deberán ser notificadas formalmente a la Coordinación con al menos dos semanas de anticipación, indicando la fecha, hora y lugar de la presentación. La Coordinación podrá asignar un representante para estar presente en cada sesión, con el fin de asegurar el cumplimiento de los estándares académicos y proporcionar una evaluación objetiva del progreso del estudiante.</li>
      </ol>
      <p>En cada pre defensa, se deberá elaborar una minuta detallada que incluya:</p>
      <ul class="oficio-ul">
        <li>Fecha, lugar y participantes presentes.</li>
        <li>Resumen de los puntos discutidos.</li>
        <li>Recomendaciones y observaciones realizadas por los miembros del comité.</li>
        <li>Acuerdos alcanzados y plazos para implementar las sugerencias.</li>
      </ul>
    </div>
    ${pieOficioHtml()}
  </article>
  <article class="carta oficio oficio-p2">
    ${encabezadoOficioHtml(o.ofNo, o.asunto, o.fecha)}
    <div class="oficio-cuerpo">
      <p>Esta minuta deberá ser firmada por todos los asistentes y entregada a la Coordinación de Investigación para su archivo y seguimiento, como evidencia del progreso académico del estudiante</p>
      <ol class="oficio-ol" start="3">
        <li>Realizar una presentación oral la cual deberá apoyarse en una presentación visual del trabajo realizado y cuya réplica se realizará ante un Comité de Grado integrado de conformidad con capítulo IV del Reglamento General de Investigación y Posgrado de la Universidad Autónoma de Chihuahua.</li>
        <li>Publicar un artículo científico inédito en la revista que publica la F.C.A. y la presentación en un congreso o coloquio nacional o internacional.</li>
        <li>Cumplir con los demás requisitos establecidos en la Legislación Universitaria aplicable.</li>
      </ol>
      <p>Le pido por favor que se ponga en contacto con el ${dirCargo} de tesis a través de los medios antes mencionados y comiencen a proyectar objetivos y entregables:</p>
      <p>Agradeciendo de antemano la atención prestada a la presente, me despido.</p>
      <div class="carta-cierre">
        <p><b>ATENTAMENTE</b><br>&ldquo;LUCHAR PARA LOGRAR, LOGRAR PARA DAR&rdquo;</p>
        <p class="carta-firma">M.A.R.H. ERIKA NANCY RODRÍGUEZ QUINTANA<br>SECRETARIA DE INVESTIGACIÓN Y POSGRADO</p>
      </div>
    </div>
    ${pieOficioHtml()}
  </article>
</div>
${accionesCartaHtml()}`;
}
function htmlOficioMaestro(o){
  return `<div id="constancia-print">
  <article class="carta oficio">
    ${encabezadoOficioHtml(o.ofNo, o.asunto, o.fecha)}
    <div class="oficio-cuerpo">
      <p class="oficio-dest">${esc(o.dest)}</p>
      <p class="oficio-presente">P R E S E N T E.-</p>
      <p>Por medio de la presente, me permito informarle que ha sido nombrado(a) como ${esc(o.dirCargo)} de tesis, con el propósito de dar seguimiento al proceso de titulación del estudiante que a continuación se indica, en conformidad con lo dictaminado por el Consejo Técnico. Para su conocimiento, se anexa la resolución correspondiente.</p>
      <p class="oficio-h">Estudiante asignado(a)</p>
      <table class="oficio-tabla">
        <colgroup><col style="width:62%"><col style="width:38%"></colgroup>
        <tr><td>${esc(o.alumno)}</td><td>${esc(o.telAlum)}</td></tr>
        <tr><td>Programa:</td><td>${esc(o.programa)}</td></tr>
        <tr><td>Correo:</td><td>${esc(o.correoAlum)}</td></tr>
      </table>
      <p>Le solicito ponerse en contacto con el estudiante a través de los medios señalados para proyectar objetivos y entregables, de acuerdo con las políticas de investigación de la F.C.A.</p>
      <p>Agradeciendo de antemano la atención prestada a la presente, me despido.</p>
      <div class="carta-cierre">
        <p><b>ATENTAMENTE</b><br>&ldquo;LUCHAR PARA LOGRAR, LOGRAR PARA DAR&rdquo;</p>
        <p class="carta-firma">M.A.R.H. ERIKA NANCY RODRÍGUEZ QUINTANA<br>SECRETARIA DE INVESTIGACIÓN Y POSGRADO</p>
      </div>
    </div>
    ${pieOficioHtml()}
  </article>
</div>
${accionesCartaHtml()}`;
}
function htmlOficioComite(o){
  const ciudad = 'Chihuahua, Chih., a ' + fechaLarga(o.fecha);
  const filas = (o.miembros || []).map(m => `<tr><td class="rol">${esc(m.rol)}</td><td>${esc(m.nombre)}</td></tr>`).join('');
  const roles = textosRolesComite().map(([t,c]) => `<p class="oficio-rol"><b>${t}</b> ${c}</p>`).join('');
  return `<div id="constancia-print">
  <article class="carta oficio">
    ${encabezadoOficioHtml(o.ofNo, o.asunto, o.fecha, ciudad)}
    <div class="oficio-cuerpo">
      <p class="oficio-dest">Miembros del Comité</p>
      <p class="oficio-presente-com">Presente. -</p>
      <p>Por este medio, se les informa que, una vez aceptada la invitación, han sido designados de manera formal para integrar el Comité de Grado del pasante, ${esc(o.alumno)} cuya tesis es dirigida por ${esc(o.dirigidoPor)}, siendo sus actividades las que se describen a continuación.</p>
      <table class="oficio-tabla">
        <colgroup><col style="width:38%"><col style="width:62%"></colgroup>
        ${filas}
      </table>
      ${roles}
      <p>Al aceptar la responsabilidad de dirigir o asesorar una tesis, tesina o trabajo de investigación, los directores y asesores deberán firmar una <b>Carta Compromiso</b>, brindada por la Coordinación de Investigación en la que se comprometen formalmente a cumplir con todas las funciones, responsabilidades y lineamientos establecidos en este reglamento. Esta carta deberá ser presentada a la Coordinación de Investigación como requisito obligatorio antes de iniciar el proceso de dirección o asesoría, e incluirá mínimo:</p>
      <ul class="oficio-ul">
        <li>El reconocimiento explícito de las funciones asignadas.</li>
        <li>El compromiso de cumplir con los plazos establecidos para la revisión y retroalimentación.</li>
        <li>La aceptación de las sanciones descritas en caso de incumplimiento.</li>
        <li>La disposición para brindar apoyo académico continuo al estudiante hasta la culminación de su proyecto.</li>
        <li>La disposición para fungir como sinodal al momento del examen de licenciatura o grado.</li>
      </ul>
    </div>
    ${pieOficioHtml()}
  </article>
  <article class="carta oficio oficio-p2">
    ${encabezadoOficioHtml(o.ofNo, o.asunto, o.fecha, ciudad)}
    <div class="oficio-cuerpo">
      <p>Esta carta compromiso será archivada en el expediente académico del estudiante para asegurar un seguimiento adecuado del proceso de investigación junto con un cronograma de actividades esto debido a que, todo estudiante que desarrolle una tesis, tesina o trabajo de investigación deberá presentar junto con su director de tesis o asesor principal, un cronograma de actividades ante la Coordinación de Investigación, como requisito para el registro formal de su proyecto.</p>
      <p>El formato de cronograma de investigación se proporciona en la Coordinación de Investigación y contiene además de los datos de alumno, Director y asesores, los apartados correspondientes a cada uno de los trabajos según corresponda y se marca claramente en este mismo reglamento, además de las fechas de reuniones y retroalimentación.</p>
      <p>El cronograma deberá estar firmado por el estudiante, el director de tesis y los asesores, y deberá ser entregado a la Coordinación de Investigación para su aprobación y archivo para su seguimiento.</p>
      <p>Las actividades expuestas en el cronograma serán supervisadas por la coordinación de investigación.</p>
      <p>El incumplimiento de los plazos establecidos en el cronograma registrado podrá ser motivo de sanciones, de acuerdo con lo estipulado a las políticas de investigación.</p>
      <p>El cronograma de actividad se aplica también para los estudiantes y pasantes que ingresen a cursos de elaboración de tesis.</p>
      <p class="oficio-sub">Asesorías y Reuniones</p>
      <ul class="oficio-ul">
        <li>Las reuniones entre el estudiante y su director o asesores deben incluir tanto aspectos técnicos del trabajo de investigación como elementos personales que puedan influir en el progreso académico.</li>
        <li>Las reuniones deberán abordar, al menos, los siguientes temas:
          <ul class="oficio-ul">
            <li>Revisión del cronograma de actividades y cumplimiento de plazos.</li>
            <li>Avances en cada capítulo del proyecto, incluyendo introducción, marco teórico, análisis de resultados y conclusiones</li>
            <li>Dificultades personales o académicas que puedan estar afectando el desempeño del estudiante</li>
            <li>Estrategias para mejorar la calidad de la escritura académica y análisis crítico.</li>
            <li>Recomendaciones sobre fuentes confiables y metodologías adecuadas para el tema de investigación.</li>
          </ul>
        </li>
        <li>Las reuniones deben ser documentadas con una minuta que incluya la fecha, asistentes, temas discutidos y acuerdos alcanzados. Esta minuta debe ser firmada por el estudiante y el director, y enviada a la Coordinación de Investigación para su registro.</li>
        <li>Las reuniones deberán ser realizadas al menos una vez al mes, teniendo reuniones todos los meses de acuerdo al tiempo establecido para cada grado y tipo de trabajo.</li>
      </ul>
      <div class="carta-cierre">
        <p><b>ATENTAMENTE</b><br>&ldquo;LUCHAR PARA LOGRAR, LOGRAR PARA DAR&rdquo;</p>
        <p class="carta-firma">M.A.R.H. ERIKA NANCY RODRÍGUEZ QUINTANA<br>SECRETARIA DE INVESTIGACIÓN Y POSGRADO</p>
      </div>
    </div>
    ${pieOficioHtml()}
  </article>
</div>
${accionesCartaHtml()}`;
}
function htmlOficioDoctor(o){
  const ciudad = 'Chihuahua, Chih., a ' + fechaLargaDel(o.fecha);
  const fem = o.femDir;
  const designad = fem ? 'designada' : 'designado';
  const cargo = fem ? 'Directora de Tesis' : 'Director de Tesis';
  const deAlum = o.femAlum ? 'de la alumna' : 'del alumno';
  const tipoTesis = o.tipoTesis || 'tesis';
  return `<div id="constancia-print">
  <article class="carta oficio">
    ${encabezadoOficioHtml(o.ofNo, o.asunto, o.fecha, ciudad)}
    <div class="oficio-cuerpo">
      <p class="oficio-dest">${esc(o.dest)}</p>
      <p class="oficio-presente-com">Presente. –</p>
      <p>Por este medio, se le informa que, una vez aceptada la invitación, ha sido ${designad} de manera formal como ${cargo} ${deAlum}, ${esc(o.alumno)}, quien presentó una carta al H. Consejo Técnico quien le otorgó el permiso para continuar con sus estudios, el informe de resolución se adjuntó a la presente.</p>
      <p>Como ${cargo} sus actividades serán las siguientes:</p>
      <p class="oficio-rol"><b>Director de Tesis:</b> Encargado de la dirección general del proyecto de ${esc(tipoTesis)}. Es el principal responsable de guiar al estudiante durante todo el proceso de investigación, asegurando que se cumplan los objetivos del proyecto, los plazos establecidos y los estándares académicos y éticos institucionales. Asimismo, coordina el trabajo de los asesores y preside las reuniones del comité de tesis.</p>
      <p>Al aceptar la responsabilidad de dirigir o asesorar una tesis, tesina o trabajo de investigación, los directores y asesores deberán firmar una <b>Carta Compromiso</b>, brindada por la Coordinación de Investigación en la que se comprometen formalmente a cumplir con todas las funciones, responsabilidades y lineamientos establecidos en este reglamento. Esta carta deberá ser presentada a la Coordinación de Investigación como requisito obligatorio antes de iniciar el proceso de dirección o asesoría, e incluirá mínimo:</p>
      <ul class="oficio-ul">
        <li>El reconocimiento explícito de las funciones asignadas.</li>
        <li>El compromiso de cumplir con los plazos establecidos para la revisión y retroalimentación.</li>
        <li>La aceptación de las sanciones descritas en caso de incumplimiento.</li>
        <li>La disposición para brindar apoyo académico continuo al estudiante hasta la culminación de su proyecto.</li>
        <li>La disposición para fungir como sinodal al momento del examen de licenciatura o grado.</li>
      </ul>
      <p>Esta carta compromiso será archivada en el expediente académico del estudiante para asegurar un seguimiento adecuado del proceso de investigación junto con un cronograma de actividades esto debido a que, todo estudiante que desarrolle una tesis, tesina o trabajo de investigación deberá presentar junto con su director de tesis o asesor principal, un cronograma de actividades ante la Coordinación de Investigación, como requisito para el registro formal de su proyecto.</p>
      <p>El formato de cronograma de investigación se proporciona en la Coordinación de Investigación y contiene además de los datos de alumno, Director y asesores, los apartados correspondientes a cada uno de los trabajos según corresponda y se marca claramente en este mismo reglamento, además de las fechas de reuniones y retroalimentación.</p>
      <p>El cronograma deberá estar firmado por el estudiante, el director de tesis y los asesores, y deberá ser entregado a la Coordinación de Investigación para su aprobación y archivo para su seguimiento.</p>
      <p>Las actividades expuestas en el cronograma serán supervisadas por la coordinación de investigación.</p>
      <p>El incumplimiento de los plazos establecidos en el cronograma registrado podrá ser motivo de sanciones, de acuerdo con lo estipulado a las políticas de investigación.</p>
      <p>El cronograma de actividad se aplica también para los estudiantes y pasantes que ingresen a cursos de elaboración de tesis.</p>
      <p class="oficio-sub">Asesorías y Reuniones</p>
      <ul class="oficio-ul">
        <li>Las reuniones entre el estudiante y su director o asesores deben incluir tanto aspectos técnicos del trabajo de investigación como elementos personales que puedan influir en el progreso académico.</li>
      </ul>
    </div>
    ${pieOficioHtml()}
  </article>
  <article class="carta oficio oficio-p2">
    ${encabezadoOficioHtml(o.ofNo, o.asunto, o.fecha, ciudad)}
    <div class="oficio-cuerpo">
      <ul class="oficio-ul">
        <li>Las reuniones deberán abordar, al menos, los siguientes temas:
          <ul class="oficio-ul">
            <li>Revisión del cronograma de actividades y cumplimiento de plazos.</li>
            <li>Avances en cada capítulo del proyecto, incluyendo introducción, marco teórico, análisis de resultados y conclusiones</li>
            <li>Dificultades personales o académicas que puedan estar afectando el desempeño del estudiante</li>
            <li>Estrategias para mejorar la calidad de la escritura académica y análisis crítico.</li>
            <li>Recomendaciones sobre fuentes confiables y metodologías adecuadas para el tema de investigación.</li>
          </ul>
        </li>
        <li>Las reuniones deben ser documentadas con una minuta que incluya la fecha, asistentes, temas discutidos y acuerdos alcanzados. Esta minuta debe ser firmada por el estudiante y el director, y enviada a la Coordinación de Investigación para su registro.</li>
        <li>Las reuniones deberán ser realizadas al menos una vez al mes, teniendo reuniones todos los meses de acuerdo al tiempo establecido para cada grado y tipo de trabajo.</li>
      </ul>
      <div class="carta-cierre">
        <p><b>ATENTAMENTE</b><br>&ldquo;LUCHAR PARA LOGRAR, LOGRAR PARA DAR&rdquo;</p>
        <p class="carta-firma">M.A.R.H. ERIKA NANCY RODRÍGUEZ QUINTANA<br>SECRETARIA DE INVESTIGACIÓN Y POSGRADO</p>
      </div>
    </div>
    ${pieOficioHtml()}
  </article>
</div>
${accionesCartaHtml()}`;
}
function wordEstilosOficio(){
  return `@page Section1 {
  size: 21.59cm 34cm;
  margin: 1.5cm 1.8cm 1.4cm 1.8cm;
  mso-header-margin: 0;
  mso-footer-margin: 0;
  mso-page-orientation: portrait;
}
div.Section1 { page: Section1; }
body, table, td, p, span, div, li {
  font-family: Arial, Helvetica, sans-serif;
  font-size: 12pt;
  color: #111111;
}
p.just { margin: 0 0 12pt 0; text-align: justify; line-height: 150%; }
p.dest { margin: 0 0 2pt 0; text-align: left; font-weight: bold; line-height: 150%; }
p.presente { margin: 0 0 14pt 0; text-align: left; font-weight: bold; letter-spacing: 2.5pt; line-height: 150%; }
p.hdir { margin: 12pt 0 8pt 0; text-align: left; font-weight: bold; line-height: 150%; }
p.meta { margin: 0; text-align: right; line-height: 150%; }
p.cierre { margin: 0; text-align: center; line-height: 150%; }
p.pie { margin: 0; text-align: left; font-size: 9pt; line-height: 135%; }
table.logos { width: 100%; border: none; border-collapse: collapse; margin: 0 0 14pt 0; }
table.logos td { border: none; padding: 0; vertical-align: top; }
table.datos {
  width: 100%;
  border-collapse: collapse;
  margin: 0 0 14pt 0;
}
table.datos td {
  border: 1px solid #111111;
  padding: 8pt 10pt;
  vertical-align: middle;
  font-size: 12pt;
  line-height: 140%;
}
ol, ul { margin: 0 0 12pt 22pt; padding: 0; }
ul ul { margin: 4pt 0 8pt 18pt; }
li { margin: 0 0 10pt 0; text-align: justify; line-height: 150%; }
p.rol { margin: 0 0 10pt 0; text-align: justify; line-height: 150%; }`;
}
function wordPieOficio(){
  return `<p class="pie" style="margin-top:24pt;"><b>FACULTAD DE CONTADURÍA Y ADMINISTRACIÓN</b><br/>
Campus Universitario # 2<br/>
Circuito Universitario No. IC.P.31125<br/>
Teléfonos: 52(614) 442.0000<br/>
52(614) 442.0030<br/>
Chihuahua, Chih., MÉXICO<br/>
www.fca.uach.mx</p>`;
}
function wordHeadOficio(uachPng, ofNo, asunto, fecha, ciudadLinea){
  const ciudad = ciudadLinea || ('Chihuahua, Chihuahua a ' + fechaLarga(fecha));
  return `<table class="logos" cellpadding="0" cellspacing="0">
  <tr>
    <td width="42%" align="left" valign="top">${wordImg(uachPng, 92, 92)}</td>
    <td width="58%" align="right" valign="top">
      <p class="meta"><b>Oficio:</b> ${esc(ofNo)}<br/>
      <b>Asunto:</b> ${esc(asunto)}<br/>
      ${esc(ciudad)}</p>
    </td>
  </tr>
</table>`;
}
async function descargarOficioWord(nombre){
  const o = ultimaCartaOpts;
  let uachPng;
  try { uachPng = await imgToPngDataUrl('/img/logo-uach.svg', 92, 92); }
  catch (err) { toast('No se pudieron incrustar los logos: ' + err.message); return; }
  const ciudadOf = (o.kind === 'oficio-comite' || o.kind === 'oficio-doctor')
    ? ('Chihuahua, Chih., a ' + fechaLargaDel(o.fecha))
    : null;
  const head = wordHeadOficio(uachPng, o.ofNo, o.asunto, o.fecha, ciudadOf);
  const cierre = `<p class="cierre" style="margin-top:28pt;"><b>ATENTAMENTE</b><br/>
&ldquo;LUCHAR PARA LOGRAR, LOGRAR PARA DAR&rdquo;</p>
<p class="cierre" style="margin-top:78pt;">M.A.R.H. ERIKA NANCY RODRÍGUEZ QUINTANA<br/>
SECRETARIA DE INVESTIGACIÓN Y POSGRADO</p>`;
  let inner = '';
  if (o.kind === 'oficio-alumno') {
    const dirCargo = o.dirCargo;
    const DirCargo = dirCargo.charAt(0).toUpperCase() + dirCargo.slice(1);
    const estudio = programaEsDoctorado(o.programa) ? 'doctorado' : (programaEsMaestria(o.programa) ? 'maestría' : 'posgrado');
    inner = `${head}
<p class="dest">${esc(o.dest)}</p>
<p class="presente">P R E S E N T E.-</p>
<p class="just">Por medio de la presente, me permito informarle que, con el propósito de que continúe con la culminación de su ${estudio} y continuar con su proceso de titulación, le ha sido asignado su ${dirCargo} de tesis, este nombramiento tiene como finalidad dar seguimiento al cumplimiento de los requisitos establecidos para la acreditación del programa de ${esc(o.programa)}, en conformidad con lo dictaminado por el Consejo Técnico. Para su conocimiento, se anexa la resolución correspondiente.</p>
<p class="hdir">${esc(DirCargo)} de tesis</p>
<table class="datos" cellspacing="0" cellpadding="8">
  <tr><td width="62%">${esc(o.docente)}</td><td width="38%">${esc(o.telDoc)}</td></tr>
  <tr><td width="62%">Correo:</td><td width="38%">${esc(o.correoDoc)}</td></tr>
</table>
<p class="just">Con esta asignación usted debe tomar en cuenta que, de acuerdo a las políticas de investigación, para que un estudiante de la F.C.A. obtenga el Grado de ${esc(o.gradoCorto)} será necesario:</p>
<ol>
  <li>Cumplir con los requisitos del Capítulo III “De la Titulación del Posgrado” del Reglamento General Académico, artículos 100, 101, 102 y 103, además de los establecidos en el artículo 78 del Reglamento General de Investigación y Posgrado y el artículo 187 del Reglamento Interior de la Facultad.</li>
  <li>Realizar un mínimo de dos predefensas ante el comité de grado asignado por la Coordinación de Investigación. Estas predefensas deberán ser notificadas formalmente a la Coordinación con al menos dos semanas de anticipación, indicando la fecha, hora y lugar de la presentación. La Coordinación podrá asignar un representante para estar presente en cada sesión, con el fin de asegurar el cumplimiento de los estándares académicos y proporcionar una evaluación objetiva del progreso del estudiante.</li>
</ol>
<p class="just">En cada pre defensa, se deberá elaborar una minuta detallada que incluya:</p>
<ul>
  <li>Fecha, lugar y participantes presentes.</li>
  <li>Resumen de los puntos discutidos.</li>
  <li>Recomendaciones y observaciones realizadas por los miembros del comité.</li>
  <li>Acuerdos alcanzados y plazos para implementar las sugerencias.</li>
</ul>
${wordPieOficio()}
<br clear="all" style="page-break-before:always;mso-break-type:section-break">
${head}
<p class="just">Esta minuta deberá ser firmada por todos los asistentes y entregada a la Coordinación de Investigación para su archivo y seguimiento, como evidencia del progreso académico del estudiante</p>
<ol start="3">
  <li>Realizar una presentación oral la cual deberá apoyarse en una presentación visual del trabajo realizado y cuya réplica se realizará ante un Comité de Grado integrado de conformidad con capítulo IV del Reglamento General de Investigación y Posgrado de la Universidad Autónoma de Chihuahua.</li>
  <li>Publicar un artículo científico inédito en la revista que publica la F.C.A. y la presentación en un congreso o coloquio nacional o internacional.</li>
  <li>Cumplir con los demás requisitos establecidos en la Legislación Universitaria aplicable.</li>
</ol>
<p class="just">Le pido por favor que se ponga en contacto con el ${dirCargo} de tesis a través de los medios antes mencionados y comiencen a proyectar objetivos y entregables:</p>
<p class="just">Agradeciendo de antemano la atención prestada a la presente, me despido.</p>
${cierre}
${wordPieOficio()}`;
  } else if (o.kind === 'oficio-comite') {
    const filas = (o.miembros || []).map(m => `<tr><td width="38%"><b>${esc(m.rol)}</b></td><td width="62%">${esc(m.nombre)}</td></tr>`).join('');
    const roles = textosRolesComite().map(([t,c]) => `<p class="rol"><b>${t}</b> ${c}</p>`).join('\n');
    inner = `${head}
<p class="dest">Miembros del Comité</p>
<p class="presente" style="letter-spacing:0;">Presente. -</p>
<p class="just">Por este medio, se les informa que, una vez aceptada la invitación, han sido designados de manera formal para integrar el Comité de Grado del pasante, ${esc(o.alumno)} cuya tesis es dirigida por ${esc(o.dirigidoPor)}, siendo sus actividades las que se describen a continuación.</p>
<table class="datos" cellspacing="0" cellpadding="8">
${filas}
</table>
${roles}
<p class="just">Al aceptar la responsabilidad de dirigir o asesorar una tesis, tesina o trabajo de investigación, los directores y asesores deberán firmar una <b>Carta Compromiso</b>, brindada por la Coordinación de Investigación en la que se comprometen formalmente a cumplir con todas las funciones, responsabilidades y lineamientos establecidos en este reglamento. Esta carta deberá ser presentada a la Coordinación de Investigación como requisito obligatorio antes de iniciar el proceso de dirección o asesoría, e incluirá mínimo:</p>
<ul>
  <li>El reconocimiento explícito de las funciones asignadas.</li>
  <li>El compromiso de cumplir con los plazos establecidos para la revisión y retroalimentación.</li>
  <li>La aceptación de las sanciones descritas en caso de incumplimiento.</li>
  <li>La disposición para brindar apoyo académico continuo al estudiante hasta la culminación de su proyecto.</li>
  <li>La disposición para fungir como sinodal al momento del examen de licenciatura o grado.</li>
</ul>
${wordPieOficio()}
<br clear="all" style="page-break-before:always;mso-break-type:section-break">
${head}
<p class="just">Esta carta compromiso será archivada en el expediente académico del estudiante para asegurar un seguimiento adecuado del proceso de investigación junto con un cronograma de actividades esto debido a que, todo estudiante que desarrolle una tesis, tesina o trabajo de investigación deberá presentar junto con su director de tesis o asesor principal, un cronograma de actividades ante la Coordinación de Investigación, como requisito para el registro formal de su proyecto.</p>
<p class="just">El formato de cronograma de investigación se proporciona en la Coordinación de Investigación y contiene además de los datos de alumno, Director y asesores, los apartados correspondientes a cada uno de los trabajos según corresponda y se marca claramente en este mismo reglamento, además de las fechas de reuniones y retroalimentación.</p>
<p class="just">El cronograma deberá estar firmado por el estudiante, el director de tesis y los asesores, y deberá ser entregado a la Coordinación de Investigación para su aprobación y archivo para su seguimiento.</p>
<p class="just">Las actividades expuestas en el cronograma serán supervisadas por la coordinación de investigación.</p>
<p class="just">El incumplimiento de los plazos establecidos en el cronograma registrado podrá ser motivo de sanciones, de acuerdo con lo estipulado a las políticas de investigación.</p>
<p class="just">El cronograma de actividad se aplica también para los estudiantes y pasantes que ingresen a cursos de elaboración de tesis.</p>
<p class="hdir">Asesorías y Reuniones</p>
<ul>
  <li>Las reuniones entre el estudiante y su director o asesores deben incluir tanto aspectos técnicos del trabajo de investigación como elementos personales que puedan influir en el progreso académico.</li>
  <li>Las reuniones deberán abordar, al menos, los siguientes temas:
    <ul>
      <li>Revisión del cronograma de actividades y cumplimiento de plazos.</li>
      <li>Avances en cada capítulo del proyecto, incluyendo introducción, marco teórico, análisis de resultados y conclusiones</li>
      <li>Dificultades personales o académicas que puedan estar afectando el desempeño del estudiante</li>
      <li>Estrategias para mejorar la calidad de la escritura académica y análisis crítico.</li>
      <li>Recomendaciones sobre fuentes confiables y metodologías adecuadas para el tema de investigación.</li>
    </ul>
  </li>
  <li>Las reuniones deben ser documentadas con una minuta que incluya la fecha, asistentes, temas discutidos y acuerdos alcanzados. Esta minuta debe ser firmada por el estudiante y el director, y enviada a la Coordinación de Investigación para su registro.</li>
  <li>Las reuniones deberán ser realizadas al menos una vez al mes, teniendo reuniones todos los meses de acuerdo al tiempo establecido para cada grado y tipo de trabajo.</li>
</ul>
${cierre}
${wordPieOficio()}`;
  } else if (o.kind === 'oficio-doctor') {
    inner = `${head}
<p class="dest">${esc(o.dest)}</p>
<p class="presente" style="letter-spacing:0;">Presente. –</p>
<p class="just">Por este medio, se le informa que, una vez aceptada la invitación, ha sido ${o.femDir ? 'designada' : 'designado'} de manera formal como ${o.femDir ? 'Directora de Tesis' : 'Director de Tesis'} ${o.femAlum ? 'de la alumna' : 'del alumno'}, ${esc(o.alumno)}, quien presentó una carta al H. Consejo Técnico quien le otorgó el permiso para continuar con sus estudios, el informe de resolución se adjuntó a la presente.</p>
<p class="just">Como ${o.femDir ? 'Directora de Tesis' : 'Director de Tesis'} sus actividades serán las siguientes:</p>
<p class="rol"><b>Director de Tesis:</b> Encargado de la dirección general del proyecto de ${esc(o.tipoTesis)}. Es el principal responsable de guiar al estudiante durante todo el proceso de investigación, asegurando que se cumplan los objetivos del proyecto, los plazos establecidos y los estándares académicos y éticos institucionales. Asimismo, coordina el trabajo de los asesores y preside las reuniones del comité de tesis.</p>
<p class="just">Al aceptar la responsabilidad de dirigir o asesorar una tesis, tesina o trabajo de investigación, los directores y asesores deberán firmar una <b>Carta Compromiso</b>, brindada por la Coordinación de Investigación en la que se comprometen formalmente a cumplir con todas las funciones, responsabilidades y lineamientos establecidos en este reglamento. Esta carta deberá ser presentada a la Coordinación de Investigación como requisito obligatorio antes de iniciar el proceso de dirección o asesoría, e incluirá mínimo:</p>
<ul>
  <li>El reconocimiento explícito de las funciones asignadas.</li>
  <li>El compromiso de cumplir con los plazos establecidos para la revisión y retroalimentación.</li>
  <li>La aceptación de las sanciones descritas en caso de incumplimiento.</li>
  <li>La disposición para brindar apoyo académico continuo al estudiante hasta la culminación de su proyecto.</li>
  <li>La disposición para fungir como sinodal al momento del examen de licenciatura o grado.</li>
</ul>
<p class="just">Esta carta compromiso será archivada en el expediente académico del estudiante para asegurar un seguimiento adecuado del proceso de investigación junto con un cronograma de actividades esto debido a que, todo estudiante que desarrolle una tesis, tesina o trabajo de investigación deberá presentar junto con su director de tesis o asesor principal, un cronograma de actividades ante la Coordinación de Investigación, como requisito para el registro formal de su proyecto.</p>
<p class="just">El formato de cronograma de investigación se proporciona en la Coordinación de Investigación y contiene además de los datos de alumno, Director y asesores, los apartados correspondientes a cada uno de los trabajos según corresponda y se marca claramente en este mismo reglamento, además de las fechas de reuniones y retroalimentación.</p>
<p class="just">El cronograma deberá estar firmado por el estudiante, el director de tesis y los asesores, y deberá ser entregado a la Coordinación de Investigación para su aprobación y archivo para su seguimiento.</p>
<p class="just">Las actividades expuestas en el cronograma serán supervisadas por la coordinación de investigación.</p>
<p class="just">El incumplimiento de los plazos establecidos en el cronograma registrado podrá ser motivo de sanciones, de acuerdo con lo estipulado a las políticas de investigación.</p>
<p class="just">El cronograma de actividad se aplica también para los estudiantes y pasantes que ingresen a cursos de elaboración de tesis.</p>
<p class="hdir">Asesorías y Reuniones</p>
<ul>
  <li>Las reuniones entre el estudiante y su director o asesores deben incluir tanto aspectos técnicos del trabajo de investigación como elementos personales que puedan influir en el progreso académico.</li>
</ul>
${wordPieOficio()}
<br clear="all" style="page-break-before:always;mso-break-type:section-break">
${head}
<ul>
  <li>Las reuniones deberán abordar, al menos, los siguientes temas:
    <ul>
      <li>Revisión del cronograma de actividades y cumplimiento de plazos.</li>
      <li>Avances en cada capítulo del proyecto, incluyendo introducción, marco teórico, análisis de resultados y conclusiones</li>
      <li>Dificultades personales o académicas que puedan estar afectando el desempeño del estudiante</li>
      <li>Estrategias para mejorar la calidad de la escritura académica y análisis crítico.</li>
      <li>Recomendaciones sobre fuentes confiables y metodologías adecuadas para el tema de investigación.</li>
    </ul>
  </li>
  <li>Las reuniones deben ser documentadas con una minuta que incluya la fecha, asistentes, temas discutidos y acuerdos alcanzados. Esta minuta debe ser firmada por el estudiante y el director, y enviada a la Coordinación de Investigación para su registro.</li>
  <li>Las reuniones deberán ser realizadas al menos una vez al mes, teniendo reuniones todos los meses de acuerdo al tiempo establecido para cada grado y tipo de trabajo.</li>
</ul>
${cierre}
${wordPieOficio()}`;
  } else {
    inner = `${head}
<p class="dest">${esc(o.dest)}</p>
<p class="presente">P R E S E N T E.-</p>
<p class="just">Por medio de la presente, me permito informarle que ha sido nombrado(a) como ${esc(o.dirCargo)} de tesis, con el propósito de dar seguimiento al proceso de titulación del estudiante que a continuación se indica, en conformidad con lo dictaminado por el Consejo Técnico. Para su conocimiento, se anexa la resolución correspondiente.</p>
<p class="hdir">Estudiante asignado(a)</p>
<table class="datos" cellspacing="0" cellpadding="8">
  <tr><td width="62%">${esc(o.alumno)}</td><td width="38%">${esc(o.telAlum)}</td></tr>
  <tr><td width="62%">Programa:</td><td width="38%">${esc(o.programa)}</td></tr>
  <tr><td width="62%">Correo:</td><td width="38%">${esc(o.correoAlum)}</td></tr>
</table>
<p class="just">Le solicito ponerse en contacto con el estudiante a través de los medios señalados para proyectar objetivos y entregables, de acuerdo con las políticas de investigación de la F.C.A.</p>
<p class="just">Agradeciendo de antemano la atención prestada a la presente, me despido.</p>
${cierre}
${wordPieOficio()}`;
  }
  const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<title>${esc(nombre || 'Oficio')}</title>
<!--[if gte mso 9]><xml>
<w:WordDocument>
  <w:View>Print</w:View>
  <w:Zoom>100</w:Zoom>
  <w:DoNotOptimizeForBrowser/>
</w:WordDocument>
</xml><![endif]-->
<style>
${wordEstilosOficio()}
</style>
</head>
<body>
<div class="Section1">
${inner}
</div>
</body>
</html>`;
  bajarWord(html, nombre);
}
const fmtSize=b=>b>1048576?(b/1048576).toFixed(1)+' MB':Math.max(1,Math.round(b/1024))+' KB';
function cargoTxt(f,nombre){ const fem=(getDocente(nombre)||{}).sexo==='F'; return isDir(f)?(fem?'directora':'director'):(fem?'asesora/revisora':'asesor/revisor'); }
function puntoDe(r){ return (r.d && r.d.punto) || r.e.punto || ''; }
function folioTxt(f){ return f ? String(f) : '—'; }
function consecutivos(){ const m={}, c={};
  flatRows().slice().sort((a,b)=>a.e.fecha.localeCompare(b.e.fecha)||((a.d.folio||0)-(b.d.folio||0))).forEach(r=>{ const k=r.d.nombre+'|'+cargoKey(r.d.fungio); c[k]=(c[k]||0)+1; m[r.d.id]=c[k]; });
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
  if(name==='registro') proponerFolio();
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
      rSlots = Array.from({length:n}, ()=>({nombre:'', fungio:'', fecha:today(), folio:''}));
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
      <div class="row4">
        <div class="field autowrap" style="margin-bottom:0;"><label>Nombre</label>
          <input class="doc-input" data-i="${i}" autocomplete="off" placeholder="Escribe para buscar…" value="${s.nombre}">
          <div class="suggestions" id="sugg-${i}"></div>
        </div>
        <div class="field" style="margin-bottom:0;"><label>Fungió</label>
          <select class="doc-fungio" data-i="${i}"><option value="">Selecciona…</option>${FUNGIO_OPTS.map(o=>`<option ${s.fungio===o?'selected':''}>${o}</option>`).join('')}</select>
        </div>
        <div class="field" style="margin-bottom:0;"><label>Fecha de asignación</label><input type="date" class="doc-fecha" data-i="${i}" value="${s.fecha||''}"></div>
        <div class="field" style="margin-bottom:0;"><label>Folio</label><input class="doc-folio" data-i="${i}" inputmode="numeric" placeholder="Escríbelo" value="${s.folio||''}"></div>
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
  wrap.querySelectorAll('.doc-folio').forEach(f=>f.addEventListener('input',()=>{ rSlots[+f.dataset.i].folio=f.value; }));
  wrap.querySelectorAll('.doc-fungio').forEach(sel=>sel.addEventListener('change', ()=>{ rSlots[+sel.dataset.i].fungio = sel.value; updateHint(+sel.dataset.i); }));
}
let rAlumnoIds = [];
let rAluTimer = null;
(function(){
  const inp = document.getElementById('r-alumno'), sugg = document.getElementById('sugg-alumno');
  inp.addEventListener('input', ()=>{
    rAlumnoIds = [];
    const q = inp.value.trim();
    clearTimeout(rAluTimer);
    if(!q){ sugg.classList.remove('show'); return; }
    rAluTimer = setTimeout(async ()=>{
      let matches = [];
      if (mysqlOk) {
        try { matches = (await apiGet('/api/alumnos/buscar?q='+encodeURIComponent(q))).rows || []; }
        catch(_){ matches = []; }
      } else {
        matches = alumnos.filter(a=>norm(a.nombre).includes(norm(q))).slice(0,7);
      }
      sugg.innerHTML = matches.length ? matches.map(a=>`<div data-id="${a.id||''}" data-n="${String(a.nombre).replace(/"/g,'&quot;')}">${esc(a.nombre)}<span class="badge">${esc(a.matricula||a.programa_habitual||a.tipo||'')}</span></div>`).join('') : `<div class="none">Nuevo alumno — se registrará con este nombre</div>`;
      sugg.classList.add('show');
      sugg.querySelectorAll('div[data-n]').forEach(opt=>opt.addEventListener('click', ()=>{
        inp.value = opt.dataset.n;
        rAlumnoIds = opt.dataset.id ? [Number(opt.dataset.id)] : [];
        sugg.classList.remove('show');
      }));
    }, 220);
  });
  inp.addEventListener('blur', ()=> setTimeout(()=>sugg.classList.remove('show'), 150));
})();
async function proponerFolio(){
  if (!mysqlOk) return;
  const el = document.getElementById('r-folio');
  if (!el || el.value.trim()) return;
  try { const d = await apiGet('/api/bd/siguiente-folio'); el.value = d.folio || ''; } catch(_){}
}

document.getElementById('r-guardar').addEventListener('click', async ()=>{
  const alumno = document.getElementById('r-alumno').value.trim();
  const titulo = document.getElementById('r-titulo').value.trim();
  if(!alumno || !titulo || !rGradoSel){ toast('Falta alumno, título o grado.'); return; }
  const slots = rSlots.filter(s=>s.nombre.trim());
  if(!slots.length){ toast('Agrega al menos un docente.'); return; }
  const folio = document.getElementById('r-folio').value.trim();
  if(folio.length > 20){ toast('El folio admite máximo 20 caracteres.'); return; }
  const btn = document.getElementById('r-guardar');
  btn.disabled = true;
  let tesisId = null;
  try {
    if (mysqlOk) {
      await apiSend('/api/tesis', 'POST', {
        alumno, alumno_ids: rAlumnoIds, titulo, grado: rGradoSel, folio,
        fecha: document.getElementById('r-fecha').value || today(),
        ciudad: document.getElementById('r-ciudad').value,
        programa: document.getElementById('r-programa').value,
        punto: document.getElementById('r-punto').value,
        capturo: document.getElementById('r-capturo').value,
        archivo: document.getElementById('r-archivo').value,
        digital: document.getElementById('r-digital').value,
        fecha_cap: document.getElementById('r-fechacap').value || today(),
        obs: document.getElementById('r-obs').value,
        docentes: slots.map(s => {
          const d = getDocente(s.nombre.trim());
          return { id: d && d.id, nombre: s.nombre.trim(), fungio: s.fungio || FUNGIO_OPTS[1] };
        })
      });
      toast('Tesis guardada en MySQL. La actividad del docente se actualiza sola.');
      actState.ready = false;
      await loadAll();
      resetRegistro();
      return;
    }
    if(!needSb()) return;
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
    const punto = document.getElementById('r-punto').value;
    for (const s of slots) {
      const escrito = String(s.folio||folio||'').trim();
      if(escrito && !/^\d+$/.test(escrito)) throw new Error('El folio debe ser un número.');
      const doc = getDocente(s.nombre.trim());
      const rowIns = await sb.from('tesis_docentes').insert({
        tesis_id: tesisId,
        docente_id: doc ? doc.id : null,
        docente_nombre: s.nombre.trim(),
        fungio: s.fungio || FUNGIO_OPTS[1],
        fecha: dateOrNull(s.fecha || today()),
        folio: escrito ? Number(escrito) : null,
        punto
      });
      if(rowIns.error) throw rowIns.error;
    }
    for (const doc of rDocs) {
      if (doc.file) await uploadDoc(tesisId, doc.file, doc.tipo, doc.fecha);
    }
    await loadAll();
    toast(`Tesis guardada — No. de Tesis ${expedientes.length}`);
    resetRegistro();
  } catch (err) {
    if (tesisId && sb) await sb.from('tesis').delete().eq('id', tesisId);
    toast(err.message || 'No se pudo guardar la tesis');
  } finally {
    btn.disabled = false;
  }
});
document.getElementById('r-limpiar').addEventListener('click', resetRegistro);
function resetRegistro(){
  ['r-alumno','r-titulo','r-folio','r-fecha','r-capturo','r-fechacap','r-obs'].forEach(id=>document.getElementById(id).value='');
  rAlumnoIds = [];
  rGradoSel = null; rSlots = []; rDocs = []; renderRDocs();
  renderGradoRow(); renderDocSlots();
  proponerFolio();
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
const aState = { q:'', rows:[], total:0, page:1 };
function isoDate(v){ return v ? String(v).slice(0,10) : ''; }
function paintAlumnos(){
  document.getElementById('a-count').textContent = aState.total;
  document.getElementById('a-mas').hidden = aState.rows.length >= aState.total;
  document.getElementById('a-tbody').innerHTML = aState.rows.length ? aState.rows.map(a=>`
    <tr>
      <td class="col-accion admin-only"><button type="button" class="btn small edit-btn a-ed" data-id="${a.id}">Editar</button>
        <button type="button" class="btn ghost small del-alu" data-id="${a.id}">Quitar</button></td>
      <td>${esc(a.nombre)}</td><td>${esc(a.matricula)||'—'}</td><td>${esc(a.sexo)||'—'}</td>
      <td>${esc(a.programa_habitual)||'—'}</td><td>${isoDate(a.fecha_registro)||'—'}</td>
      <td>${a.tesis||0}</td>
    </tr>`).join('') : `<tr><td colspan="7" style="color:var(--ink-soft);">Sin alumnos.</td></tr>`;
  document.querySelectorAll('.a-ed').forEach(b=>b.addEventListener('click', ()=>{
    const a = aState.rows.find(x=>String(x.id)===b.dataset.id); if(!a) return;
    document.getElementById('a-nombre').value = a.nombre||'';
    document.getElementById('a-matricula').value = a.matricula||'';
    document.getElementById('a-sexo').value = a.sexo||'M';
    document.getElementById('a-tipo').value = a.programa_habitual||'Individual';
    document.getElementById('a-fecha').value = isoDate(a.fecha_registro);
    document.getElementById('a-agregar').dataset.edit = a.id;
    document.getElementById('a-agregar').textContent = 'Guardar cambios';
    toast('Editando alumno — corrige y guarda');
    document.getElementById('a-agregar').scrollIntoView({ behavior:'smooth', block:'nearest' });
  }));
  document.querySelectorAll('.del-alu').forEach(b=>b.addEventListener('click', async ()=>{
    if(!confirm('¿Borrar este alumno?')) return;
    try { await apiSend('/api/alumnos/'+b.dataset.id, 'DELETE'); toast('Alumno borrado'); renderAlumnos(true); }
    catch(err){ toast(err.message); }
  }));
}
async function renderAlumnos(reset){
  if (mysqlOk) {
    if (reset!==false) { aState.page = 1; aState.rows = []; }
    try {
      const data = await apiGet(`/api/alumnos?page=${aState.page}&limit=50&q=${encodeURIComponent(aState.q||'')}`);
      aState.total = data.total||0;
      aState.rows = aState.page===1 ? (data.rows||[]) : aState.rows.concat(data.rows||[]);
      paintAlumnos();
    } catch(err){ toast(err.message); }
    return;
  }
  sortByNombre(alumnos);
  document.getElementById('a-count').textContent = alumnos.length;
  document.getElementById('a-tbody').innerHTML = alumnos.map((a,i)=>`
    <tr class="${a._new?'flash':''}">
      <td class="col-accion admin-only"><button type="button" class="btn ghost small del-alu" data-i="${i}">Quitar</button></td>
      <td>${a.nombre}</td><td>${a.matricula||'—'}</td><td>${a.sexo||'—'}</td><td>${a.tipo||'—'}</td>
      <td>${a.fechaReg||'—'}</td><td>${tesisCountAlumno(a.nombre)}</td>
    </tr>`).join('');
  alumnos.forEach(a=>delete a._new);
}
let aQTimer=null;
document.getElementById('a-q').addEventListener('input', ()=>{
  clearTimeout(aQTimer);
  aQTimer=setTimeout(()=>{ aState.q=document.getElementById('a-q').value.trim(); renderAlumnos(true); }, 280);
});
document.getElementById('a-mas').addEventListener('click', ()=>{ aState.page += 1; renderAlumnos(false); });
document.getElementById('a-agregar').addEventListener('click', async ()=>{
  const nombre = document.getElementById('a-nombre').value.trim();
  if(!nombre){ toast('Escribe el nombre del alumno.'); return; }
  const payload = {
    nombre,
    matricula: document.getElementById('a-matricula').value.trim(),
    sexo: document.getElementById('a-sexo').value,
    programa_habitual: document.getElementById('a-tipo').value,
    fecha_registro: document.getElementById('a-fecha').value || today()
  };
  const editId = document.getElementById('a-agregar').dataset.edit;
  try {
    if (mysqlOk) {
      if (editId) await apiSend('/api/alumnos/'+editId, 'PUT', payload);
      else await apiSend('/api/alumnos', 'POST', payload);
      document.getElementById('a-agregar').dataset.edit = '';
      document.getElementById('a-agregar').textContent = 'Registrar alumno';
      ['a-nombre','a-matricula'].forEach(id=>document.getElementById(id).value='');
      renderAlumnos(true);
      toast(editId ? 'Alumno actualizado' : 'Alumno registrado');
      return;
    }
    if(!needSb()) return;
    const { data, error } = await sb.from('alumnos').insert({
      nombre, matricula: payload.matricula, sexo: payload.sexo, tipo: payload.programa_habitual,
      fecha_reg: dateOrNull(payload.fecha_registro)
    }).select().single();
    if(error){ toast(error.message); return; }
    const row = mapAlumno(data); row._new = true; alumnos.push(row);
    ['a-nombre','a-matricula'].forEach(id=>document.getElementById(id).value='');
    renderAlumnos();
    toast('Alumno registrado y ordenado alfabéticamente');
  } catch(err){ toast(err.message); }
});

/* DOCENTES */
function tesisCountDocente(nombre){ let c=0; expedientes.forEach(e=>e.docs.forEach(d=>{ if(d.nombre===nombre) c++; })); return c; }
const dState = { q:'', rows:[], total:0, page:1 };
async function renderDocentes(){
  if (mysqlOk) {
    const q = encodeURIComponent(dState.q || '');
    document.getElementById('d-count').textContent = '…';
    try {
      const data = await apiGet(`/api/docentes?page=1&limit=50&q=${q}`);
      dState.rows = data.rows || [];
      dState.total = data.total || 0;
      dState.page = 1;
      paintDocentes();
    } catch (err) { toast(err.message); }
    return;
  }
  sortByNombre(docentes);
  document.getElementById('d-count').textContent = docentes.length;
  document.getElementById('d-tbody').innerHTML = docentes.map((d,i)=>`
    <tr class="${d._new?'flash':''}">
      <td>${d.nombre}</td><td>${d.empleado||'—'}</td>
      <td>${d.sexo||'—'}</td>
      <td>${d.correo||'—'}</td><td>${d.telefono||d.fechaReg||'—'}</td><td>${tesisCountDocente(d.nombre)}</td>
    </tr>`).join('');
  docentes.forEach(d=>delete d._new);
}
function paintDocentes(){
  document.getElementById('d-count').textContent = dState.total;
  const mas = document.getElementById('d-mas');
  mas.hidden = dState.rows.length >= dState.total;
  document.getElementById('d-tbody').innerHTML = dState.rows.length ? dState.rows.map(d=>`
    <tr>
      <td class="col-accion admin-only">${d.id ? `<button type="button" class="btn small edit-btn d-ed" data-id="${d.id}">Editar</button>` : ''}</td>
      <td>${d.no_num||'—'}</td>
      <td>${d.id ? `<a class="numlink d-open" data-id="${d.id}">${esc(d.nombre)}</a>` : esc(d.nombre)}</td>
      <td>${esc(d.num_empleado)||'—'}</td>
      <td>${esc(d.telefono)||'—'}</td>
      <td>${esc(d.correo)||'—'}</td>
      <td>${esc(d.sexo)||'—'}</td>
      <td>${esc(d.tc)||'—'}</td>
      <td>${d.no_tesis||0}</td>
    </tr>`).join('') : `<tr><td colspan="9" style="color:var(--ink-soft);">Sin docentes con esa búsqueda.</td></tr>`;
  document.querySelectorAll('.d-open').forEach(a=>a.addEventListener('click', ()=>showDocenteMysql(+a.dataset.id)));
  document.querySelectorAll('.d-ed').forEach(a=>a.addEventListener('click', ()=>{
    const d = dState.rows.find(x=>String(x.id)===a.dataset.id);
    if (d) fillDocenteForm(d);
  }));
}
function fillDocenteForm(d){
  document.getElementById('d-id').value = d ? d.id : '';
  document.getElementById('d-nombre').value = d ? (d.nombre||'') : '';
  document.getElementById('d-empleado').value = d ? (d.num_empleado||'') : '';
  document.getElementById('d-telefono').value = d ? (d.telefono||'') : '';
  document.getElementById('d-correo').value = d ? (d.correo||'') : '';
  document.getElementById('d-sexo').value = d && d.sexo ? d.sexo : 'M';
  document.getElementById('d-tc').value = d && d.tc ? d.tc : '';
  document.getElementById('d-agregar').textContent = d ? 'Guardar cambios' : 'Registrar docente';
  document.getElementById('d-form-title').textContent = d ? 'Editar docente' : 'Agregar docente';
  if (d) {
    toast('Editando docente — corrige y guarda');
    document.getElementById('d-form-title').scrollIntoView({ behavior:'smooth', block:'nearest' });
  }
}
async function showDocenteMysql(id){
  const box = document.getElementById('d-detalle');
  box.innerHTML = '<div class="card"><p class="lede">Cargando tesis del docente…</p></div>';
  try {
    const data = await apiGet('/api/docentes/' + id);
    const d = data.docente;
    const list = data.filas || [];
    box.innerHTML = `<div class="card"><h3>${esc(d.nombre)} — ${list.length} tesis</h3>
      <p class="lede">No. empleado ${esc(d.num_empleado)||'—'} · ${esc(d.correo)||'sin correo'}</p>
      <div class="tablewrap"><table class="excel-table">
        <thead><tr><th>Año</th><th>Alumno</th><th>Título</th><th>Fungió</th><th>Grado</th><th>Ciudad</th></tr></thead>
        <tbody>${list.map(t=>`<tr>
          <td>${t.anio||'—'}</td>
          <td class="alumno-cell">${esc(alumnoTxt(t.alumno))}</td>
          <td style="max-width:360px;">${esc(t.titulo_tesis)}</td>
          <td>${esc(t.fungio)}</td>
          <td>${esc(t.grado)}</td>
          <td>${esc(t.ciudad)||'—'}</td>
        </tr>`).join('')||'<tr><td colspan="6">Sin participaciones.</td></tr>'}</tbody>
      </table></div></div>`;
    box.scrollIntoView({behavior:'smooth',block:'nearest'});
  } catch (err) { box.innerHTML = `<div class="card"><p class="lede">${esc(err.message)}</p></div>`; }
}
let dQTimer = null;
document.getElementById('d-q').addEventListener('input', ()=>{
  clearTimeout(dQTimer);
  dQTimer = setTimeout(()=>{ dState.q = document.getElementById('d-q').value.trim(); renderDocentes(); }, 300);
});
document.getElementById('d-mas').addEventListener('click', async ()=>{
  if (!mysqlOk) return;
  const next = dState.page + 1;
  const q = encodeURIComponent(dState.q || '');
  const data = await apiGet(`/api/docentes?page=${next}&limit=50&q=${q}`);
  dState.page = next;
  dState.rows = dState.rows.concat(data.rows || []);
  paintDocentes();
});
document.getElementById('d-cancelar').addEventListener('click', ()=>fillDocenteForm(null));
document.getElementById('d-agregar').addEventListener('click', async ()=>{
  const nombre = document.getElementById('d-nombre').value.trim();
  if(!nombre){ toast('Escribe el nombre del docente.'); return; }
  const empleadoRaw = document.getElementById('d-empleado').value;
  const payload = {
    nombre, num_empleado: empleadoRaw || null,
    telefono: document.getElementById('d-telefono').value,
    correo: document.getElementById('d-correo').value,
    sexo: document.getElementById('d-sexo').value,
    tc: document.getElementById('d-tc').value
  };
  const editId = document.getElementById('d-id').value;
  try {
    if (mysqlOk) {
      if (editId) await apiSend('/api/docentes/'+editId, 'PUT', payload);
      else await apiSend('/api/docentes', 'POST', payload);
      fillDocenteForm(null);
      await loadAll();
      renderDocentes();
      paintDocentesDatalist();
      actState.ready = false;
      toast(editId ? 'Docente actualizado en MySQL' : 'Docente registrado');
      return;
    }
    if(!needSb()) return;
    const { data, error } = await sb.from('docentes').insert({
      nombre,
      empleado: empleadoRaw === '' ? null : Number(empleadoRaw),
      telefono: document.getElementById('d-telefono').value,
      correo: document.getElementById('d-correo').value,
      sexo: document.getElementById('d-sexo').value,
      grado: document.getElementById('d-grado').value,
      fecha_reg: dateOrNull(today())
    }).select().single();
    if(error){ toast(error.message); return; }
    const row = mapDocente(data); row._new = true; docentes.push(row);
    ['d-nombre','d-empleado','d-telefono','d-correo'].forEach(id=>document.getElementById(id).value='');
    renderDocentes();
    toast('Docente insertado en su posición alfabética correcta');
  } catch(err){ toast(err.message); }
});

/* ACTIVIDAD */
const actState={ready:false, anio:'', ciudad:'GENERAL'};
async function renderActividad(){
  if (!mysqlOk) {
    document.getElementById('act-tbody').innerHTML = '<tr><td colspan="11">MySQL no está disponible</td></tr>';
    return;
  }
  const anioSel = document.getElementById('act-anio');
  const ciudadSel = document.getElementById('act-ciudad');
  const qs = new URLSearchParams();
  if (actState.anio) qs.set('anio', actState.anio);
  qs.set('ciudad', actState.ciudad || 'GENERAL');
  try {
    const data = await apiGet('/api/actividad?' + qs.toString());
    if (!actState.ready) {
      anioSel.innerHTML = (data.anios||[]).map(y=>`<option ${String(y)===String(actState.anio)?'selected':''}>${y}</option>`).join('');
      if (!actState.anio && data.anios && data.anios[0]) {
        actState.anio = String(data.anios[0]);
        anioSel.value = actState.anio;
      }
      ciudadSel.innerHTML = '<option value="GENERAL">GENERAL</option>' + (data.ciudades||[]).map(c=>`<option ${c===actState.ciudad?'selected':''}>${esc(c)}</option>`).join('');
      ciudadSel.value = actState.ciudad || 'GENERAL';
      actState.ready = true;
      if (actState.anio && !qs.get('anio')) {
        await renderActividad();
        return;
      }
    }
    const rows = data.rows || [];
    document.getElementById('act-tbody').innerHTML = rows.length ? rows.map((r,i)=>`
      <tr class="${Number(r.total)===0?'act-cero':(Number(r.total)>=20?'act-alto':'')}">
        <td>${r.no_num || i+1}</td>
        <td>${esc(r.docente)}</td>
        <td>${n0(r.l_a)}</td><td>${n0(r.l_r)}</td>
        <td>${n0(r.m_a)}</td><td>${n0(r.m_d)}</td><td>${n0(r.m_r)}</td>
        <td>${n0(r.d_a)}</td><td>${n0(r.d_d)}</td><td>${n0(r.d_r)}</td>
        <td><b>${n0(r.total)}</b></td>
      </tr>`).join('') : '<tr><td colspan="11">Sin registros con esos filtros.</td></tr>';
  } catch (err) {
    document.getElementById('act-tbody').innerHTML = `<tr><td colspan="11">${esc(err.message)}</td></tr>`;
  }
}
function n0(v){ const n = Number(v); return Number.isFinite(n) ? n : 0; }
document.getElementById('act-anio').addEventListener('change', ()=>{ actState.anio = document.getElementById('act-anio').value; renderActividad(); });
document.getElementById('act-ciudad').addEventListener('change', ()=>{ actState.ciudad = document.getElementById('act-ciudad').value; renderActividad(); });

/* BD */
const BD_PAGE = 50;
let bdReq = 0;
const bdState = { ready:false, anio:'', grado:'Todos', ciudad:'Todas', programa:'Todos', punto:'Todos', q:'', sort:'id', dir:'asc', rows:[], total:0, page:1 };
const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
function alumnoTxt(s){ return String(s||'').replace(/\\n/g,'\n').replace(/\r\n/g,'\n'); }
function mesAnioTxt(iso){
  if (!iso) return '—';
  const s = String(iso).slice(0,10);
  const [y,m] = s.split('-');
  if (!m || !MESES[+m-1]) return s;
  return MESES[+m-1] + ' ' + y;
}
function bdStatus(msg, kind){
  const el = document.getElementById('bd-folio-status');
  el.textContent = msg || '';
  el.className = kind === 'ok' ? 'ok' : kind === 'err' ? 'err' : '';
}
function fillSelect(id, allLabel, values){
  const el = document.getElementById(id);
  const cur = el.value;
  el.innerHTML = `<option value="${allLabel}">${allLabel}</option>` + (values||[]).map(v=>`<option>${esc(v)}</option>`).join('');
  if ([...el.options].some(o=>o.value===cur)) el.value = cur;
}
function bdQueryString(){
  const p = new URLSearchParams();
  if (bdState.anio) p.set('anio', bdState.anio);
  if (bdState.grado && bdState.grado !== 'Todos') p.set('grado', bdState.grado);
  if (bdState.ciudad && bdState.ciudad !== 'Todas') p.set('ciudad', bdState.ciudad);
  if (bdState.programa && bdState.programa !== 'Todos') p.set('programa', bdState.programa);
  if (bdState.punto && bdState.punto !== 'Todos') p.set('punto', bdState.punto);
  if (bdState.q) p.set('q', bdState.q);
  if (bdState.sort) p.set('sort', bdState.sort);
  if (bdState.dir) p.set('dir', bdState.dir);
  return p.toString();
}
async function paintBdTotals(){
  if (!mysqlOk) return;
  try {
    const c = await apiGet('/api/conteos');
    document.getElementById('s-tesis').textContent = c.bd ?? 0;
    document.getElementById('s-const').textContent = c.bd_asignacion ?? 0;
    document.getElementById('s-alum').textContent = c.alumnos ?? c.v_alumnos ?? 0;
    document.getElementById('s-doc').textContent = c.docentes ?? 0;
  } catch (_) {}
}
async function ensureBdDefaults(){
  if (bdState.ready) return;
  const f = await apiGet('/api/filtros');
  document.getElementById('bd-anio').innerHTML = '<option value="">Todos</option>' + (f.anios||[]).map(y=>`<option>${y}</option>`).join('');
  fillSelect('bd-grado', 'Todos', f.grados);
  fillSelect('bd-ciudad', 'Todas', f.ciudades);
  fillSelect('bd-programa', 'Todos', f.programas);
  fillSelect('bd-punto', 'Todos', f.puntos);
  bdState.ready = true;
}
function paintBdSortHeaders(){
  document.querySelectorAll('#bd-table th[data-sort]').forEach(th=>{
    th.classList.toggle('sort-asc', th.dataset.sort===bdState.sort && bdState.dir==='asc');
    th.classList.toggle('sort-desc', th.dataset.sort===bdState.sort && bdState.dir==='desc');
  });
}
function paintBdTable(){
  const rows = bdState.rows;
  document.getElementById('bd-count').textContent = `Total de registros: ${bdState.total}`;
  document.getElementById('bd-mas').hidden = rows.length >= bdState.total;
  paintBdSortHeaders();
  document.getElementById('bd-tbody').innerHTML = rows.length ? rows.map(row=>`
    <tr>
      <td class="col-accion admin-only"><button type="button" class="btn small edit-btn bd-ed" data-id="${row.id}">Editar</button></td>
      <td>${esc(row.no)||'—'}</td>
      <td>${esc(row.folio)||'—'}</td>
      <td class="alumno-cell">${esc(alumnoTxt(row.alumno))}</td>
      <td>${esc(row.grado)||'—'}</td>
      <td>${esc(row.titulo_tesis)}</td>
      <td>${esc(mesAnioTxt(row.fecha_elaboracion))}</td>
      <td>${esc(row.docente)}</td>
      <td>${esc(row.fungio)||'—'}</td>
      <td>${esc(row.punto)||'—'}</td>
      <td>${esc(row.ciudad)||'—'}</td>
      <td>${esc(row.no_tesis)||'—'}</td>
      <td>${esc(row.no_caja)||'—'}</td>
      <td>${esc(row.capturo)||'—'}</td>
      <td>${esc(mesAnioTxt(row.fecha_captura))}</td>
      <td>${esc(row.archivo)||'—'}</td>
      <td>${esc(row.digital)||'—'}</td>
      <td>${esc(row.programa)||'—'}</td>
      <td>${esc(row.no_empleado)||'—'}</td>
      <td>${esc(row.observaciones)||'—'}</td>
      <td>${esc(row.pdf)||'—'}</td>
      <td>${esc(row.cd)||'—'}</td>
    </tr>`).join('') : `<tr><td colspan="22" style="color:var(--ink-soft);">No hay registros en este rango</td></tr>`;
  document.querySelectorAll('.bd-ed').forEach(a=>a.addEventListener('click', ()=>{
    const row = bdState.rows.find(r=>r.id===+a.dataset.id);
    if (row) fillBdForm(row);
  }));
}
function fillBdForm(row){
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v == null ? '' : String(v); };
  document.getElementById('bd-f-id').value = row ? row.id : '';
  set('bd-f-anio', row && row.anio);
  set('bd-f-no', row && row.no);
  set('bd-f-folio', row && row.folio);
  set('bd-f-grado', row && row.grado);
  set('bd-f-alumno', row && alumnoTxt(row.alumno));
  set('bd-f-titulo', row && row.titulo_tesis);
  set('bd-f-fecha', row && isoDate(row.fecha_elaboracion));
  set('bd-f-docente', row && row.docente);
  const fung = document.getElementById('bd-f-fungio');
  const fval = row && row.fungio ? String(row.fungio) : '';
  if (fval && ![...fung.options].some(o=>o.value===fval)) {
    fung.insertAdjacentHTML('beforeend', `<option value="${esc(fval)}">${esc(fval)}</option>`);
  }
  fung.value = fval;
  set('bd-f-punto', row && row.punto);
  set('bd-f-ciudad', row && row.ciudad);
  set('bd-f-caja', row && row.no_caja);
  set('bd-f-capturo', row && row.capturo);
  set('bd-f-fechacap', row && isoDate(row.fecha_captura));
  set('bd-f-archivo', row && row.archivo);
  set('bd-f-digital', row && row.digital);
  set('bd-f-programa', row && row.programa);
  set('bd-f-pdf', row && row.pdf);
  set('bd-f-cd', row && row.cd);
  set('bd-f-obs', row && row.observaciones);
  document.getElementById('bd-form-title').textContent = row ? 'Editar registro' : 'Editar registro';
  document.getElementById('bd-guardar').textContent = row ? 'Guardar cambios' : 'Guardar cambios';
  paintDocentesDatalist();
  if (row) {
    toast('Editando registro — corrige y guarda');
    document.getElementById('bd-form-title').scrollIntoView({ behavior:'smooth', block:'nearest' });
  }
}
async function editarFolioBd(id){
  const row = bdState.rows.find(r=>r.id===id);
  if(!row) return;
  const actual = row.folio==null ? '' : String(row.folio);
  const nuevo = prompt('Folio (máximo 20 caracteres; vacío para quitarlo):', actual);
  if (nuevo==null) return;
  if (nuevo.length > 20){ toast('El folio admite máximo 20 caracteres.'); return; }
  try {
    await apiSend('/api/bd/'+id+'/folio', 'PATCH', { folio: nuevo.trim() });
    toast('Folio actualizado');
    bdLoad(true);
  } catch (err) {
    if (err.status===409 && err.data && err.data.duplicate) {
      if (confirm(err.message)) {
        try {
          await apiSend('/api/bd/'+id+'/folio', 'PATCH', { folio: nuevo.trim(), confirmar:true });
          toast('Folio actualizado');
          bdLoad(true);
        } catch (e2) { toast(e2.message); }
      }
    } else toast(err.message);
  }
}
async function bdLoad(reset){
  const req = ++bdReq;
  if (reset) { bdState.rows = []; bdState.page = 1; }
  const page = reset ? 1 : bdState.page + 1;
  document.getElementById('bd-count').textContent = 'Cargando…';
  try {
    const qs = bdQueryString();
    const data = await apiGet(`/api/bd?page=${page}&limit=${BD_PAGE}${qs ? '&'+qs : ''}`);
    if (req !== bdReq) return;
    bdState.page = page;
    bdState.total = data.total || 0;
    bdState.rows = reset ? (data.rows || []) : bdState.rows.concat(data.rows || []);
    paintBdTable();
  } catch (err) {
    if (req !== bdReq) return;
    document.getElementById('bd-count').textContent = 'No se pudo cargar la tabla';
    document.getElementById('bd-tbody').innerHTML = `<tr><td colspan="22" style="color:var(--brick);">${esc(err.message)}</td></tr>`;
    document.getElementById('bd-mas').hidden = true;
  }
}
async function renderBD(){
  await paintBdTotals();
  if (!mysqlOk) {
    document.getElementById('bd-count').textContent = 'MySQL no está disponible';
    return;
  }
  await ensureBdDefaults();
  paintDocentesDatalist();
  await bdLoad(true);
}
document.getElementById('bd-cancelar').addEventListener('click', ()=>fillBdForm(null));
document.getElementById('bd-guardar').addEventListener('click', async ()=>{
  const id = document.getElementById('bd-f-id').value;
  if (!id){ toast('Elige un registro con Editar.'); return; }
  const body = {
    anio: document.getElementById('bd-f-anio').value.trim(),
    no: document.getElementById('bd-f-no').value.trim(),
    folio: document.getElementById('bd-f-folio').value.trim(),
    grado: document.getElementById('bd-f-grado').value.trim(),
    alumno: document.getElementById('bd-f-alumno').value,
    titulo_tesis: document.getElementById('bd-f-titulo').value.trim(),
    fecha_elaboracion: document.getElementById('bd-f-fecha').value,
    docente: document.getElementById('bd-f-docente').value.trim(),
    fungio: document.getElementById('bd-f-fungio').value,
    punto: document.getElementById('bd-f-punto').value.trim(),
    ciudad: document.getElementById('bd-f-ciudad').value.trim(),
    no_caja: document.getElementById('bd-f-caja').value.trim(),
    capturo: document.getElementById('bd-f-capturo').value.trim(),
    fecha_captura: document.getElementById('bd-f-fechacap').value,
    archivo: document.getElementById('bd-f-archivo').value,
    digital: document.getElementById('bd-f-digital').value,
    programa: document.getElementById('bd-f-programa').value.trim(),
    pdf: document.getElementById('bd-f-pdf').value.trim(),
    cd: document.getElementById('bd-f-cd').value.trim(),
    observaciones: document.getElementById('bd-f-obs').value.trim()
  };
  if (!body.alumno.trim() || !body.titulo_tesis || !body.docente) {
    toast('Alumno, título y docente son obligatorios.');
    return;
  }
  try {
    await apiSend('/api/bd/'+id, 'PUT', body);
    toast('Registro actualizado en MySQL. La actividad docente se recalcula sola.');
    fillBdForm(null);
    actState.ready = false;
    await loadAll();
    await bdLoad(true);
  } catch (err) { toast(err.message); }
});
function readBdFilters(){
  bdState.anio = document.getElementById('bd-anio').value;
  bdState.grado = document.getElementById('bd-grado').value;
  bdState.ciudad = document.getElementById('bd-ciudad').value;
  bdState.programa = document.getElementById('bd-programa').value;
  bdState.punto = document.getElementById('bd-punto').value;
  bdState.q = document.getElementById('bd-q').value.trim();
}
document.getElementById('bd-anio').addEventListener('change', ()=>{ readBdFilters(); bdLoad(true); });
document.getElementById('bd-grado').addEventListener('change', ()=>{ readBdFilters(); bdLoad(true); });
document.getElementById('bd-ciudad').addEventListener('change', ()=>{ readBdFilters(); bdLoad(true); });
document.getElementById('bd-programa').addEventListener('change', ()=>{ readBdFilters(); bdLoad(true); });
document.getElementById('bd-punto').addEventListener('change', ()=>{ readBdFilters(); bdLoad(true); });
let bdQTimer = null;
document.getElementById('bd-q').addEventListener('input', ()=>{
  clearTimeout(bdQTimer);
  bdQTimer = setTimeout(()=>{ readBdFilters(); bdLoad(true); }, 300);
});
document.querySelectorAll('#bd-table th[data-sort]').forEach(th=>{
  th.addEventListener('click', ()=>{
    if (bdState.sort === th.dataset.sort) bdState.dir = bdState.dir === 'asc' ? 'desc' : 'asc';
    else { bdState.sort = th.dataset.sort; bdState.dir = 'asc'; }
    bdLoad(true);
  });
});
document.getElementById('bd-limpiar').addEventListener('click', ()=>{
  document.getElementById('bd-anio').value = '';
  document.getElementById('bd-grado').value = 'Todos';
  document.getElementById('bd-ciudad').value = 'Todas';
  document.getElementById('bd-programa').value = 'Todos';
  document.getElementById('bd-punto').value = 'Todos';
  document.getElementById('bd-q').value = '';
  bdState.sort = 'id'; bdState.dir = 'asc';
  readBdFilters();
  bdStatus('');
  bdLoad(true);
});
document.getElementById('bd-vertodo').addEventListener('click', ()=>{
  document.getElementById('bd-anio').value = '';
  document.getElementById('bd-grado').value = 'Todos';
  document.getElementById('bd-ciudad').value = 'Todas';
  document.getElementById('bd-programa').value = 'Todos';
  document.getElementById('bd-punto').value = 'Todos';
  document.getElementById('bd-q').value = '';
  bdState.sort = 'id'; bdState.dir = 'asc';
  readBdFilters();
  bdStatus('');
  bdLoad(true);
});
document.getElementById('bd-mas').addEventListener('click', ()=>bdLoad(false));

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
      await renderBD();
      const idx = expedientes.findIndex(x=>x.id===e.id);
      if (idx >= 0) showDocsTesis(idx);
      toast('Documento agregado');
    } catch (err) { toast(err.message || 'No se pudo subir el archivo'); }
  });
  box.querySelectorAll('.bd-doc-del').forEach(a=>a.addEventListener('click', async ()=>{
    const x = e.documentos[+a.dataset.i];
    if(!needSb()) return;
    const { error } = await sb.from('tesis_documentos').delete().eq('id', x.id);
    if(error){ toast(error.message); return; }
    if(x.storage_path) await sb.storage.from('documentos').remove([x.storage_path]);
    e.documentos.splice(+a.dataset.i,1);
    await renderBD();
    const idx = expedientes.findIndex(t=>t.id===e.id);
    if (idx >= 0) showDocsTesis(idx);
  }));
}

/* BÚSQUEDA */
async function renderBusqueda(){
  if (mysqlOk) {
    const q = document.getElementById('bu-q').value.trim();
    try {
      const data = await apiGet('/api/bd?page=1&limit=50&q=' + encodeURIComponent(q));
      document.getElementById('bu-tbody').innerHTML = (data.rows||[]).map(t=>`
        <tr><td>${esc(t.folio)||'—'}</td><td class="alumno-cell">${esc(alumnoTxt(t.alumno))}</td><td>${esc(t.grado)||'—'}</td>
        <td style="max-width:260px;">${esc(t.titulo_tesis)}</td><td>${t.anio||'—'}</td><td>${esc(t.ciudad)||'—'}</td><td>${esc(t.programa)||'—'}</td></tr>
      `).join('') || `<tr><td colspan="7" style="color:var(--ink-soft);">Sin resultados.</td></tr>`;
    } catch (err) {
      document.getElementById('bu-tbody').innerHTML = `<tr><td colspan="7">${esc(err.message)}</td></tr>`;
    }
    return;
  }
  const q = norm(document.getElementById('bu-q').value);
  const rows = flatRows().filter(r=> !q || norm(r.e.alumno).includes(q) || norm(r.d.nombre).includes(q) || norm(r.e.titulo).includes(q) || String(r.d.folio).includes(q));
  document.getElementById('bu-tbody').innerHTML = rows.map(r=>{
    const noTesis = expedientes.indexOf(r.e)+1;
    return `<tr><td>${folioTxt(r.d.folio)}</td><td>${r.e.alumno}</td><td>${pillGrado(r.e.grado)}</td><td style="max-width:260px;">${r.e.titulo}</td><td>${r.d.nombre}</td><td>${r.d.fungio}</td><td>${noTesis}</td></tr>`;
  }).join('') || `<tr><td colspan="7" style="color:var(--ink-soft);">Sin resultados.</td></tr>`;
}
document.getElementById('bu-q').addEventListener('input', renderBusqueda);

/* CONSTANCIAS */
window._constPuntoFilter = 'todos';
function renderConstFilters(){
  const opts = [
    {v:'todos', l:'Todos'},{v:'individual', l:'Individual'},
    {v:'3.3.1', l:'3.3.1'},{v:'3.3.3', l:'3.3.3'},{v:'3.3.2', l:'3.3.2'}
  ];
  document.getElementById('c-filterrow').innerHTML = opts.map(o=>`<button class="filterbtn ${window._constPuntoFilter===o.v?'sel':''}" data-v="${o.v}">${o.l}</button>`).join('');
  if (REF_CONST[window._constPuntoFilter]) document.getElementById('c-tipo').value = window._constPuntoFilter;
  document.querySelectorAll('#c-filterrow .filterbtn').forEach(b=>b.addEventListener('click', ()=>{
    window._constPuntoFilter=b.dataset.v;
    if (REF_CONST[b.dataset.v]) document.getElementById('c-tipo').value = b.dataset.v;
    renderConstFilters(); renderConstanciasSelect();
    if (cTesis) paintConstanciaTesis(cTesis);
  }));
}
function matchesConstFilter(r){
  const f = window._constPuntoFilter;
  if(f==='todos') return true;
  if(f==='individual') return r.e.programa==='Individual';
  const p = puntoDe(r);
  if(f==='3.3.1') return p.startsWith('3.3.1');
  if(f==='3.3.3') return p.startsWith('3.3.3');
  if(f==='3.3.2') return p.startsWith('3.3.2');
  return true;
}
function renderConstanciasSelect(){}
let cTesis = null;
function renderConstanciaPreview(id){
  const found = flatRows().find(r=>r.d.id===id);
  const box = document.getElementById('c-preview'), letterBox = document.getElementById('c-letterwrap');
  if(!found){ box.innerHTML=''; letterBox.innerHTML=''; return; }
  const {e,d} = found, docente = getDocente(d.nombre), noTesis = expedientes.indexOf(e)+1;
  box.innerHTML = `
    <div class="row2"><div class="field"><label>No. de Tesis</label><input value="${noTesis}" disabled></div><div class="field"><label>Folio</label><input id="c-folio-manual" inputmode="numeric" placeholder="Escríbelo" value="${d.folio||''}"></div></div>
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
    const fe=document.getElementById('c-fecha').value||today();
    const escrito=document.getElementById('c-folio-manual').value.trim();
    const tipo = tipoConstanciaDe(puntoDe(found));
    document.getElementById('c-tipo').value = tipo;
    const ok = await saveEmitido({fecha:fe,tipo:'Constancia '+REF_CONST[tipo],dest:'LAG. LUIS FERNANDO RUIZ ROCHA',docente:d.nombre,detalle:e.alumno+' — '+tipo});
    if(!ok && !mysqlOk) return;
    letterBox.innerHTML = htmlCartaConstancia({
      tipo, folio: escrito, fecha: fe,
      docente: (docente&&docente.nombre)||d.nombre,
      empleado: docente ? docente.empleado : '—',
      sexo: docente && docente.sexo,
      fungio: d.fungio,
      alumno: nombresAlumnoCarta(e.alumno),
      grado: e.grado, titulo: e.titulo, fechaConcl: mesAnioCap(e.fecha)
    });
    bindImprimirCarta('Constancia');
  });
}
function buscarConstancia(){
  const raw = document.getElementById('c-buscar-folio').value.trim();
  if(!raw){ toast('Escribe el folio.'); return; }
  if (mysqlOk) { buscarConstanciaMysql(raw); return; }
  if(!/^\d+$/.test(raw)){ toast('Escribe el número de folio.'); return; }
  const found = flatRows().find(r=>String(r.d.folio)===raw);
  if(!found){
    toast('No hay un registro con ese folio.');
    document.getElementById('c-preview').innerHTML='';
    document.getElementById('c-letterwrap').innerHTML='';
    return;
  }
  renderConstanciaPreview(found.d.id);
}
async function buscarConstanciaMysql(folio){
  const box = document.getElementById('c-preview');
  const letterBox = document.getElementById('c-letterwrap');
  const fallback = document.getElementById('c-alumno-fallback');
  letterBox.innerHTML = '';
  try {
    const data = await apiGet('/api/constancias?folio=' + encodeURIComponent(folio));
    if (!data.found || !data.tesis.length) {
      box.innerHTML = '<p class="lede" style="color:var(--brick);">Folio no encontrado</p>';
      fallback.hidden = false;
      toast('Folio no encontrado');
      return;
    }
    fallback.hidden = true;
    if (data.tesis.length === 1) paintConstanciaTesis(data.tesis[0]);
    else {
      box.innerHTML = `<p class="lede">Hay ${data.tesis.length} tesis con ese folio. Elige una:</p>
        <div class="tablewrap"><table class="excel-table"><thead><tr><th>Año</th><th>Alumno</th><th>Título</th><th></th></tr></thead>
        <tbody>${data.tesis.map((t,i)=>`<tr><td>${t.anio||'—'}</td><td class="alumno-cell">${esc(alumnoTxt(t.alumno))}</td>
          <td>${esc(t.titulo_tesis)}</td><td><button class="btn small c-pick" data-i="${i}">Elegir</button></td></tr>`).join('')}</tbody></table></div>`;
      box.querySelectorAll('.c-pick').forEach(b=>b.addEventListener('click', ()=>paintConstanciaTesis(data.tesis[+b.dataset.i])));
    }
  } catch (err) { box.innerHTML = `<p class="lede">${esc(err.message)}</p>`; }
}
function paintConstanciaTesis(t){
  cTesis = t;
  const tipoAuto = tipoConstanciaDe(t.punto);
  document.getElementById('c-tipo').value = tipoAuto;
  const docs = t.docentes || [];
  const docOpts = docs.map((d,i)=>`<option value="${i}">${esc(d.nombre)} · ${esc(d.fungio)||'—'}</option>`).join('');
  document.getElementById('c-preview').innerHTML = `
    <div class="row2"><div class="field"><label>Folio</label><input id="c-folio-manual" value="${esc(t.folio)||''}"></div>
      <div class="field"><label>Fecha de emisión</label><input id="c-fecha" type="date" value="${today()}"></div></div>
    <div class="row2">
      <div class="field"><label>Docente (para quien se emite)</label><select id="c-doc-sel">${docOpts}</select></div>
      <div class="field"><label>Fungió</label><input id="c-fungio-view" disabled></div>
    </div>
    <div class="row2"><div class="field"><label>Alumno(s)</label><textarea disabled>${esc(nombresAlumnoCarta(t.alumno))}</textarea></div>
      <div class="field"><label>Título</label><textarea disabled>${esc(t.titulo_tesis)}</textarea></div></div>
    <div class="row4">
      <div class="field"><label>Grado</label><input value="${esc(t.grado)||'—'}" disabled></div>
      <div class="field"><label>Fecha de conclusión</label><input value="${esc(mesAnioCap(t.fecha_elaboracion))}" disabled></div>
      <div class="field"><label>Programa</label><input value="${esc(t.programa)||'—'}" disabled></div>
      <div class="field"><label>Punto</label><input value="${esc(t.punto)||'—'}" disabled></div>
    </div>
    <p class="note sage">El tipo de constancia (3.3.1 dirigió / 3.3.2 revisó / 3.3.3 tesina) cambia el encabezado y las columnas de la tabla. Elige el docente y pulsa Generar.</p>
    <button class="btn" id="c-generar" style="margin-top:14px;">Generar constancia</button>`;
  const syncFungio = ()=>{
    const d = docs[+document.getElementById('c-doc-sel').value];
    document.getElementById('c-fungio-view').value = d ? (d.fungio||'—') : '—';
  };
  document.getElementById('c-doc-sel').addEventListener('change', syncFungio);
  syncFungio();
  document.getElementById('c-tipo').onchange = ()=>{ if (cTesis) {/* tipo se lee al generar */} };
  document.getElementById('c-generar').addEventListener('click', ()=>generarConstanciaDocente(t, docs[+document.getElementById('c-doc-sel').value]||docs[0]));
}
async function generarConstanciaDocente(t, doc){
  if (!doc){ toast('Elige un docente.'); return; }
  const tipo = document.getElementById('c-tipo').value || tipoConstanciaDe(t.punto);
  const fe = (document.getElementById('c-fecha') && document.getElementById('c-fecha').value) || today();
  const folio = (document.getElementById('c-folio-manual') && document.getElementById('c-folio-manual').value.trim()) || t.folio || '';
  const extra = doc.docente_id ? getDocente(doc.nombre) : getDocente(doc.nombre);
  const sexo = doc.sexo || (extra && extra.sexo) || '';
  const empleado = doc.num_empleado || (extra && extra.empleado) || '—';
  const ok = await saveEmitido({ fecha:fe, tipo:'Constancia '+REF_CONST[tipo], dest:'LAG. LUIS FERNANDO RUIZ ROCHA', docente:doc.nombre, detalle:nombresAlumnoCarta(t.alumno)+' — '+tipo });
  if (!ok && mysqlOk===false) return;
  document.getElementById('c-letterwrap').innerHTML = htmlCartaConstancia({
    tipo, folio, fecha: fe,
    docente: doc.nombre, empleado, sexo, fungio: doc.fungio,
    alumno: nombresAlumnoCarta(t.alumno),
    grado: t.grado, titulo: t.titulo_tesis, fechaConcl: mesAnioCap(t.fecha_elaboracion)
  });
  bindImprimirCarta('Constancia-'+(t.folio||tipo));
}
let cAluTimer=null;
document.getElementById('c-alumno-q').addEventListener('input', ()=>{
  const q = document.getElementById('c-alumno-q').value.trim();
  const sugg = document.getElementById('sugg-c-alumno');
  clearTimeout(cAluTimer);
  if(!q){ sugg.classList.remove('show'); return; }
  cAluTimer=setTimeout(async ()=>{
    try {
      const data = await apiGet('/api/bd?page=1&limit=12&q='+encodeURIComponent(q));
      const rows = data.rows||[];
      sugg.innerHTML = rows.length ? rows.map(r=>`<div data-folio="${esc(r.folio||'')}">${esc(alumnoTxt(r.alumno))} <span class="badge">${esc(r.folio||'sin folio')}</span></div>`).join('') : '<div class="none">Sin coincidencias</div>';
      sugg.classList.add('show');
      sugg.querySelectorAll('div[data-folio]').forEach(opt=>opt.addEventListener('click', ()=>{
        document.getElementById('c-buscar-folio').value = opt.dataset.folio;
        sugg.classList.remove('show');
        if (opt.dataset.folio) buscarConstanciaMysql(opt.dataset.folio);
      }));
    } catch(_){}
  }, 250);
});
document.getElementById('c-alumno-q').addEventListener('blur', ()=>setTimeout(()=>document.getElementById('sugg-c-alumno').classList.remove('show'), 180));
document.getElementById('c-buscar').addEventListener('click', buscarConstancia);
document.getElementById('c-buscar-folio').addEventListener('keydown', e=>{ if(e.key==='Enter') buscarConstancia(); });

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
  if (mysqlOk) {
    try {
      const data = await apiGet('/api/bd?page=1&limit=500&q='+encodeURIComponent(nombre));
      const rows=(data.rows||[]).filter(r=>r.docente===nombre && (cargo==='ALL'||cargoKey(r.fungio||'')===cargo) && (grado==='all'||r.grado===grado) && (!desde||isoDate(r.fecha_elaboracion).slice(0,7)>=desde) && (!hasta||isoDate(r.fecha_elaboracion).slice(0,7)<=hasta));
      if(!rows.length){ box.innerHTML=''; toast('No hay tesis con esos filtros.'); return; }
      await saveEmitido({fecha:fe,tipo:'Constancia concentrada',dest,docente:nombre,detalle:rows.length+' tesis'});
      box.innerHTML=`<div class="letter"><div class="folio">Chihuahua, Chih., a ${fechaLarga(fe)}</div>
        <p><b>${esc(dest)}</b><br>P R E S E N T E.-</p>
        <p>Por medio de la presente se hace constar que <b>${esc(nombre)}</b> ha participado en <b>${rows.length}</b> trabajo(s) de tesis.</p>
        <div class="tablewrap"><table><thead><tr><th>Fecha</th><th>Alumno</th><th>Grado</th><th>Título</th><th>Cargo</th></tr></thead>
        <tbody>${rows.map(r=>`<tr><td>${esc(mesAnioTxt(r.fecha_elaboracion))}</td><td class="alumno-cell">${esc(alumnoTxt(r.alumno))}</td><td>${esc(r.grado)}</td><td>${esc(r.titulo_tesis)}</td><td>${esc(r.fungio)}</td></tr>`).join('')}</tbody></table></div>
        <p style="margin-top:30px;"><b>ATENTAMENTE</b><br>&ldquo;LUCHAR PARA LOGRAR, LOGRAR PARA DAR&rdquo;</p></div>`;
    } catch(err){ toast(err.message); }
    return;
  }
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
      <tbody>${rows.map(r=>`<tr><td>#${cons[r.d.id]}</td><td>${r.e.fecha}</td><td>${r.e.alumno}</td><td>${r.e.grado}</td><td>${r.e.titulo}</td><td>${r.d.fungio}</td></tr>`).join('')}</tbody></table></div>
    <p>Sin otro particular, quedo de usted.</p><p style="margin-top:30px;">A T E N T A M E N T E</p></div>`;
}

async function renderHistorial(){
  if (mysqlOk) {
    try {
      const data = await apiGet('/api/historial');
      const rows = data.rows||[];
      document.getElementById('hi-tbody').innerHTML = rows.length ? rows.map(r=>`<tr>
        <td>${isoDate(r.creado_en)} ${String(r.creado_en||'').slice(11,19)}</td>
        <td>${esc(r.tipo)}</td><td>${esc(r.usuario)||'—'}</td>
        <td>${esc(r.valor_anterior)||'—'}</td><td>${esc(r.valor_nuevo)||'—'}</td>
        <td>${esc(r.detalle)||'—'}</td></tr>`).join('') : '<tr><td colspan="6" style="color:var(--ink-soft);">Aún no hay movimientos.</td></tr>';
    } catch(err){ document.getElementById('hi-tbody').innerHTML = `<tr><td colspan="6">${esc(err.message)}</td></tr>`; }
    return;
  }
  const rows=emitidos.slice().sort((a,b)=>b.fecha.localeCompare(a.fecha));
  document.getElementById('hi-tbody').innerHTML=rows.map(r=>`<tr><td>${r.fecha}</td><td>${r.tipo}</td><td>${r.dest}</td><td>—</td><td>${r.detalle}</td><td></td></tr>`).join('')||'<tr><td colspan="6" style="color:var(--ink-soft);">Aún no se ha generado ningún oficio o constancia.</td></tr>';
}
/* ASIGNACIÓN / OFICIO */
const asState = { ready:false, anio:'', estatus:'Todos', q:'', page:1, rows:[], total:0 };
function asFormPayload(){
  return {
    anio: document.getElementById('as-f-anio').value.trim() || null,
    no: document.getElementById('as-f-no').value.trim() || null,
    folio_a: document.getElementById('as-f-folioa').value.trim(),
    folio_m: document.getElementById('as-f-foliom').value.trim(),
    nombre_alumno: document.getElementById('as-f-alumno').value.trim(),
    sexo: document.getElementById('as-f-sexo').value,
    matricula: document.getElementById('as-f-mat').value.trim(),
    programa: document.getElementById('as-f-prog').value.trim(),
    telefono_a: document.getElementById('as-f-tela').value.trim(),
    correo_a: document.getElementById('as-f-correoa').value.trim(),
    nombre_docente: document.getElementById('as-f-docente').value.trim(),
    telefono_docente: document.getElementById('as-f-teld').value.trim(),
    correo_docente: document.getElementById('as-f-correod').value.trim(),
    fecha_solicitud: document.getElementById('as-f-fecha').value || null,
    estatus: document.getElementById('as-f-estatus').value.trim(),
    tesis_entregada: document.getElementById('as-f-entregada').value.trim(),
    ea: document.getElementById('as-f-ea').value.trim(),
    ed: document.getElementById('as-f-ed').value.trim(),
    observaciones: document.getElementById('as-f-obs').value.trim()
  };
}
function fillAsForm(r){
  document.getElementById('as-id').value = r ? r.id : '';
  document.getElementById('as-form-title').textContent = r ? 'Editar asignación' : 'Agregar asignación';
  if (r) document.getElementById('as-form-title').scrollIntoView({ behavior:'smooth', block:'nearest' });
  document.getElementById('as-f-anio').value = r ? (r.anio||'') : '';
  document.getElementById('as-f-no').value = r ? (r.no||'') : '';
  document.getElementById('as-f-folioa').value = r ? (r.folio_a||'') : '';
  document.getElementById('as-f-foliom').value = r ? (r.folio_m||'') : '';
  document.getElementById('as-f-alumno').value = r ? (r.nombre_alumno||'') : '';
  document.getElementById('as-f-sexo').value = r && r.sexo ? r.sexo : '';
  document.getElementById('as-f-mat').value = r ? (r.matricula||'') : '';
  document.getElementById('as-f-prog').value = r ? (r.programa||'') : '';
  document.getElementById('as-f-tela').value = r ? (r.telefono_a||'') : '';
  document.getElementById('as-f-correoa').value = r ? (r.correo_a||'') : '';
  document.getElementById('as-f-docente').value = r ? (r.nombre_docente||'') : '';
  document.getElementById('as-f-teld').value = r ? (r.telefono_docente||'') : '';
  document.getElementById('as-f-correod').value = r ? (r.correo_docente||'') : '';
  document.getElementById('as-f-fecha').value = r ? isoDate(r.fecha_solicitud) : '';
  document.getElementById('as-f-estatus').value = r ? (r.estatus||'') : '';
  document.getElementById('as-f-entregada').value = r ? (r.tesis_entregada||'') : '';
  document.getElementById('as-f-ea').value = r ? (r.ea||'') : '';
  document.getElementById('as-f-ed').value = r ? (r.ed||'') : '';
  document.getElementById('as-f-obs').value = r ? (r.observaciones||'') : '';
}
function paintAsignacion(){
  document.getElementById('as-count').textContent = 'Total: ' + asState.total;
  document.getElementById('as-mas').hidden = asState.rows.length >= asState.total;
  document.getElementById('as-tbody').innerHTML = asState.rows.length ? asState.rows.map(r=>`<tr>
    <td class="col-accion admin-only"><button type="button" class="btn small edit-btn as-ed" data-id="${r.id}">Editar</button></td>
    <td>${esc(r.no)||'—'}</td><td>${esc(r.folio_a)||'—'}</td><td>${esc(r.sexo)||'—'}</td>
    <td>${esc(r.nombre_alumno)}</td><td>${esc(r.matricula)||'—'}</td><td>${esc(r.programa)||'—'}</td>
    <td>${esc(r.telefono_a)||'—'}</td><td>${esc(r.correo_a)||'—'}</td><td>${esc(r.folio_m)||'—'}</td>
    <td>${esc(r.nombre_docente)}</td><td>${esc(r.telefono_docente)||'—'}</td><td>${esc(r.correo_docente)||'—'}</td>
    <td>${isoDate(r.fecha_solicitud)||'—'}</td><td>${esc(r.estatus)||'—'}</td>
    <td>${esc(r.ea)||'—'}</td><td>${esc(r.ed)||'—'}</td><td>${esc(r.tesis_entregada)||'—'}</td>
    <td>${esc(r.observaciones)||'—'}</td>
  </tr>`).join('') : '<tr><td colspan="19" style="color:var(--ink-soft);">Sin asignaciones.</td></tr>';
  document.querySelectorAll('.as-ed').forEach(a=>a.addEventListener('click', ()=>{
    const r = asState.rows.find(x=>String(x.id)===a.dataset.id);
    if (r) fillAsForm(r);
  }));
}
async function renderAsignacion(reset){
  const af=document.getElementById('as-fecha'); if(!af.value) af.value=today();
  if (!mysqlOk) {
    document.getElementById('as-tbody').innerHTML = '<tr><td colspan="19">MySQL no está disponible</td></tr>';
    return;
  }
  if (reset!==false) { asState.page = 1; asState.rows = []; }
  const qs = new URLSearchParams();
  qs.set('page', String(asState.page)); qs.set('limit','50');
  if (asState.anio) qs.set('anio', asState.anio);
  if (asState.estatus) qs.set('estatus', asState.estatus);
  if (asState.q) qs.set('q', asState.q);
  try {
    const data = await apiGet('/api/asignacion?'+qs.toString());
    if (!asState.ready) {
      document.getElementById('as-anio').innerHTML = '<option value="">Todos</option>'+(data.anios||[]).map(y=>`<option>${y}</option>`).join('');
      document.getElementById('as-estatus').innerHTML = '<option value="Todos">Todos</option>'+(data.estatuses||[]).map(e=>`<option>${esc(e)}</option>`).join('');
      asState.ready = true;
    }
    asState.total = data.total||0;
    asState.rows = asState.page===1 ? (data.rows||[]) : asState.rows.concat(data.rows||[]);
    paintAsignacion();
    paintDocentesDatalist();
  } catch(err){ toast(err.message); }
}
document.getElementById('as-anio').addEventListener('change', ()=>{ asState.anio=document.getElementById('as-anio').value; renderAsignacion(true); });
document.getElementById('as-estatus').addEventListener('change', ()=>{ asState.estatus=document.getElementById('as-estatus').value; renderAsignacion(true); });
let asQTimer=null;
document.getElementById('as-q').addEventListener('input', ()=>{
  clearTimeout(asQTimer);
  asQTimer=setTimeout(()=>{ asState.q=document.getElementById('as-q').value.trim(); renderAsignacion(true); }, 280);
});
document.getElementById('as-mas').addEventListener('click', ()=>{ asState.page += 1; renderAsignacion(false); });
document.getElementById('as-cancelar').addEventListener('click', ()=>fillAsForm(null));
document.getElementById('as-guardar').addEventListener('click', async ()=>{
  const id = document.getElementById('as-id').value;
  const body = asFormPayload();
  try {
    if (id) await apiSend('/api/asignacion/'+id, 'PUT', body);
    else await apiSend('/api/asignacion', 'POST', body);
    toast('Asignación guardada');
    fillAsForm(null);
    renderAsignacion(true);
  } catch(err){ toast(err.message); }
});
document.getElementById('as-tipo').addEventListener('change', ()=>{
  const com = document.getElementById('as-tipo').value === 'Comite';
  document.getElementById('as-comite-campos').hidden = !com;
  if (com) paintDocentesDatalist();
});
document.getElementById('as-oficio-btn').addEventListener('click', async ()=>{
  const tipo = document.getElementById('as-tipo').value;
  const folio = document.getElementById('as-folio-of').value.trim();
  if(!folio){ toast('Escribe el folio.'); return; }
  try {
    const data = await apiGet('/api/asignacion/oficio?tipo='+encodeURIComponent(tipo)+'&folio='+encodeURIComponent(folio));
    if (!data.found){ toast('Folio no encontrado'); document.getElementById('as-oficiowrap').innerHTML=''; return; }
    const r = data.rows[0];
    const fe = document.getElementById('as-fecha').value||today();
    const dirCargo = cargoDirectorOficio(r.nombre_docente);
    if (tipo === 'Comite') {
      rellenarCamposComite(sugerirNombresComite(data.relacionados, r.nombre_docente));
      const miembros = miembrosComiteDeCampos();
      if (!miembros.length) {
        toast('Escribe los asesores del comité y vuelve a generar.');
        document.getElementById('as-comite-campos').hidden = false;
        paintDocentesDatalist();
        return;
      }
      const opts = {
        kind: 'oficio-comite',
        ofNo: codigoOficioComite(r, folio),
        fecha: fe,
        asunto: 'Asignación Comité de Grado',
        dest: 'Miembros del Comité',
        alumno: r.nombre_alumno || '—',
        docente: r.nombre_docente || '—',
        dirigidoPor: dirigidoPorTxt(r.nombre_docente),
        miembros
      };
      ultimaCartaOpts = opts;
      await saveEmitido({ fecha:fe, tipo:'Oficio '+opts.asunto, dest:opts.dest, docente:r.nombre_docente, detalle:'Oficio No. '+opts.ofNo });
      document.getElementById('as-oficiowrap').innerHTML = htmlOficioComite(opts);
      bindImprimirCarta('Oficio-Comite-'+folio);
      return;
    }
    if (tipo === 'Doctor') {
      const femDir = String(sexoDocenteOficio(r.nombre_docente)).toUpperCase()==='F' || /^dra\.?\b/i.test(String(r.nombre_docente||'').trim());
      const femAlum = String(r.sexo||'').toUpperCase()==='F';
      const tipoTesis = programaEsDoctorado(r.programa) ? 'tesis doctoral' : (programaEsMaestria(r.programa) ? 'tesis de maestría' : 'tesis');
      const opts = {
        kind: 'oficio-doctor',
        ofNo: codigoOficioComite(r, folio),
        fecha: fe,
        asunto: 'Asignación Director',
        dest: nombreDocenteOficio(r.nombre_docente),
        alumno: r.nombre_alumno || '—',
        docente: r.nombre_docente || '—',
        femDir, femAlum, tipoTesis
      };
      ultimaCartaOpts = opts;
      await saveEmitido({ fecha:fe, tipo:'Oficio '+opts.asunto, dest:opts.dest, docente:r.nombre_docente, detalle:'Oficio No. '+opts.ofNo });
      document.getElementById('as-oficiowrap').innerHTML = htmlOficioDoctor(opts);
      bindImprimirCarta('Oficio-Director-'+folio);
      return;
    }
    const ofNo = codigoOficioAsignacion(r, folio);
    const opts = {
      kind: 'oficio-alumno',
      ofNo, fecha: fe,
      asunto: 'Dirección de Tesis',
      dest: nombreAlumnoOficio(r.nombre_alumno, r.sexo, r.programa),
      alumno: nombreAlumnoOficio(r.nombre_alumno, r.sexo, r.programa),
      docente: r.nombre_docente || '—',
      programa: gradoLargoPrograma(r.programa),
      gradoCorto: gradoCortoPrograma(r.programa),
      dirCargo,
      telDoc: r.telefono_docente || '—',
      correoDoc: r.correo_docente || '—',
      telAlum: r.telefono_a || '—',
      correoAlum: r.correo_a || '—'
    };
    ultimaCartaOpts = opts;
    await saveEmitido({ fecha:fe, tipo:'Oficio '+opts.asunto, dest:opts.dest, docente:r.nombre_docente, detalle:'Oficio No. '+ofNo });
    document.getElementById('as-oficiowrap').innerHTML = htmlOficioAlumno(opts);
    bindImprimirCarta('Oficio-'+folio);
  } catch(err){ toast(err.message); }
});

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
  if (!LOGIN_ACTIVO) return;
  if (sb) await sb.auth.signOut();
  alumnos = []; docentes = []; expedientes = []; emitidos = [];
  authRol = 'usuario';
  document.getElementById('app-shell').hidden = true;
  document.getElementById('auth-gate').hidden = false;
});
(async function boot(){
  const hasSb = initClient();
  if (!LOGIN_ACTIVO) {
    authRol = 'admin';
    try { await loadAll(); }
    catch (err) {
      if (!hasSb && !mysqlOk) {
        showAuthMsg(err.message || 'No se pudieron cargar los datos. Revisa MySQL (XAMPP) o config.js.');
        return;
      }
      toast(err.message || 'No se pudieron cargar los datos');
    }
    document.getElementById('auth-gate').hidden = true;
    document.getElementById('app-shell').hidden = false;
    document.getElementById('btn-salir').hidden = true;
    setRole('admin', true);
    goTab(document.querySelector('.tab.active')?.dataset.tab || 'inicio');
    return;
  }
  if (!hasSb) {
    showAuthMsg('Pega la publishable key en config.js (SUPABASE_KEY) y recarga.');
    return;
  }
  const { data } = await sb.auth.getSession();
  if (data.session) {
    try { await enterApp(); }
    catch (err) { showAuthMsg(err.message || 'No se pudieron cargar los datos'); }
  }
})();
