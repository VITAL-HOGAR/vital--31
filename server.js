// ============================================================
// VITAL HOGAR PRO — API completa sobre Supabase
// Adaptada al esquema real: admission_consents, internal_messages,
// financial_parameters, client_tariffs, treatment_plans (join manual)
// Estructura: /server.js  y  /public/index.html
// ============================================================
import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, JWT_SECRET, PORT = 3000 } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !JWT_SECRET) { console.error('Faltan variables en .env'); process.exit(1); }

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const app = express();
app.use(cors());
app.use(express.json({ limit: '8mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- helpers ----------
const ok = (res, data = null, message = 'OK') => res.json({ success: true, data, message });
const fail = (res, message, code = 400) => res.status(code).json({ success: false, message });
const h = fn => async (req, res) => { try { await fn(req, res); } catch (e) { console.error(e); if (!res.headersSent) fail(res, e.message || 'Error interno', 500); } };
const PROFASEL = '*, specialties(name)';
const monthRange = (y, m) => { const from = new Date(`${y}-${m}-01T00:00:00`); const to = new Date(from); to.setMonth(to.getMonth() + 1); return { from: from.toISOString(), to: to.toISOString() }; };
const in24h = (iso) => iso && (Date.now() - new Date(iso).getTime()) <= 24 * 3600 * 1000;
function nightHours(s, e) { let m = 0; const d = new Date(s); while (d < e) { const hh = d.getHours(); if (hh >= 20 || hh < 6) m++; d.setMinutes(d.getMinutes() + 1); } return m / 60; }
function sundayHours(s, e) { let m = 0; const d = new Date(s); while (d < e) { if (d.getDay() === 0) m++; d.setMinutes(d.getMinutes() + 1); } return m / 60; }

// Finanzas: filas "activas" en tus tablas existentes (financial_parameters / client_tariffs)
async function getActiveFinance() {
  let { data } = await sb.from('financial_parameters').select('*').eq('is_active', true).order('created_at', { ascending: false }).limit(1);
  if (data && data.length) return data[0];
  const { data: c } = await sb.from('financial_parameters').insert({ year: 2026, smmlv: 1623500, subsidy_transport: 200000, night_surcharge_percentage: 35, holiday_surcharge_percentage: 75, is_active: true }).select().single();
  return c;
}
async function getActiveTariffs() {
  let { data } = await sb.from('client_tariffs').select('*').eq('is_active', true).order('created_at', { ascending: false }).limit(1);
  if (data && data.length) return data[0];
  const { data: c } = await sb.from('client_tariffs').insert({ t_6h_diurno: 0, t_6h_nocturno: 0, t_8h_diurno: 0, t_8h_nocturno: 0, t_12h_diurno: 0, t_12h_nocturno: 0, t_24h: 0, is_active: true }).select().single();
  return c;
}

// ---------- auth ----------
async function authMiddleware(req, res, next) {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    if (!token) return fail(res, 'No autenticado', 401);
    const payload = jwt.verify(token, JWT_SECRET);
    const { data: prof } = await sb.from('professionals').select(PROFASEL).eq('id', payload.id).single();
    if (!prof || prof.is_active === false) return fail(res, 'Sesión inválida', 401);
    req.prof = prof; next();
  } catch { return fail(res, 'Sesión expirada', 401); }
}
const adminOnly = (req, res, next) => req.prof.specialties?.name === 'ADMINISTRACION' ? next() : fail(res, 'Solo Administración', 403);
const plansRole = (req, res, next) => ['ADMINISTRACION', 'ENFERMERIA_JEFE'].includes(req.prof.specialties?.name) ? next() : fail(res, 'Solo Administración o Enfermería Jefe', 403);

// ---------- LOGIN (público) ----------
app.post('/api/auth/login', h(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!email || !password) return fail(res, 'Complete todos los campos');
  const { data: prof } = await sb.from('professionals').select(PROFASEL).eq('email', email).single();
  if (!prof || !(await bcrypt.compare(password, prof.password_hash || ''))) return fail(res, 'Credenciales inválidas', 401);
  if (prof.is_active === false) return fail(res, 'Usuario archivado. Contacta al administrador.', 403);
  const token = jwt.sign({ id: prof.id, email: prof.email }, JWT_SECRET, { expiresIn: '12h' });
  const user = { id: prof.id, full_name: prof.full_name, email: prof.email, document_number: prof.document_number, professional_card: prof.professional_card, specialty_name: prof.specialties?.name, specialties: prof.specialties };
  ok(res, { token, user }, 'Bienvenido');
}));

app.use('/api', authMiddleware);

