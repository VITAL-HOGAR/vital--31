// ============================================================
// VITAL HOGAR PRO — API v3.1 (Vercel serverless)
// CORREGIDO v3.1: endpoints de lectura del módulo de dinero
// ahora extraen .data correctamente (antes enviaban el objeto
// completo de Supabase y el index quedaba en "Cargando...").
// Motor de pagos por evento validado (tabla oficial congelada),
// libro de pagos, liquidación por prestador, rentabilidad con ARL,
// gestión de tarifas, control ARL prestadores, perfil ACOMPANANTE.
// Terminología legal: EVENTOS (coherente con contratos).
// ============================================================
import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY, JWT_SECRET, PORT = 3000 } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !JWT_SECRET) { console.error('Faltan variables'); process.exit(1); }

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
const monthRange = (y, m) => { const from = new Date(`${y}-${m}-01T00:00:00-05:00`); const nm = Number(m) === 12 ? 1 : Number(m) + 1; const ny = Number(m) === 12 ? Number(y) + 1 : y; const mm = String(nm).padStart(2, '0'); const to = new Date(`${ny}-${mm}-01T00:00:00-05:00`); return { from: from.toISOString(), to: to.toISOString() }; };
const in24h = (iso) => iso && (Date.now() - new Date(iso).getTime()) <= 24 * 3600 * 1000;
const CO_OFFSET = 5 * 3600000;
const colombiaDate = (d) => new Date(d.getTime() - CO_OFFSET);

// Lector seguro de tablas (extrae data, reporta error — el fix del "Cargando...")
async function fetchAll(table, select = '*') {
  const { data, error } = await sb.from(table).select(select);
  if (error) throw new Error(`BD (${table}): ${error.message}`);
  return data || [];
}

// Claves de tarifa/precio según evento, prestador y día
function resolveRateKeyBase(shiftType, providerType, isDomFest) {
  if (providerType === 'ACOMPANANTE') {
    if (isDomFest) return 'acomp_dom_fest';
    if (String(shiftType).includes('nocturno') || shiftType === '24h') return 'acomp_12h_nocturno';
    return 'acomp_12h_diurno';
  }
  if (isDomFest) return 'dom_fest_12h';
  const st = String(shiftType);
  if (st.includes('6h')) return '6h_diurno';
  if (st.includes('8h')) return '8h_diurno';
  if (st.includes('nocturno')) return '12h_nocturno';
  return '12h_diurno';
}
function resolveClientKey(shiftType, providerType, isDomFest) {
  if (providerType === 'ACOMPANANTE') {
    if (isDomFest) return 'acomp_dom_fest';
    if (String(shiftType).includes('nocturno') || shiftType === '24h') return 'acomp_12h_nocturno';
    return 'acomp_12h_diurno';
  }
  if (isDomFest) return String(shiftType).includes('nocturno') ? 'dom_fest_12h_n' : 'dom_fest_12h_d';
  const st = String(shiftType);
  if (st.includes('6h')) return '6h_diurno';
  if (st.includes('8h')) return '8h_diurno';
  if (st.includes('nocturno')) return '12h_nocturno';
  return '12h_diurno';
}

async function getHolidaysSet() {
  try { const rows = await fetchAll('holidays', 'date'); return new Set(rows.map(x => x.date)); } catch { return new Set(); }
}
function isHolidayOrSunday(dateIso, holidaySet) {
  const d = colombiaDate(new Date(dateIso));
  const iso = d.toISOString().slice(0, 10);
  return d.getDay() === 0 || holidaySet.has(iso);
}

