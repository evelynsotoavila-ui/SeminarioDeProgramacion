const { query } = require('./db');
(async () => {
  const colsD = await query('SHOW COLUMNS FROM docentes');
  console.log('DOCENTES', colsD.map(c => c.Field + ' ' + c.Type).join(' | '));
  const colsB = await query('SHOW COLUMNS FROM bd');
  console.log('BD', colsB.map(c => c.Field).join(','));
  try {
    const v = await query('SHOW CREATE VIEW v_actividad_docente');
    console.log('ACT', v[0]['Create View']);
  } catch (e) { console.log('view err', e.message); }
  try {
    const v2 = await query('SHOW CREATE VIEW v_docentes');
    console.log('V_DOC', v2[0]['Create View']);
  } catch (e) { console.log('v_doc', e.message); }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