// ---------- PROFESIONALES ----------
app.get('/api/professionals', h(async (req, res) => {
  const { data, error } = await sb.from('professionals').select(PROFASEL).order('full_name');
  if (error) return fail(res, 'BD: ' + error.message, 500);
  ok(res, data || []);
}));
app.post('/api/professionals', adminOnly, h(async (req, res) => {
  const { fullName, documentNumber, professionalCard, email, password, specialtyName } = req.body || {};
  if (!fullName || !documentNumber || !email || !password || !professionalCard) return fail(res, 'Completa: nombre, cédula, tarjeta, correo y contraseña');
  const em = String(email).trim().toLowerCase();
  const { data: spec } = await sb.from('specialties').select('id').eq('name', specialtyName).single();
  if (!spec) return fail(res, 'Especialidad inválida');
  const { data: created, error } = await sb.from('professionals').insert({ full_name: fullName, document_number: documentNumber, professional_card: professionalCard, email: em, password_hash: await bcrypt.hash(password, 10), specialty_id: spec.id }).select(PROFASEL).single();
  if (error) return fail(res, 'Error guardando: ' + error.message);
  ok(res, created, 'Profesional creado con acceso');
}));
app.patch('/api/professionals/:id', adminOnly, h(async (req, res) => {
  const { fullName, documentNumber, professionalCard, specialtyName, newPassword } = req.body || {};
  const upd = {};
  if (fullName) upd.full_name = fullName;
  if (documentNumber) upd.document_number = documentNumber;
  if (professionalCard) upd.professional_card = professionalCard;
  if (specialtyName) { const { data: spec } = await sb.from('specialties').select('id').eq('name', specialtyName).single(); if (!spec) return fail(res, 'Especialidad inválida'); upd.specialty_id = spec.id; }
  if (newPassword) upd.password_hash = await bcrypt.hash(newPassword, 10);
  const { data: prof, error } = await sb.from('professionals').update(upd).eq('id', req.params.id).select(PROFASEL).single();
  if (error) return fail(res, 'Error actualizando: ' + error.message);
  ok(res, prof, 'Profesional actualizado' + (newPassword ? ' (contraseña incluida)' : ''));
}));
app.patch('/api/professionals/:id/deactivate', adminOnly, h(async (req, res) => {
  const active = req.body?.isActive !== false;
  const { error } = await sb.from('professionals').update({ is_active: active }).eq('id', req.params.id);
  if (error) return fail(res, 'Error: ' + error.message);
  ok(res, null, active ? 'Profesional reactivado' : 'Profesional archivado');
}));
app.delete('/api/professionals/:id', adminOnly, h(async (req, res) => {
  const { error } = await sb.from('professionals').delete().eq('id', req.params.id);
  if (error) return fail(res, 'No se pudo eliminar: ' + error.message);
  ok(res, null, 'Profesional eliminado permanentemente');
}));

// ---------- 📧 CAMBIO DE CORREO (solo Admin, doble confirmación, registro) ----------
app.patch('/api/professionals/:id/change-email', adminOnly, h(async (req, res) => {
  const e = String(req.body?.newEmail || '').trim().toLowerCase();
  const e2 = String(req.body?.newEmailConfirm || '').trim().toLowerCase();
  if (!e || !e2) return fail(res, 'Escribe el correo nuevo en ambos campos');
  if (e !== e2) return fail(res, 'Los correos no coinciden (doble confirmación)');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return fail(res, 'Correo inválido');
  const { data: prof } = await sb.from('professionals').select('id, email, full_name').eq('id', req.params.id).single();
  if (!prof) return fail(res, 'Profesional no encontrado', 404);
  if (prof.email.toLowerCase() === e) return fail(res, 'El correo nuevo es igual al actual');
  const anterior = prof.email;
  const { error } = await sb.from('professionals').update({ email: e }).eq('id', prof.id);
  if (error) return fail(res, 'No se pudo actualizar: ' + error.message);
  // Registro del cambio (no fatal si la tabla email_changes aún no existe)
  const { error: logErr } = await sb.from('email_changes').insert({ correo_anterior: anterior, correo_nuevo: e, confirmado_1: true, confirmado_2: true, realizado_por: req.prof.id, notificado: true });
  if (logErr) console.warn('email_changes no registrado:', logErr.message);
  ok(res, null, `Correo de ${prof.full_name} actualizado a ${e}. Notifica al usuario su nuevo acceso.`);
}));