async function getProviderRates() {
  const rows = await fetchAll('provider_rates');
  return Object.fromEntries(rows.map(r => [r.event_type, Number(r.rate)]));
}
async function getClientEventPrices() {
  const rows = await fetchAll('client_event_prices');
  return Object.fromEntries(rows.map(r => [r.event_type, Number(r.price)]));
}
async function getCupsMap() {
  const rows = await fetchAll('cups_tariffs');
  return Object.fromEntries(rows.map(c => [c.specialty_code, Number(c.price) || 0]));
}
async function getMoneySettings() {
  const { data } = await sb.from('money_settings').select('*').eq('id', 1).maybeSingle();
  return data || { arl_monthly: 30000, ops_monthly_per_client: 60000, availability_stipend: 150000, stipend_active: false };
}
async function getCompany() {
  const { data } = await sb.from('company_profile').select('*').eq('id', 1).maybeSingle();
  return data || { responsible_name: 'Vital Hogar Pro', doc_type: 'CC', doc_number: '', address: '', phone: '', email: '', city: 'Cúcuta', tax_regime: 'No responsable de IVA' };
}
async function getFinanceLegacy() {
  let { data } = await sb.from('financial_parameters').select('*').eq('is_active', true).order('created_at', { ascending: false }).limit(1);
  if (data && data.length) return data[0];
  const { data: c } = await sb.from('financial_parameters').insert({ year: 2026, smmlv: 1750905, subsidy_transport: 249095, night_surcharge_percentage: 35, holiday_surcharge_percentage: 75, is_active: true }).select().single();
  return c;
}
async function getActiveTariffs() {
  let { data } = await sb.from('client_tariffs').select('*').eq('is_active', true).order('created_at', { ascending: false }).limit(1);
  if (data && data.length) return data[0];
  const { data: c } = await sb.from('client_tariffs').insert({ t_6h_diurno: 95000, t_6h_nocturno: 115000, t_8h_diurno: 115000, t_8h_nocturno: 135000, t_12h_diurno: 135000, t_12h_nocturno: 150000, t_24h: 430000, is_active: true }).select().single();
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

const AUTH_KEY = SUPABASE_ANON_KEY || SUPABASE_SERVICE_ROLE_KEY;
async function authSignIn(email, password) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: AUTH_KEY, Authorization: `Bearer ${AUTH_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const d = await r.json().catch(() => ({}));
  if (r.ok && d.user) return { ok: true, user: d.user };
  return { ok: false, error: d.error_description || d.msg || d.error || 'Credenciales inválidas' };
}
async function findProfAfterAuth(authUser) {
  const email = (authUser.email || '').toLowerCase();
  let { data: p } = await sb.from('professionals').select(PROFASEL).eq('auth_user_id', authUser.id).maybeSingle();
  if (p) return p;
  const { data: u } = await sb.from('users').select('id').ilike('email', email).maybeSingle();
  if (!u) return null;
  ({ data: p } = await sb.from('professionals').select(PROFASEL).eq('user_id', u.id).maybeSingle());
  return p;
}
async function getAuthUserId(prof) {
  if (prof.auth_user_id) return prof.auth_user_id;
  if (!prof.user_id) return null;
  const { data: u } = await sb.from('users').select('email').eq('id', prof.user_id).maybeSingle();
  if (!u?.email) return null;
  const { data: { users } } = await sb.auth.admin.listUsers({ perPage: 1000 });
  const found = (users || []).find(x => (x.email || '').toLowerCase() === u.email.toLowerCase());
  if (found) await sb.from('professionals').update({ auth_user_id: found.id }).eq('id', prof.id);
  return found?.id || null;
}

// ---------- LOGIN ----------
app.post('/api/auth/login', h(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!email || !password) return fail(res, 'Complete todos los campos');
  const auth = await authSignIn(email, password);
  if (!auth.ok) return fail(res, 'Credenciales inválidas', 401);
  const prof = await findProfAfterAuth(auth.user);
  if (!prof) return fail(res, 'Usuario sin perfil de profesional. Contacta al administrador.', 403);
  if (prof.is_active === false) return fail(res, 'Usuario archivado.', 403);
  if (!prof.auth_user_id) await sb.from('professionals').update({ auth_user_id: auth.user.id }).eq('id', prof.id);
  const token = jwt.sign({ id: prof.id, email }, JWT_SECRET, { expiresIn: '12h' });
  const user = { id: prof.id, full_name: prof.full_name, email, document_number: prof.document_number, professional_card: prof.professional_card, specialty_name: prof.specialties?.name, specialties: prof.specialties };
  ok(res, { token, user }, 'Bienvenido');
}));

app.use('/api', authMiddleware);

// ---------- PRESTADORES ----------
app.get('/api/professionals', h(async (req, res) => {
  const { data, error } = await sb.from('professionals').select(PROFASEL).order('full_name');
  if (error) return fail(res, 'BD: ' + error.message, 500);
  ok(res, data || []);
}));
app.post('/api/professionals', adminOnly, h(async (req, res) => {
  const { fullName, documentNumber, professionalCard, email, password, specialtyName, visitFee, arlActiveUntil } = req.body || {};
  if (!fullName || !documentNumber || !email || !password || !professionalCard) return fail(res, 'Completa: nombre, cédula, tarjeta, correo y contraseña');
  const em = String(email).trim().toLowerCase();
  const { data: spec } = await sb.from('specialties').select('id').eq('name', specialtyName).single();
  if (!spec) return fail(res, 'Especialidad inválida');
  const { data: au, error: auErr } = await sb.auth.admin.createUser({ email: em, password, email_confirm: true });
  if (auErr) return fail(res, 'No se pudo crear el acceso: ' + auErr.message);
  const { data: tpl } = await sb.from('users').select('role, status').limit(1).maybeSingle();
  const userRow = { name: fullName, email: em, cedula: documentNumber, rethus: professionalCard };
  if (tpl) { userRow.role = tpl.role; userRow.status = tpl.status; }
  const { data: uRow, error: uErr } = await sb.from('users').insert(userRow).select('id').single();
  if (uErr) { try { await sb.auth.admin.deleteUser(au.user.id); } catch {} return fail(res, 'No se pudo crear el perfil: ' + uErr.message); }
  const { data: created, error } = await sb.from('professionals').insert({ full_name: fullName, document_number: documentNumber, professional_card: professionalCard, user_id: uRow.id, auth_user_id: au.user.id, specialty_id: spec.id, visit_fee: visitFee ? Number(visitFee) : 0, arl_active_until: arlActiveUntil || null }).select(PROFASEL).single();
  if (error) return fail(res, 'Error guardando: ' + error.message);
  ok(res, created, 'Prestador creado con acceso');
}));
app.patch('/api/professionals/:id', adminOnly, h(async (req, res) => {
  const { fullName, documentNumber, professionalCard, specialtyName, newPassword, visitFee, arlActiveUntil } = req.body || {};
  const upd = {};
  if (fullName) upd.full_name = fullName;
  if (documentNumber) upd.document_number = documentNumber;
  if (professionalCard) upd.professional_card = professionalCard;
  if (visitFee !== undefined && visitFee !== null && visitFee !== '') upd.visit_fee = Number(visitFee) || 0;
  if (arlActiveUntil !== undefined) upd.arl_active_until = arlActiveUntil || null;
  if (specialtyName) { const { data: spec } = await sb.from('specialties').select('id').eq('name', specialtyName).single(); if (!spec) return fail(res, 'Especialidad inválida'); upd.specialty_id = spec.id; }
  const { data: prof, error } = await sb.from('professionals').update(upd).eq('id', req.params.id).select(PROFASEL).single();
  if (error) return fail(res, 'Error actualizando: ' + error.message);
  if (newPassword) {
    const authId = await getAuthUserId(prof);
    if (!authId) return fail(res, 'No encontré la cuenta de acceso');
    const { error: pErr } = await sb.auth.admin.updateUserById(authId, { password: newPassword });
    if (pErr) return fail(res, 'Perfil actualizado, pero la contraseña falló: ' + pErr.message);
  }
  ok(res, prof, 'Prestador actualizado' + (newPassword ? ' (contraseña incluida)' : ''));
}));
app.patch('/api/professionals/:id/deactivate', adminOnly, h(async (req, res) => {
  const active = req.body?.isActive !== false;
  await sb.from('professionals').update({ is_active: active }).eq('id', req.params.id);
  ok(res, null, active ? 'Prestador reactivado' : 'Prestador archivado');
}));
app.delete('/api/professionals/:id', adminOnly, h(async (req, res) => {
  const { data: prof } = await sb.from('professionals').select('user_id, auth_user_id').eq('id', req.params.id).single();
  const { error } = await sb.from('professionals').delete().eq('id', req.params.id);
  if (error) return fail(res, 'No se pudo eliminar: ' + error.message);
  if (prof?.user_id) { try { await sb.from('users').delete().eq('id', prof.user_id); } catch {} }
  if (prof?.auth_user_id) { try { await sb.auth.admin.deleteUser(prof.auth_user_id); } catch {} }
  ok(res, null, 'Prestador eliminado permanentemente');
}));
app.patch('/api/professionals/:id/change-email', adminOnly, h(async (req, res) => {
  const e = String(req.body?.newEmail || '').trim().toLowerCase();
  const e2 = String(req.body?.newEmailConfirm || '').trim().toLowerCase();
  if (!e || !e2) return fail(res, 'Escribe el correo nuevo en ambos campos');
  if (e !== e2) return fail(res, 'Los correos no coinciden');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return fail(res, 'Correo inválido');
  const { data: prof } = await sb.from('professionals').select('id, full_name, auth_user_id, user_id').eq('id', req.params.id).single();
  if (!prof) return fail(res, 'Prestador no encontrado', 404);
  const authId = await getAuthUserId(prof);
  if (authId) { const { error: auErr } = await sb.auth.admin.updateUserById(authId, { email: e, email_confirm: true }); if (auErr) return fail(res, 'No se pudo actualizar el acceso: ' + auErr.message); }
  await sb.from('users').update({ email: e }).eq('id', prof.user_id);
  try { await sb.from('email_changes').insert({ correo_nuevo: e, confirmado_1: true, confirmado_2: true, realizado_por: req.prof.id, notificado: true }); } catch {}
  ok(res, null, `Correo de ${prof.full_name} actualizado a ${e}. Notifica al usuario.`);
}));

// ---------- PACIENTES ----------
const PATSEL = '*, altitude_profiles(city_name)';
app.get('/api/patients', h(async (req, res) => { const { data } = await sb.from('patients').select(PATSEL).order('full_name'); ok(res, data || []); }));
app.post('/api/patients', h(async (req, res) => {
  const b = req.body || {};
  if (!b.fullName || !b.documentNumber) return fail(res, 'Completa: nombre y número de documento');
  const { data: pat, error } = await sb.from('patients').insert({
    full_name: b.fullName, document_number: b.documentNumber,
    document_type: b.documentType || 'CC', birth_date: b.birthDate || null, sex: b.sex || null,
    address: b.address || null, neighborhood: b.neighborhood || null, housing_type: b.housingType || null,
    arrival_references: b.arrivalReferences || null, access_notes: b.accessNotes || null, pets: b.pets || null,
    family_name: b.familyName || null, contact_phone: b.contactPhone || null, family_email: b.familyEmail || null,
    emergency_name: b.emergencyName || null, emergency_phone: b.emergencyPhone || null,
    cie_10_code: b.cie10Code || null, eps_name: b.epsName || null, eps_authorization: b.epsAuthorization || null
  }).select(PATSEL).single();
  if (error) return fail(res, 'Error: ' + error.message);
  if (b.cityName) await sb.from('altitude_profiles').insert({ patient_id: pat.id, city_name: b.cityName });
  ok(res, pat, 'Paciente creado');
}));
app.patch('/api/patients/:id', h(async (req, res) => {
  const b = req.body || {};
  const upd = {};
  if (b.fullName) upd.full_name = b.fullName;
  if (b.documentNumber) upd.document_number = b.documentNumber;
  if (b.documentType !== undefined) upd.document_type = b.documentType;
  if (b.birthDate !== undefined) upd.birth_date = b.birthDate || null;
  if (b.sex !== undefined) upd.sex = b.sex;
  if (b.address !== undefined) upd.address = b.address;
  if (b.neighborhood !== undefined) upd.neighborhood = b.neighborhood;
  if (b.housingType !== undefined) upd.housing_type = b.housingType;
  if (b.arrivalReferences !== undefined) upd.arrival_references = b.arrivalReferences;
  if (b.accessNotes !== undefined) upd.access_notes = b.accessNotes;
  if (b.pets !== undefined) upd.pets = b.pets;
  if (b.familyName !== undefined) upd.family_name = b.familyName;
  if (b.contactPhone !== undefined) upd.contact_phone = b.contactPhone;
  if (b.familyEmail !== undefined) upd.family_email = b.familyEmail;
  if (b.emergencyName !== undefined) upd.emergency_name = b.emergencyName;
  if (b.emergencyPhone !== undefined) upd.emergency_phone = b.emergencyPhone;
  if (b.cie10Code !== undefined) upd.cie_10_code = b.cie10Code;
  if (b.epsName !== undefined) upd.eps_name = b.epsName;
  if (b.epsAuthorization !== undefined) upd.eps_authorization = b.epsAuthorization;
  const { error } = await sb.from('patients').update(upd).eq('id', req.params.id);
  if (error) return fail(res, 'Error: ' + error.message);
  if (b.cityName) await sb.from('altitude_profiles').upsert({ patient_id: req.params.id, city_name: b.cityName }, { onConflict: 'patient_id' });
  ok(res, null, 'Paciente actualizado');
}));
app.patch('/api/patients/:id/discharge', h(async (req, res) => { await sb.from('patients').update({ is_active: false }).eq('id', req.params.id); ok(res, null, 'Paciente archivado'); }));
app.patch('/api/patients/:id/reactivate', h(async (req, res) => { await sb.from('patients').update({ is_active: true }).eq('id', req.params.id); ok(res, null, 'Paciente reactivado'); }));
app.delete('/api/patients/:id', adminOnly, h(async (req, res) => { await sb.from('patients').delete().eq('id', req.params.id); ok(res, null, 'Paciente eliminado'); }));
app.get('/api/patients/:id/daily-history', h(async (req, res) => {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const { data } = await sb.from('clinical_records').select('*, professionals(full_name)').eq('patient_id', req.params.id).gte('created_at', start.toISOString()).order('created_at');
  ok(res, { records: data || [] });
}));

// ---------- CONSENTIMIENTOS ----------
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
  ok(res, data, 'Consentimiento registrado');
}));

// ---------- DASHBOARD ----------
app.get('/api/dashboard/stats', h(async (req, res) => {
  const { count: patients } = await sb.from('patients').select('id', { count: 'exact', head: true }).eq('is_active', true);
  const { count: professionals } = await sb.from('professionals').select('id', { count: 'exact', head: true }).eq('is_active', true);
  const { count: shPend } = await sb.from('shifts').select('id', { count: 'exact', head: true }).not('end_time', 'is', null).eq('admin_validated', false);
  const { count: noPend } = await sb.from('professional_records').select('id', { count: 'exact', head: true }).eq('admin_validated', false);
  ok(res, { patients: patients || 0, professionals: professionals || 0, pendingReports: (shPend || 0) + (noPend || 0) });
}));

// ---------- PLANES DE TRATAMIENTO ----------
app.get('/api/treatment-plans', h(async (req, res) => {
  const { data: plans, error } = await sb.from('treatment_plans').select('*').order('created_at', { ascending: false });
  if (error) return fail(res, 'BD: ' + error.message, 500);
  const [{ data: pats }, { data: profs }] = await Promise.all([sb.from('patients').select('id, full_name'), sb.from('professionals').select('id, full_name')]);
  const pm = Object.fromEntries((pats || []).map(p => [p.id, p.full_name]));
  const fm = Object.fromEntries((profs || []).map(p => [p.id, p.full_name]));
  ok(res, (plans || []).map(p => ({ ...p, patients: { full_name: pm[p.patient_id] || 'N/A' }, professionals: { full_name: fm[p.professional_id] || 'N/A' } })));
}));
app.post('/api/treatment-plans', plansRole, h(async (req, res) => {
  const { patientId, professionalId, specialtyCode, sessionsAuthorized, validUntil, notes } = req.body || {};
  if (!patientId || !specialtyCode || !sessionsAuthorized || sessionsAuthorized < 1) return fail(res, 'Completa: paciente, especialidad y sesiones');
  const { data, error } = await sb.from('treatment_plans').insert({ patient_id: patientId, professional_id: professionalId || null, specialty_code: specialtyCode, sessions_authorized: Number(sessionsAuthorized), valid_until: validUntil || null, notes: notes || null, created_by: req.prof.id, is_active: true, sessions_used: 0 }).select('*').single();
  if (error) return fail(res, 'Error: ' + error.message);
  ok(res, data, 'Plan creado');
}));
app.patch('/api/treatment-plans/:id/deactivate', plansRole, h(async (req, res) => { await sb.from('treatment_plans').update({ is_active: false }).eq('id', req.params.id); ok(res, null, 'Plan desactivado'); }));
app.get('/api/treatment-plans/usage/:planId', h(async (req, res) => {
  const { data: p, error } = await sb.from('treatment_plans').select('sessions_used, sessions_authorized').eq('id', req.params.planId).single();
  if (error || !p) return fail(res, 'Plan no encontrado', 404);
  ok(res, { used: p.sessions_used || 0, authorized: p.sessions_authorized, remaining: Math.max(0, (p.sessions_authorized || 0) - (p.sessions_used || 0)) });
}));

// ---------- EVENTOS + MOTOR DE PAGOS ----------
const SHIFTSEL = '*, patients(full_name, document_number), professionals(full_name, document_number, professional_card, arl_active_until)';
app.post('/api/shifts/start', h(async (req, res) => {
  const { patientId, shiftType, patientStatus, patientNotes, customStartTime } = req.body || {};
  if (!patientId) return fail(res, 'Falta el paciente');
  let arlWarning = null;
  if (req.prof.arl_active_until && new Date(req.prof.arl_active_until) < new Date()) {
    arlWarning = '⚠️ ARL VENCIDA del prestador. Regulariza antes de pagar este evento.';
  }
  const { data, error } = await sb.from('shifts').insert({ professional_id: req.prof.id, patient_id: patientId, shift_type: shiftType || 'personalizado', start_time: customStartTime || new Date().toISOString(), patient_received_status: patientStatus || 'estable', patient_received_notes: patientNotes || null }).select(SHIFTSEL).single();
  if (error) return fail(res, 'Error: ' + error.message);
  ok(res, { ...data, arlWarning }, arlWarning || 'Evento iniciado');
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
  if (!b.shiftId) return fail(res, 'Falta el evento');
  const { data: upd, error } = await sb.from('shifts').update({ end_time: new Date().toISOString(), patient_delivered_status: b.patientDeliveredStatus || null, patient_delivered_notes: b.patientDeliveredNotes || null, pending_tasks: b.pendingTasks || null, warnings_ignored: b.warningsIgnored || null }).eq('id', b.shiftId).is('end_time', null).select().single();
  if (error || !upd) return fail(res, 'El evento ya está cerrado o no existe');
  await sb.from('shift_signatures').upsert({ shift_id: b.shiftId, auxiliary_name: b.auxiliaryName || null, auxiliary_id_number: b.auxiliaryIdNumber || null, auxiliary_signature: b.auxiliarySignature || null, family_name: b.familyName || null, family_id_number: b.familyIdNumber || null, family_relationship: b.familyRelationship || null, family_phone: b.familyPhone || null, family_signature: b.familySignature || null, leave_data: b.leaveData || null }, { onConflict: 'shift_id' });
  ok(res, upd, 'Evento entregado correctamente');
}));
app.post('/api/shifts/:id/exceptional-close', h(async (req, res) => {
  const { reason, whatHappened, signature } = req.body || {};
  if (!reason || reason.length < 10 || !whatHappened || whatHappened.length < 10) return fail(res, 'Completa las dos declaraciones (mínimo 10 caracteres)');
  if (!signature) return fail(res, 'La firma digital es obligatoria');
  const { data: sh } = await sb.from('shifts').select('end_time').eq('id', req.params.id).single();
  if (!sh) return fail(res, 'Evento no encontrado', 404);
  if (sh.end_time) return fail(res, 'Este evento ya está cerrado');
  const ec = { auxName: req.prof.full_name, auxDoc: req.prof.document_number || '', reason, whatHappened, signature, fecha: new Date().toISOString() };
  await sb.from('shifts').update({ exceptional_closure: ec, admin_approved_exceptional: false, end_time: new Date().toISOString() }).eq('id', req.params.id);
  ok(res, null, 'Cierre excepcional registrado. Pendiente de aprobación.');
}));
app.patch('/api/shifts/:id/approve-exceptional', adminOnly, h(async (req, res) => {
  const { data: sh } = await sb.from('shifts').select('exceptional_closure').eq('id', req.params.id).single();
  if (!sh?.exceptional_closure) return fail(res, 'Este evento no tiene cierre excepcional');
  await sb.from('shifts').update({ admin_approved_exceptional: true }).eq('id', req.params.id);
  ok(res, null, 'Cierre excepcional APROBADO');
}));
app.get('/api/shifts/:id/closure-data', h(async (req, res) => {
  const { data: shift } = await sb.from('shifts').select(SHIFTSEL).eq('id', req.params.id).single();
  if (!shift) return fail(res, 'Evento no encontrado', 404);
  const { data: records } = await sb.from('clinical_records').select('*').eq('shift_id', req.params.id).order('created_at');
  const { data: signatures } = await sb.from('shift_signatures').select('*').eq('shift_id', req.params.id);
  ok(res, { shift, records: records || [], signatures: signatures || [] });
}));
app.post('/api/shifts/:id/addenda', h(async (req, res) => {
  const { descriptionOmitted, descriptionActual, signature } = req.body || {};
  if (!descriptionOmitted || descriptionOmitted.length < 10 || !descriptionActual || descriptionActual.length < 10) return fail(res, 'Completa las dos descripciones');
  if (!signature) return fail(res, 'La firma digital es obligatoria');
  const { data: sh } = await sb.from('shifts').select('end_time, closing_addendas').eq('id', req.params.id).single();
  if (!sh) return fail(res, 'Evento no encontrado', 404);
  if (!in24h(sh.end_time)) return fail(res, 'Venció el plazo de 24 horas');
  const arr = Array.isArray(sh.closing_addendas) ? sh.closing_addendas : [];
  arr.push({ auxName: req.prof.full_name, auxDoc: req.prof.document_number || '', descriptionOmitted, descriptionActual, signature, fecha: new Date().toISOString(), admin_validated: false });
  await sb.from('shifts').update({ closing_addendas: arr }).eq('id', req.params.id);
  ok(res, null, 'Addenda registrada');
}));

// ⭐ VALIDAR EVENTO = genera el pago al prestador automáticamente
app.patch('/api/shifts/:id/validate', adminOnly, h(async (req, res) => {
  const { data: shift } = await sb.from('shifts').select('*, professionals(id, full_name, specialty_id, arl_active_until), patients(id, full_name)').eq('id', req.params.id).single();
  if (!shift) return fail(res, 'Evento no encontrado', 404);
  if (shift.admin_validated) return fail(res, 'Este evento ya está validado');
  if (shift.exceptional_closure && !shift.admin_approved_exceptional) return fail(res, 'Aprueba primero el cierre excepcional');
  const { data: spec } = await sb.from('specialties').select('name').eq('id', shift.professionals?.specialty_id).single();
  const providerType = spec?.name === 'ACOMPANANTE' ? 'ACOMPANANTE' : 'AUXILIAR';
  const holidaySet = await getHolidaysSet();
  const isDomFest = isHolidayOrSunday(shift.start_time, holidaySet);
  const rateKey = resolveRateKeyBase(shift.shift_type, providerType, isDomFest);
  const clientKey = resolveClientKey(shift.shift_type, providerType, isDomFest);
  const rates = await getProviderRates();
  const amount = rates[rateKey] || 0;
  const prices = await getClientEventPrices();
  const clientPrice = prices[clientKey] || 0;
  await sb.from('shifts').update({ admin_validated: true }).eq('id', req.params.id);
  await sb.from('event_payments').insert({ event_id: shift.id, provider_id: shift.professional_id, event_type: rateKey, provider_type: providerType, amount, client_price: clientPrice, validated_by: req.prof.id, validated_at: new Date().toISOString() });
  const arlExpired = shift.professionals?.arl_active_until && new Date(shift.professionals.arl_active_until) < new Date();
  ok(res, { providerType, rateKey, amount, clientPrice, arlExpired }, `Evento validado — pago al prestador: $${amount.toLocaleString('es-CO')}${arlExpired ? ' — ⚠️ ARL VENCIDA' : ''}`);
}));

// ---------- REGISTROS CLÍNICOS ----------
app.post('/api/clinical-records', h(async (req, res) => {
  const b = req.body || {};
  const { data, error } = await sb.from('clinical_records').insert({ shift_id: b.shiftId || null, patient_id: b.patientId, professional_id: req.prof.id, blood_pressure: b.bloodPressure || null, heart_rate: b.heartRate || null, respiratory_rate: b.respiratoryRate || null, temperature: b.temperature || null, spo2: b.spo2 || null, glucose: b.glucose || null, eva_score: b.evaScore ?? 0, glasgow_eyes: b.glasgowEyes || null, glasgow_verbal: b.glasgowVerbal || null, glasgow_motor: b.glasgowMotor || null, braden_score: b.bradenScore || null, activities_completed: b.activitiesCompleted || {}, sbar_situation: b.sbarSituation || null, sbar_background: b.sbarBackground || null, sbar_assessment: b.sbarAssessment || null, sbar_recommendation: b.sbarRecommendation || null, notes: b.notes || null }).select().single();
  if (error) return fail(res, 'Error: ' + error.message);
  ok(res, data, 'Registro guardado');
}));

// ---------- NOTAS DE EVOLUCIÓN ----------
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
    if (outside) { planWarning = `⚠️ Sesión FUERA DE PLAN (${used} de ${authorized}). Guardada con marca para revisión.`; if (b.outsideJustification) planInfo.justificacion = b.outsideJustification; }
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
  if (!descriptionOmitted || descriptionOmitted.length < 10 || !descriptionActual || descriptionActual.length < 10) return fail(res, 'Completa las dos descripciones');
  if (!signature) return fail(res, 'La firma digital es obligatoria');
  const { data: rec } = await sb.from('professional_records').select('created_at, addendas').eq('id', req.params.id).single();
  if (!rec) return fail(res, 'Nota no encontrada', 404);
  if (!in24h(rec.created_at)) return fail(res, 'Venció el plazo de 24 horas');
  const arr = Array.isArray(rec.addendas) ? rec.addendas : [];
  arr.push({ profName: req.prof.full_name, profDoc: req.prof.document_number || '', descriptionOmitted, descriptionActual, signature, fecha: new Date().toISOString(), admin_validated: false });
  await sb.from('professional_records').update({ addendas: arr }).eq('id', req.params.id);
  ok(res, null, 'Addenda registrada');
}));
app.patch('/api/professional-records/:id/validate', adminOnly, h(async (req, res) => {
  await sb.from('professional_records').update({ admin_validated: true }).eq('id', req.params.id);
  ok(res, null, 'Nota validada');
}));

// ---------- EDUCACIÓN / AGENDA / CHAT / EVENTOS ADVERSOS ----------
app.get('/api/education/topics', h(async (req, res) => { const { data, error } = await sb.from('education_topics').select('*, professionals(full_name)').order('created_at', { ascending: false }); if (error) return fail(res, 'BD: ' + error.message, 500); ok(res, data || []); }));
app.post('/api/education/topics', h(async (req, res) => {
  const { title, description, responsibleId } = req.body || {};
  if (!title) return fail(res, 'Escribe el título');
  const { data, error } = await sb.from('education_topics').insert({ title, description: description || null, responsible_id: responsibleId || null }).select('*, professionals(full_name)').single();
  if (error) return fail(res, 'Error: ' + error.message);
  ok(res, data, 'Tema guardado');
}));
app.get('/api/scheduled-shifts', h(async (req, res) => {
  const { data, error } = await sb.from('scheduled_shifts').select('*, patients(full_name), professionals(full_name)').order('shift_date', { ascending: false }).limit(200);
  if (error) return fail(res, 'BD: ' + error.message, 500);
  ok(res, data || []);
}));
app.get('/api/scheduled-shifts/professional/:profId', h(async (req, res) => {
  const { data, error } = await sb.from('scheduled_shifts').select('*, patients(full_name, document_number, altitude_profiles(city_name)), professionals(full_name)').eq('professional_id', req.params.profId).eq('status', 'Programado').order('shift_date');
  if (error) return fail(res, 'BD: ' + error.message, 500);
  ok(res, data || []);
}));
app.post('/api/scheduled-shifts', h(async (req, res) => {
  const { shiftDate, patientId, professionalId, shiftType } = req.body || {};
  if (!shiftDate || !patientId || !professionalId) return fail(res, 'Completa: fecha, paciente y prestador');
  const { data, error } = await sb.from('scheduled_shifts').insert({ shift_date: shiftDate, patient_id: patientId, professional_id: professionalId, shift_type: shiftType || 'personalizado', status: 'Programado' }).select().single();
  if (error) return fail(res, 'Error: ' + error.message);
  ok(res, data, 'Solicitud de servicio publicada');
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

// ---------- 💵 MÓDULO DE DINERO v3.1 (lecturas CORREGIDAS) ----------
app.get('/api/money/provider-rates', h(async (req, res) => {
  const data = await fetchAll('provider_rates');
  ok(res, data);
}));
app.patch('/api/money/provider-rates/:key', adminOnly, h(async (req, res) => {
  const { data, error } = await sb.from('provider_rates').update({ rate: Number(req.body?.rate) || 0 }).eq('event_type', req.params.key).select().single();
  if (error) return fail(res, 'Error: ' + error.message);
  ok(res, data, 'Tarifa actualizada');
}));
app.get('/api/money/client-prices', h(async (req, res) => {
  const data = await fetchAll('client_event_prices');
  ok(res, data);
}));
app.patch('/api/money/client-prices/:key', adminOnly, h(async (req, res) => {
  const { data, error } = await sb.from('client_event_prices').update({ price: Number(req.body?.price) || 0 }).eq('event_type', req.params.key).select().single();
  if (error) return fail(res, 'Error: ' + error.message);
  ok(res, data, 'Precio actualizado');
}));
app.get('/api/money/monthly-plans', h(async (req, res) => {
  const data = await fetchAll('monthly_plans');
  ok(res, data);
}));
app.patch('/api/money/monthly-plans/:key', adminOnly, h(async (req, res) => {
  const { data, error } = await sb.from('monthly_plans').update({ price: Number(req.body?.price) || 0 }).eq('plan_key', req.params.key).select().single();
  if (error) return fail(res, 'Error: ' + error.message);
  ok(res, data, 'Plan actualizado');
}));
app.get('/api/money/settings', h(async (req, res) => ok(res, await getMoneySettings())));
app.patch('/api/money/settings', adminOnly, h(async (req, res) => {
  const upd = {};
  if (req.body?.arl_monthly !== undefined) upd.arl_monthly = Number(req.body.arl_monthly);
  if (req.body?.ops_monthly_per_client !== undefined) upd.ops_monthly_per_client = Number(req.body.ops_monthly_per_client);
  if (req.body?.availability_stipend !== undefined) upd.availability_stipend = Number(req.body.availability_stipend);
  if (req.body?.stipend_active !== undefined) upd.stipend_active = !!req.body.stipend_active;
  upd.updated_at = new Date().toISOString();
  const { data, error } = await sb.from('money_settings').update(upd).eq('id', 1).select().single();
  if (error) return fail(res, 'Error: ' + error.message);
  ok(res, data, 'Configuración guardada');
}));
app.get('/api/money/provider-liquidation/:profId/:month/:year', h(async (req, res) => {
  const { from, to } = monthRange(req.params.year, req.params.month);
  const { data: prof } = await sb.from('professionals').select('full_name, document_number, arl_active_until, specialties(name)').eq('id', req.params.profId).single();
  if (!prof) return fail(res, 'Prestador no encontrado', 404);
  const { data: pays, error: pErr } = await sb.from('event_payments').select('*').eq('provider_id', req.params.profId).gte('validated_at', from).lt('validated_at', to).order('validated_at');
  if (pErr) return fail(res, 'BD: ' + pErr.message, 500);
  const total = (pays || []).reduce((a, p) => a + Number(p.amount), 0);
  const pending = (pays || []).filter(p => !p.paid);
  const settings = await getMoneySettings();
  ok(res, {
    provider: { full_name: prof.full_name, document: prof.document_number || '-', specialty: prof.specialties?.name || '-', arl_active_until: prof.arl_active_until, arl_expired: prof.arl_active_until && new Date(prof.arl_active_until) < new Date() },
    period: { month: req.params.month, year: req.params.year },
    payments: (pays || []).map(p => ({ id: p.id, date: p.validated_at?.slice(0, 10), event_type: p.event_type, amount: Number(p.amount), paid: p.paid })),
    totalAmount: total, pendingAmount: pending.reduce((a, p) => a + Number(p.amount), 0), eventsCount: (pays || []).length,
    arlMonthly: Number(settings.arl_monthly)
  });
}));
app.get('/api/money/payment-book/:month/:year', h(async (req, res) => {
  const { from, to } = monthRange(req.params.year, req.params.month);
  const { data: pays, error: pErr } = await sb.from('event_payments').select('*, professionals(full_name, document_number)').gte('validated_at', from).lt('validated_at', to).order('validated_at');
  if (pErr) return fail(res, 'BD: ' + pErr.message, 500);
  const byProvider = {};
  for (const p of (pays || [])) {
    if (!byProvider[p.provider_id]) byProvider[p.provider_id] = { providerId: p.provider_id, name: p.professionals?.full_name || '-', document: p.professionals?.document_number || '-', events: 0, total: 0, paid: 0, pending: 0 };
    byProvider[p.provider_id].events++;
    byProvider[p.provider_id].total += Number(p.amount);
    if (p.paid) byProvider[p.provider_id].paid += Number(p.amount); else byProvider[p.provider_id].pending += Number(p.amount);
  }
  ok(res, { period: { month: req.params.month, year: req.params.year }, providers: Object.values(byProvider).sort((a, b) => b.pending - a.pending) });
}));
app.patch('/api/money/event-payments/:id/paid', adminOnly, h(async (req, res) => {
  const { data, error } = await sb.from('event_payments').update({ paid: true, paid_at: new Date().toISOString() }).eq('id', req.params.id).select().single();
  if (error) return fail(res, 'Error: ' + error.message);
  ok(res, data, 'Pago marcado como realizado');
}));
app.patch('/api/money/pay-provider/:profId/:month/:year', adminOnly, h(async (req, res) => {
  const { from, to } = monthRange(req.params.year, req.params.month);
  await sb.from('event_payments').update({ paid: true, paid_at: new Date().toISOString() }).eq('provider_id', req.params.profId).eq('paid', false).gte('validated_at', from).lt('validated_at', to);
  ok(res, null, 'Liquidación marcada como pagada');
}));
app.get('/api/finance/profitability/:month/:year', h(async (req, res) => {
  const { from, to } = monthRange(req.params.year, req.params.month);
  const settings = await getMoneySettings();
  const { data: pays, error: pErr } = await sb.from('event_payments').select('event_id, amount, client_price, provider_id, professionals(full_name), patients(full_name)').gte('validated_at', from).lt('validated_at', to);
  if (pErr) return fail(res, 'BD: ' + pErr.message, 500);
  const prices = await getClientEventPrices();
  const holidaySet = await getHolidaysSet();
  const cupsMap = await getCupsMap();
  const { data: recs, error: rErr } = await sb.from('professional_records').select('id, created_at, patient_id, professional_id, professionals(id, full_name, visit_fee, specialties(name)), patients(id, full_name)').eq('admin_validated', true).gte('created_at', from).lt('created_at', to);
  if (rErr) return fail(res, 'BD: ' + rErr.message, 500);
  const byPatient = {};
  const getPat = (pid, name) => { if (!pid) pid = 'otros'; if (!byPatient[pid]) byPatient[pid] = { patient: name || 'Sin identificar', billed: 0, paidProviders: 0 }; return byPatient[pid]; };
  let totalBilled = 0, totalPaid = 0;
  const payBook = {};
  for (const p of (pays || [])) payBook[p.event_id] = p;
  // Especialidad de cada prestador (una sola consulta, sin N+1)
  const profSpecs = {};
  for (const p of (pays || [])) if (p.provider_id && profSpecs[p.provider_id] === undefined) profSpecs[p.provider_id] = null;
  const specIds = Object.keys(profSpecs);
  if (specIds.length) {
    const { data: profRows } = await sb.from('professionals').select('id, specialties(name)').in('id', specIds);
    for (const pr of (profRows || [])) profSpecs[pr.id] = pr.specialties?.name || '';
  }
  // Facturado por eventos: precio guardado al validar; fallback para eventos previos a v3
  const { data: shifts, error: sErr } = await sb.from('shifts').select('id, patient_id, shift_type, start_time, professional_id, patients(id, full_name)').eq('admin_validated', true).not('end_time', 'is', null).gte('start_time', from).lt('start_time', to);
  if (sErr) return fail(res, 'BD: ' + sErr.message, 500);
  for (const s of (shifts || [])) {
    const pay = payBook[s.id];
    let price = 0;
    if (pay) {
      price = Number(pay.client_price) || 0;
    } else {
      const specName = profSpecs[s.professional_id] || '';
      const providerType = specName === 'ACOMPANANTE' ? 'ACOMPANANTE' : 'AUXILIAR';
      const clientKey = resolveClientKey(s.shift_type, providerType, isHolidayOrSunday(s.start_time, holidaySet));
      price = prices[clientKey] || 0;
    }
    const pat = getPat(s.patient_id, s.patients?.full_name);
    pat.billed += price;
    if (pay) { pat.paidProviders += Number(pay.amount); totalPaid += Number(pay.amount); }
    totalBilled += price;
  }
  for (const r of (recs || [])) {
    const spec = r.professionals?.specialties?.name || '';
    const fee = Number(r.professionals?.visit_fee) || 0;
    const price = cupsMap[spec] || 0;
    const pat = getPat(r.patient_id, r.patients?.full_name);
    pat.billed += price; pat.paidProviders += fee;
    totalBilled += price; totalPaid += fee;
  }
  const patientsList = Object.entries(byPatient).map(([patientId, v]) => ({ patientId, ...v, profit: v.billed - v.paidProviders })).sort((a, b) => b.profit - a.profit);
  ok(res, {
    period: { month: req.params.month, year: req.params.year },
    company: await getCompany(),
    settings,
    totals: { billed: totalBilled, paidProviders: totalPaid, estimatedOps: patientsList.length * Number(settings.ops_monthly_per_client), profit: totalBilled - totalPaid },
    patients: patientsList
  });
}));

// ---------- EMPRESA / LEGACY ----------
app.get('/api/company', h(async (req, res) => ok(res, await getCompany())));
app.patch('/api/company', adminOnly, h(async (req, res) => {
  const b = req.body || {};
  const upd = {};
  if (b.responsibleName !== undefined) upd.responsible_name = b.responsibleName;
  if (b.docType !== undefined) upd.doc_type = b.docType;
  if (b.docNumber !== undefined) upd.doc_number = b.docNumber;
  if (b.address !== undefined) upd.address = b.address;
  if (b.phone !== undefined) upd.phone = b.phone;
  if (b.email !== undefined) upd.email = b.email;
  if (b.city !== undefined) upd.city = b.city;
  if (b.taxRegime !== undefined) upd.tax_regime = b.taxRegime;
  upd.updated_at = new Date().toISOString();
  const { data, error } = await sb.from('company_profile').update(upd).eq('id', 1).select().single();
  if (error) return fail(res, 'Error: ' + error.message);
  ok(res, data, 'Datos de la empresa guardados');
}));
app.get('/api/finance/parameters', h(async (req, res) => ok(res, await getFinanceLegacy())));
app.get('/api/finance/tariffs', h(async (req, res) => ok(res, await getActiveTariffs())));
app.patch('/api/finance/tariffs/:id', h(async (req, res) => {
  const upd = {}; Object.keys(req.body || {}).filter(k => k.startsWith('t_')).forEach(k => upd[k] = Number(req.body[k]) || 0);
  const { data, error } = await sb.from('client_tariffs').update(upd).eq('id', req.params.id).select().single();
  if (error) return fail(res, 'Error: ' + error.message);
  ok(res, data, 'Tarifas guardadas');
}));
app.get('/api/finance/cups-tariffs', h(async (req, res) => {
  const data = await fetchAll('cups_tariffs');
  ok(res, data);
}));
app.patch('/api/finance/cups-tariffs/:specialty', h(async (req, res) => {
  const { data, error } = await sb.from('cups_tariffs').update({ price: Number(req.body?.price) || 0, updated_at: new Date().toISOString() }).eq('specialty_code', req.params.specialty).select().single();
  if (error) return fail(res, 'Error: ' + error.message);
  ok(res, data, 'Tarifa CUPS actualizada');
}));
app.get('/api/finance/liquidation/:profId/:month/:year', h(async (req, res) => fail(res, 'Usa /api/money/provider-liquidation (módulo nuevo)', 410)));
app.get('/api/finance/liquidation-visits/:profId/:month/:year', h(async (req, res) => fail(res, 'Usa /api/money/provider-liquidation (módulo nuevo)', 410)));
app.get('/api/finance/invoice/:patId/:month/:year', h(async (req, res) => {
  const { from, to } = monthRange(req.params.year, req.params.month);
  const { data: pat } = await sb.from('patients').select('*, altitude_profiles(city_name)').eq('id', req.params.patId).single();
  const prices = await getClientEventPrices();
  const cupsMap = await getCupsMap();
  const holidaySet = await getHolidaysSet();
  const { data: shifts, error: sErr } = await sb.from('shifts').select('id, shift_type, start_time, professional_id, professionals(full_name)').eq('patient_id', req.params.patId).eq('admin_validated', true).not('end_time', 'is', null).gte('start_time', from).lt('start_time', to);
  if (sErr) return fail(res, 'BD: ' + sErr.message, 500);
  const { data: pays, error: pErr } = await sb.from('event_payments').select('event_id, client_price').gte('validated_at', from).lt('validated_at', to);
  if (pErr) return fail(res, 'BD: ' + pErr.message, 500);
  const payMap = Object.fromEntries((pays || []).map(p => [p.event_id, Number(p.client_price) || 0]));
  const details = (shifts || []).map(s => {
    let amount = payMap[s.id];
    if (amount === undefined) {
      const clientKey = resolveClientKey(s.shift_type, 'AUXILIAR', isHolidayOrSunday(s.start_time, holidaySet));
      amount = prices[clientKey] || 0;
    }
    return { date: colombiaDate(new Date(s.start_time)).toISOString().slice(0, 10), service: s.shift_type || '-', auxiliaries: s.professionals?.full_name || 'Equipo Vital Hogar', amount };
  });
  const { data: profRecs } = await sb.from('professional_records').select('record_type, created_at, professionals(full_name, specialties(name))').eq('patient_id', req.params.patId).eq('admin_validated', true).gte('created_at', from).lt('created_at', to);
  (profRecs || []).forEach(r => {
    const spec = r.professionals?.specialties?.name || '';
    const price = cupsMap[spec] || 0;
    if (price > 0) details.push({ date: colombiaDate(new Date(r.created_at)).toISOString().slice(0, 10), service: r.record_type || `Visita ${spec}`, auxiliaries: r.professionals?.full_name || '-', amount: price });
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

export default app;
if (!process.env.VERCEL) app.listen(PORT, () => console.log(`✅ Vital Hogar Pro API v3.1 en http://localhost:${PORT}`));