// ---------- PACIENTES ----------
const PATSEL = '*, altitude_profiles(city_name)';
app.get('/api/patients', h(async (req, res) => { const { data } = await sb.from('patients').select(PATSEL).order('full_name'); ok(res, data || []); }));
app.post('/api/patients', h(async (req, res) => {
  const { fullName, documentNumber, cityName, familyName, contactPhone, cie10Code, epsName, epsAuthorization } = req.body || {};
  if (!fullName || !documentNumber) return fail(res, 'Completa: nombre y cédula');
  const { data: pat, error } = await sb.from('patients').insert({ full_name: fullName, document_number: documentNumber, family_name: familyName || null, contact_phone: contactPhone || null, cie_10_code: cie10Code || null, eps_name: epsName || null, eps_authorization: epsAuthorization || null }).select(PATSEL).single();
  if (error) return fail(res, 'Error: ' + error.message);
  if (cityName) await sb.from('altitude_profiles').insert({ patient_id: pat.id, city_name: cityName });
  ok(res, pat, 'Paciente creado');
}));
app.patch('/api/patients/:id', h(async (req, res) => {
  const { fullName, documentNumber, cityName, familyName, contactPhone, cie10Code, epsName, epsAuthorization } = req.body || {};
  const upd = {};
  if (fullName) upd.full_name = fullName;
  if (documentNumber) upd.document_number = documentNumber;
  if (familyName !== undefined) upd.family_name = familyName;
  if (contactPhone !== undefined) upd.contact_phone = contactPhone;
  if (cie10Code !== undefined) upd.cie_10_code = cie10Code;
  if (epsName !== undefined) upd.eps_name = epsName;
  if (epsAuthorization !== undefined) upd.eps_authorization = epsAuthorization;
  const { error } = await sb.from('patients').update(upd).eq('id', req.params.id);
  if (error) return fail(res, 'Error: ' + error.message);
  if (cityName) await sb.from('altitude_profiles').upsert({ patient_id: req.params.id, city_name: cityName }, { onConflict: 'patient_id' });
  ok(res, null, 'Paciente actualizado');
}));
app.patch('/api/patients/:id/discharge', h(async (req, res) => { await sb.from('patients').update({ is_active: false }).eq('id', req.params.id); ok(res, null, 'Paciente archivado'); }));
app.patch('/api/patients/:id/reactivate', h(async (req, res) => { await sb.from('patients').update({ is_active: true }).eq('id', req.params.id); ok(res, null, 'Paciente reactivado'); }));
app.delete('/api/patients/:id', adminOnly, h(async (req, res) => { await sb.from('patients').delete().eq('id', req.params.id); ok(res, null, 'Paciente eliminado permanentemente'); }));
app.get('/api/patients/:id/daily-history', h(async (req, res) => {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const { data } = await sb.from('clinical_records').select('*, professionals(full_name)').eq('patient_id', req.params.id).gte('created_at', start.toISOString()).order('created_at');
  ok(res, { records: data || [] });
}));

// ---------- CONSENTIMIENTOS (usa tu tabla admission_consents) ----------
app.get('/api/consents', h(async (req, res) => {
  const { data, error } = await sb.from('admission_consents').select('*').order('created_at', { ascending: false });
  if (error) return fail(res, 'BD: ' + error.message, 500);
  ok(res, data || []);
}));
app.post('/api/consents', h(async (req, res) => {
  const { patientId, signedByName, signedById, signedByRelationship, patientSignature, adminSignature } = req.body || {};
  if (!patientId || !signedByName || !signedById) return fail(res, 'Faltan datos del firmante');
  const { data, error } = await sb.from('admission_consents').insert({ patient_id: patientId, is_signed: true, signed_by_name: signedByName, signed_by_id: signedById, signed_by_relationship: signedByRelationship || null, patient_signature: patientSignature || null, admin_signature: adminSignature || null }).select().single();
  if (error) return fail(res, 'Error: ' + error.message);
  ok(res, data, 'Consentimiento de ingreso registrado');
}));

// ---------- DASHBOARD ----------
app.get('/api/dashboard/stats', h(async (req, res) => {
  const { count: patients } = await sb.from('patients').select('id', { count: 'exact', head: true }).eq('is_active', true);
  const { count: professionals } = await sb.from('professionals').select('id', { count: 'exact', head: true }).eq('is_active', true);
  const { count: shPend } = await sb.from('shifts').select('id', { count: 'exact', head: true }).not('end_time', 'is', null).eq('admin_validated', false);
  const { count: noPend } = await sb.from('professional_records').select('id', { count: 'exact', head: true }).eq('admin_validated', false);
  ok(res, { patients: patients || 0, professionals: professionals || 0, pendingReports: (shPend || 0) + (noPend || 0) });
}));

// ---------- 🎯 PLANES DE TRATAMIENTO (join manual — sin depender de FKs) ----------
app.get('/api/treatment-plans', h(async (req, res) => {
  const { data: plans, error } = await sb.from('treatment_plans').select('*').order('created_at', { ascending: false });
  if (error) return fail(res, 'BD: ' + error.message, 500);
  const [{ data: pats }, { data: profs }] = await Promise.all([
    sb.from('patients').select('id, full_name'),
    sb.from('professionals').select('id, full_name')
  ]);
  const pm = Object.fromEntries((pats || []).map(p => [p.id, p.full_name]));
  const fm = Object.fromEntries((profs || []).map(p => [p.id, p.full_name]));
  ok(res, (plans || []).map(p => ({ ...p, patients: { full_name: pm[p.patient_id] || 'N/A' }, professionals: { full_name: fm[p.professional_id] || 'N/A' } })));
}));
app.post('/api/treatment-plans', plansRole, h(async (req, res) => {
  const { patientId, professionalId, specialtyCode, sessionsAuthorized, validUntil, notes } = req.body || {};
  if (!patientId || !specialtyCode || !sessionsAuthorized || sessionsAuthorized < 1) return fail(res, 'Completa: paciente, especialidad y sesiones');
  const { data, error } = await sb.from('treatment_plans').insert({ patient_id: patientId, professional_id: professionalId || null, specialty_code: specialtyCode, sessions_authorized: Number(sessionsAuthorized), valid_until: validUntil || null, notes: notes || null, created_by: req.prof.id, is_active: true, sessions_used: 0 }).select('*').single();
  if (error) return fail(res, 'Error: ' + error.message);
  ok(res, data, 'Plan de tratamiento creado');
}));
app.patch('/api/treatment-plans/:id/deactivate', plansRole, h(async (req, res) => {
  const { error } = await sb.from('treatment_plans').update({ is_active: false }).eq('id', req.params.id);
  if (error) return fail(res, 'Error: ' + error.message);
  ok(res, null, 'Plan desactivado');
}));
app.get('/api/treatment-plans/usage/:planId', h(async (req, res) => {
  const { data: p, error } = await sb.from('treatment_plans').select('sessions_used, sessions_authorized').eq('id', req.params.planId).single();
  if (error || !p) return fail(res, 'Plan no encontrado', 404);
  ok(res, { used: p.sessions_used || 0, authorized: p.sessions_authorized, remaining: Math.max(0, (p.sessions_authorized || 0) - (p.sessions_used || 0)) });
}));

// ---------- TURNOS ----------
const SHIFTSEL = '*, patients(full_name, document_number), professionals(full_name, document_number, professional_card)';
app.post('/api/shifts/start', h(async (req, res) => {
  const { patientId, shiftType, patientStatus, patientNotes, customStartTime } = req.body || {};
  if (!patientId) return fail(res, 'Falta el paciente');
  const { data, error } = await sb.from('shifts').insert({ professional_id: req.prof.id, patient_id: patientId, shift_type: shiftType || 'personalizado', start_time: customStartTime || new Date().toISOString(), patient_received_status: patientStatus || 'estable', patient_received_notes: patientNotes || null }).select(SHIFTSEL).single();
  if (error) return fail(res, 'Error: ' + error.message);
  ok(res, data, 'Turno iniciado');
}));
app.get('/api/shifts/open-check/:profId', h(async (req, res) => {
  const { data } = await sb.from('shifts').select(SHIFTSEL).eq('professional_id', req.params.profId).is('end_time', null).order('start_time', { ascending: false });
  ok(res, data || []);
}));
app.get('/api/shifts/closed', h(async (req, res) => {
  const { data, error } = await sb.from('shifts').select(SHIFTSEL).not('end_time', 'is', null).order('end_time', { ascending: false }).limit(150);
  if (error) return fail(res, 'BD: ' + error.message, 500);
  ok(res, data || []);
}));
app.post('/api/shifts/close', h(async (req, res) => {
  const b = req.body || {};
  if (!b.shiftId) return fail(res, 'Falta el turno');
  const { data: upd, error } = await sb.from('shifts').update({ end_time: new Date().toISOString(), patient_delivered_status: b.patientDeliveredStatus || null, patient_delivered_notes: b.patientDeliveredNotes || null, pending_tasks: b.pendingTasks || null, warnings_ignored: b.warningsIgnored || null }).eq('id', b.shiftId).is('end_time', null).select().single();
  if (error || !upd) return fail(res, 'El turno ya está cerrado o no existe');
  await sb.from('shift_signatures').upsert({ shift_id: b.shiftId, auxiliary_name: b.auxiliaryName || null, auxiliary_id_number: b.auxiliaryIdNumber || null, auxiliary_signature: b.auxiliarySignature || null, family_name: b.familyName || null, family_id_number: b.familyIdNumber || null, family_relationship: b.familyRelationship || null, family_phone: b.familyPhone || null, family_signature: b.familySignature || null, leave_data: b.leaveData || null }, { onConflict: 'shift_id' });
  ok(res, upd, 'Turno cerrado correctamente');
}));
// 🔓 CIERRE EXCEPCIONAL: auxiliar declara + firma → pendiente de aprobación admin
app.post('/api/shifts/:id/exceptional-close', h(async (req, res) => {
  const { reason, whatHappened, signature } = req.body || {};
  if (!reason || reason.length < 10 || !whatHappened || whatHappened.length < 10) return fail(res, 'Completa las dos declaraciones (mínimo 10 caracteres)');
  if (!signature) return fail(res, 'La firma digital es obligatoria');
  const { data: sh } = await sb.from('shifts').select('end_time').eq('id', req.params.id).single();
  if (!sh) return fail(res, 'Turno no encontrado', 404);
  if (sh.end_time) return fail(res, 'Este turno ya está cerrado');
  const ec = { auxName: req.prof.full_name, auxDoc: req.prof.document_number || '', reason, whatHappened, signature, fecha: new Date().toISOString() };
  const { error } = await sb.from('shifts').update({ exceptional_closure: ec, admin_approved_exceptional: false, end_time: new Date().toISOString() }).eq('id', req.params.id);
  if (error) return fail(res, 'Error: ' + error.message);
  ok(res, null, 'Cierre excepcional registrado. Queda pendiente de aprobación de coordinación.');
}));
app.patch('/api/shifts/:id/approve-exceptional', adminOnly, h(async (req, res) => {
  const { data: sh } = await sb.from('shifts').select('exceptional_closure').eq('id', req.params.id).single();
  if (!sh?.exceptional_closure) return fail(res, 'Este turno no tiene cierre excepcional declarado');
  const { error } = await sb.from('shifts').update({ admin_approved_exceptional: true }).eq('id', req.params.id);
  if (error) return fail(res, 'Error: ' + error.message);
  ok(res, null, 'Cierre excepcional APROBADO');
}));
app.get('/api/shifts/:id/closure-data', h(async (req, res) => {
  const { data: shift } = await sb.from('shifts').select(SHIFTSEL).eq('id', req.params.id).single();
  if (!shift) return fail(res, 'Turno no encontrado', 404);
  const { data: records } = await sb.from('clinical_records').select('*').eq('shift_id', req.params.id).order('created_at');
  const { data: signatures } = await sb.from('shift_signatures').select('*').eq('shift_id', req.params.id);
  ok(res, { shift, records: records || [], signatures: signatures || [] });
}));
app.post('/api/shifts/:id/addenda', h(async (req, res) => {
  const { descriptionOmitted, descriptionActual, signature } = req.body || {};
  if (!descriptionOmitted || descriptionOmitted.length < 10 || !descriptionActual || descriptionActual.length < 10) return fail(res, 'Completa las dos descripciones (mínimo 10 caracteres)');
  if (!signature) return fail(res, 'La firma digital es obligatoria');
  const { data: sh } = await sb.from('shifts').select('end_time, closing_addendas').eq('id', req.params.id).single();
  if (!sh) return fail(res, 'Turno no encontrado', 404);
  if (!in24h(sh.end_time)) return fail(res, 'Venció el plazo de 24 horas para addendas');
  const arr = Array.isArray(sh.closing_addendas) ? sh.closing_addendas : [];
  arr.push({ auxName: req.prof.full_name, auxDoc: req.prof.document_number || '', descriptionOmitted, descriptionActual, signature, fecha: new Date().toISOString(), admin_validated: false });
  await sb.from('shifts').update({ closing_addendas: arr }).eq('id', req.params.id);
  ok(res, null, 'Addenda registrada y pendiente de validación');
}));
app.patch('/api/shifts/:id/validate', adminOnly, h(async (req, res) => {
  const { error } = await sb.from('shifts').update({ admin_validated: true }).eq('id', req.params.id);
  if (error) return fail(res, 'Error: ' + error.message);
  ok(res, null, 'Soporte validado');
}));

// ---------- REGISTROS CLÍNICOS ----------
app.post('/api/clinical-records', h(async (req, res) => {
  const b = req.body || {};
  const { data, error } = await sb.from('clinical_records').insert({ shift_id: b.shiftId || null, patient_id: b.patientId, professional_id: req.prof.id, blood_pressure: b.bloodPressure || null, heart_rate: b.heartRate || null, respiratory_rate: b.respiratoryRate || null, temperature: b.temperature || null, spo2: b.spo2 || null, glucose: b.glucose || null, eva_score: b.evaScore ?? 0, glasgow_eyes: b.glasgowEyes || null, glasgow_verbal: b.glasgowVerbal || null, glasgow_motor: b.glasgowMotor || null, braden_score: b.bradenScore || null, activities_completed: b.activitiesCompleted || {}, sbar_situation: b.sbarSituation || null, sbar_background: b.sbarBackground || null, sbar_assessment: b.sbarAssessment || null, sbar_recommendation: b.sbarRecommendation || null, notes: b.notes || null }).select().single();
  if (error) return fail(res, 'Error: ' + error.message);
  ok(res, data, 'Registro clínico guardado');
}));

// ---------- NOTAS DE EVOLUCIÓN (con motor de plan) ----------
const RECSEL = '*, patients(full_name, document_number), professionals(full_name, document_number, professional_card)';
app.post('/api/professional-records', h(async (req, res) => {
  const b = req.body || {};
  const specialty = req.prof.specialties?.name || '';
  let planInfo = null, planWarning = null;
  const { data: pl } = await sb.from('treatment_plans').select('*').eq('patient_id', b.patientId).eq('specialty_code', specialty).eq('is_active', true).order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (pl) {
    const used = pl.sessions_used || 0, authorized = pl.sessions_authorized || 0;
    const outside = used >= authorized;
    planInfo = { planId: pl.id, used, authorized, outside };
    if (outside) {
      planWarning = `⚠️ Sesión FUERA DE PLAN (${used} de ${authorized} usadas). Guardada con marca para revisión de coordinación.`;
      if (b.outsideJustification) planInfo.justificacion = b.outsideJustification;
    }
    await sb.from('treatment_plans').update({ sessions_used: used + 1 }).eq('id', pl.id);
  }
  const vs = { ...(b.vitalSigns || {}) }; if (planInfo) vs.planInfo = planInfo;
  const { data, error } = await sb.from('professional_records').insert({ patient_id: b.patientId, professional_id: req.prof.id, record_type: b.recordType || null, weight: b.weight || null, height: b.height || null, imc: b.imc || null, vital_signs: vs, subjective: b.subjective || null, objective: b.objective || null, analysis: b.analysis || null, plan: b.plan || null, professional_signature: b.professionalSignature || null, family_signature: b.familySignature || null, family_name: b.familyName || null, family_id: b.familyId || null }).select(RECSEL).single();
  if (error) return fail(res, 'Error: ' + error.message);
  ok(res, { ...data, planWarning }, planWarning || 'Nota guardada');
}));
app.get('/api/professional-records/list', h(async (req, res) => {
  const { data, error } = await sb.from('professional_records').select(RECSEL).order('created_at', { ascending: false }).limit(200);
  if (error) return fail(res, 'BD: ' + error.message, 500);
  ok(res, data || []);
}));
app.post('/api/professional-records/:id/addenda', h(async (req, res) => {
  const { descriptionOmitted, descriptionActual, signature } = req.body || {};
  if (!descriptionOmitted || descriptionOmitted.length < 10 || !descriptionActual || descriptionActual.length < 10) return fail(res, 'Completa las dos descripciones (mínimo 10 caracteres)');
  if (!signature) return fail(res, 'La firma digital es obligatoria');
  const { data: rec } = await sb.from('professional_records').select('created_at, addendas').eq('id', req.params.id).single();
  if (!rec) return fail(res, 'Nota no encontrada', 404);
  if (!in24h(rec.created_at)) return fail(res, 'Venció el plazo de 24 horas para addendas');
  const arr = Array.isArray(rec.addendas) ? rec.addendas : [];
  arr.push({ profName: req.prof.full_name, profDoc: req.prof.document_number || '', descriptionOmitted, descriptionActual, signature, fecha: new Date().toISOString(), admin_validated: false });
  await sb.from('professional_records').update({ addendas: arr }).eq('id', req.params.id);
  ok(res, null, 'Addenda registrada y pendiente de validación');
}));
app.patch('/api/professional-records/:id/validate', adminOnly, h(async (req, res) => {
  const { error } = await sb.from('professional_records').update({ admin_validated: true }).eq('id', req.params.id);
  if (error) return fail(res, 'Error: ' + error.message);
  ok(res, null, 'Nota validada');
}));

// ---------- EDUCACIÓN / AGENDA / CHAT (internal_messages) / EVENTOS ----------
app.get('/api/education/topics', h(async (req, res) => { const { data } = await sb.from('education_topics').select('*, professionals(full_name)').order('created_at', { ascending: false }); ok(res, data || []); }));
app.post('/api/education/topics', h(async (req, res) => {
  const { title, description, responsibleId } = req.body || {};
  if (!title) return fail(res, 'Escribe el título');
  const { data, error } = await sb.from('education_topics').insert({ title, description: description || null, responsible_id: responsibleId || null }).select('*, professionals(full_name)').single();
  if (error) return fail(res, 'Error: ' + error.message);
  ok(res, data, 'Tema guardado');
}));
app.get('/api/scheduled-shifts', h(async (req, res) => {
  const { data } = await sb.from('scheduled_shifts').select('*, patients(full_name), professionals(full_name)').order('shift_date', { ascending: false }).limit(200);
  ok(res, data || []);
}));
app.get('/api/scheduled-shifts/professional/:profId', h(async (req, res) => {
  const { data } = await sb.from('scheduled_shifts').select('*, patients(full_name, document_number, altitude_profiles(city_name)), professionals(full_name)').eq('professional_id', req.params.profId).eq('status', 'Programado').order('shift_date');
  ok(res, data || []);
}));
app.post('/api/scheduled-shifts', h(async (req, res) => {
  const { shiftDate, patientId, professionalId, shiftType } = req.body || {};
  if (!shiftDate || !patientId || !professionalId) return fail(res, 'Completa: fecha, paciente y profesional');
  const { data, error } = await sb.from('scheduled_shifts').insert({ shift_date: shiftDate, patient_id: patientId, professional_id: professionalId, shift_type: shiftType || 'personalizado', status: 'Programado' }).select().single();
  if (error) return fail(res, 'Error: ' + error.message);
  ok(res, data, 'Turno publicado');
}));
app.get('/api/messages', h(async (req, res) => {
  const { data, error } = await sb.from('internal_messages').select('*').order('created_at', { ascending: true }).limit(200);
  if (error) return fail(res, 'BD: ' + error.message, 500);
  ok(res, data || []);
}));
app.post('/api/messages', h(async (req, res) => {
  const { senderId, senderName, message, isAlert } = req.body || {};
  if (!message) return fail(res, 'Mensaje vacío');
  const { data, error } = await sb.from('internal_messages').insert({ sender_id: senderId || req.prof.id, sender_name: senderName || req.prof.full_name, message, is_alert: !!isAlert }).select().single();
  if (error) return fail(res, 'Error: ' + error.message);
  ok(res, data, 'Enviado');
}));
app.post('/api/adverse-events', h(async (req, res) => {
  const { patientId, shiftId, eventType, description } = req.body || {};
  const { data, error } = await sb.from('adverse_events').insert({ patient_id: patientId || null, professional_id: req.prof.id, shift_id: shiftId || null, event_type: eventType || 'Otro', description: description || '' }).select().single();
  if (error) return fail(res, 'Error: ' + error.message);
  ok(res, data, 'Evento adverso reportado');
}));

// ---------- FINANZAS (financial_parameters / client_tariffs) ----------
app.get('/api/finance/parameters', h(async (req, res) => ok(res, await getActiveFinance())));
app.patch('/api/finance/parameters/:id', h(async (req, res) => {
  const upd = {}; ['year','smmlv','subsidy_transport','night_surcharge_percentage','holiday_surcharge_percentage'].forEach(k => { if (req.body?.[k] !== undefined) upd[k] = Number(req.body[k]); });
  const { data, error } = await sb.from('financial_parameters').update(upd).eq('id', req.params.id).select().single();
  if (error) return fail(res, 'Error: ' + error.message);
  ok(res, data, 'Parámetros guardados');
}));
app.get('/api/finance/tariffs', h(async (req, res) => ok(res, await getActiveTariffs())));
app.patch('/api/finance/tariffs/:id', h(async (req, res) => {
  const upd = {}; Object.keys(req.body || {}).filter(k => k.startsWith('t_')).forEach(k => upd[k] = Number(req.body[k]) || 0);
  const { data, error } = await sb.from('client_tariffs').update(upd).eq('id', req.params.id).select().single();
  if (error) return fail(res, 'Error: ' + error.message);
  ok(res, data, 'Tarifas guardadas');
}));
app.get('/api/finance/liquidation/:profId/:month/:year', h(async (req, res) => {
  const { from, to } = monthRange(req.params.year, req.params.month);
  const p = await getActiveFinance();
  const hourly = (Number(p.smmlv) || 0) / 240;
  const { data: shifts } = await sb.from('shifts').select('*, patients(full_name)').eq('professional_id', req.params.profId).not('end_time', 'is', null).gte('start_time', from).lt('start_time', to);
  const rows = (shifts || []).map(s => {
    const st = new Date(s.start_time), en = new Date(s.end_time);
    const hours = Math.max(0, (en - st) / 3600000);
    const base = hours * hourly;
    const nb = nightHours(st, en) * hourly * ((Number(p.night_surcharge_percentage) || 35) / 100);
    const sbn = sundayHours(st, en) * hourly * ((Number(p.holiday_surcharge_percentage) || 75) / 100);
    return { date: s.start_time.slice(0, 10), patient: s.patients?.full_name || '-', shift_type: s.shift_type || '-', hours: Math.round(hours * 100) / 100, base_pay: Math.round(base), night_bonus: Math.round(nb), sunday_bonus: Math.round(sbn), total: Math.round(base + nb + sbn) };
  });
  const subsidy = rows.length ? (Number(p.subsidy_transport) || 0) : 0;
  ok(res, { shifts: rows, subsidyApplied: subsidy, totalAmount: rows.reduce((a, r) => a + r.total, 0) + subsidy });
}));
app.get('/api/finance/liquidation-visits/:profId/:month/:year', h(async (req, res) => {
  const { from, to } = monthRange(req.params.year, req.params.month);
  const { data: prof } = await sb.from('professionals').select('full_name, visit_fee, specialties(name)').eq('id', req.params.profId).single();
  if (!prof) return fail(res, 'Profesional no encontrado', 404);
  const fee = Number(prof.visit_fee) || 0;
  const { data: recs } = await sb.from('professional_records').select('created_at, record_type, admin_validated, patients(full_name)').eq('professional_id', req.params.profId).gte('created_at', from).lt('created_at', to);
  const valids = (recs || []).filter(r => r.admin_validated);
  ok(res, { professional: { full_name: prof.full_name, specialty: prof.specialties?.name || '-', fee }, visits: valids.map(r => ({ date: r.created_at.slice(0, 10), patient: r.patients?.full_name || '-', record_type: r.record_type || '-', amount: fee })), totalAmount: fee * valids.length, totalValidated: valids.length, totalPending: (recs || []).length - valids.length });
}));
app.get('/api/finance/invoice/:patId/:month/:year', h(async (req, res) => {
  const { from, to } = monthRange(req.params.year, req.params.month);
  const { data: pat } = await sb.from('patients').select('full_name').eq('id', req.params.patId).single();
  const t = await getActiveTariffs();
  const { data: shifts } = await sb.from('shifts').select('*, professionals(full_name)').eq('patient_id', req.params.patId).not('end_time', 'is', null).gte('start_time', from).lt('start_time', to);
  const KEYS = ['6h_diurno','6h_nocturno','8h_diurno','8h_nocturno','12h_diurno','12h_nocturno','24h'];
  const details = (shifts || []).map(s => {
    let amount = 0;
    if (KEYS.includes(s.shift_type)) amount = Number(t['t_' + s.shift_type]) || 0;
    else { const hrs = Math.max(0, (new Date(s.end_time) - new Date(s.start_time)) / 3600000); amount = Math.round(hrs * ((Number(t.t_24h) || 0) / 24)); }
    return { date: s.start_time.slice(0, 10), service: s.shift_type || '-', auxiliaries: s.professionals?.full_name || 'Equipo Vital Hogar', amount };
  });
  ok(res, { patient: pat || {}, details, totalAmount: details.reduce((a, d) => a + d.amount, 0) });
}));
app.get('/api/reports/:patId/:month/:year', h(async (req, res) => {
  const { from, to } = monthRange(req.params.year, req.params.month);
  const { data: patient } = await sb.from('patients').select('*, altitude_profiles(city_name)').eq('id', req.params.patId).single();
  if (!patient) return fail(res, 'Paciente no encontrado', 404);
  const { data: records } = await sb.from('clinical_records').select('*, professionals(full_name)').eq('patient_id', req.params.patId).gte('created_at', from).lt('created_at', to).order('created_at');
  const { data: profRecords } = await sb.from('professional_records').select('*, professionals(full_name)').eq('patient_id', req.params.patId).gte('created_at', from).lt('created_at', to).order('created_at');
  ok(res, { patient, records: records || [], profRecords: profRecords || [] });
}));

app.use((req, res) => fail(res, 'Ruta no encontrada: ' + req.method + ' ' + req.path, 404));
app.listen(PORT, () => console.log(`✅ Vital Hogar Pro API en http://localhost:${PORT}`));
