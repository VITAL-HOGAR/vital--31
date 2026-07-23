import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import jwt from 'jsonwebtoken';

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 10000;

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error('❌ ERROR: Faltan variables de entorno');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// 1. AUTENTICACIÓN
// ==========================================
app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) return res.status(400).json({ success: false, message: 'Email y contraseña son requeridos' });
        const { data: authData, error: authError } = await supabase.auth.signInWithPassword({ email, password });
        if (authError || !authData?.user) return res.status(401).json({ success: false, message: 'Credenciales inválidas' });
        const { data: profData, error: profError } = await supabase.from('professionals').select('*, specialties(name)').eq('user_id', authData.user.id).single();
        if (profError || !profData) return res.status(404).json({ success: false, message: 'Perfil no encontrado' });
        const token = jwt.sign({ id: profData.id, role: profData.specialty_id }, process.env.JWT_SECRET || 'secreto_vital_temporal', { expiresIn: '24h' });
        res.json({ success: true, data: { user: profData, token } });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.post('/api/auth/reset-password', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ success: false, message: 'Email requerido' });
        const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: 'https://vital-hogar-31.onrender.com' });
        if (error) throw error;
        res.json({ success: true, message: 'Se ha enviado un enlace de recuperación a tu correo.' });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// ==========================================
// 2. DASHBOARD
// ==========================================
app.get('/api/dashboard/stats', async (req, res) => {
    try {
        const { count: patCount } = await supabase.from('patients').select('*', { count: 'exact', head: true }).eq('is_active', true);
        const { count: profCount } = await supabase.from('professionals').select('*', { count: 'exact', head: true }).eq('is_active', true);
        const { count: pendingReports } = await supabase.from('patients').select('*', { count: 'exact', head: true }).eq('is_active', true);
        res.json({ success: true, data: { patients: patCount || 0, professionals: profCount || 0, pendingReports: pendingReports || 0 } });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// ==========================================
// 3. PROFESIONALES
// ==========================================
app.get('/api/professionals', async (req, res) => {
    try { const { data, error } = await supabase.from('professionals').select('*, specialties(name)').order('created_at', { ascending: false }); if (error) throw error; res.json({ success: true, data: data || [] }); } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.post('/api/professionals', async (req, res) => {
    try {
        const { email, password, fullName, documentNumber, specialtyName, professionalCard } = req.body;
        if (!email || !password || !fullName || !documentNumber || !specialtyName) return res.status(400).json({ success: false, message: 'Todos los campos son requeridos' });
        const { data: specData } = await supabase.from('specialties').select('id').eq('name', specialtyName).single();
        if (!specData) return res.status(400).json({ success: false, message: 'Especialidad no válida' });
        const { data: authUser, error: authError } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
        if (authError) return res.status(400).json({ success: false, message: authError.message });
        const { error: insertError } = await supabase.from('professionals').insert([{ user_id: authUser.user.id, full_name: fullName, document_number: documentNumber, specialty_id: specData.id, professional_card: professionalCard || null, is_active: true }]);
        if (insertError) { await supabase.auth.admin.deleteUser(authUser.user.id); return res.status(500).json({ success: false, message: insertError.message }); }
        res.json({ success: true, message: 'Profesional registrado exitosamente' });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.patch('/api/professionals/:id', async (req, res) => {
    try {
        const { fullName, documentNumber, professionalCard, specialtyName, newPassword } = req.body;
        const updateData = {};
        if (fullName) updateData.full_name = fullName;
        if (documentNumber) updateData.document_number = documentNumber;
        if (professionalCard) updateData.professional_card = professionalCard;
        if (specialtyName) { const { data: spec } = await supabase.from('specialties').select('id').eq('name', specialtyName).single(); if (spec) updateData.specialty_id = spec.id; }
        const { error } = await supabase.from('professionals').update(updateData).eq('id', req.params.id);
        if (error) throw error;
        if (newPassword) { const { data: profData } = await supabase.from('professionals').select('user_id').eq('id', req.params.id).single(); if (profData && profData.user_id) { const { error: passError } = await supabase.auth.admin.updateUserById(profData.user_id, { password: newPassword }); if (passError) throw new Error('No se pudo actualizar la contraseña: ' + passError.message); } }
        res.json({ success: true, message: 'Profesional actualizado' + (newPassword ? ' (Contraseña modificada)' : '') });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.patch('/api/professionals/:id/deactivate', async (req, res) => {
    try { const { isActive } = req.body; await supabase.from('professionals').update({ is_active: isActive }).eq('id', req.params.id); res.json({ success: true, message: isActive ? 'Profesional reactivado' : 'Profesional desactivado' }); } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// ==========================================
// 4. PACIENTES (CON CIE-10 Y EPS)
// ==========================================
app.get('/api/patients', async (req, res) => {
    try {
        let { data, error } = await supabase.from('patients').select('*, altitude_profiles(city_name)').order('created_at', { ascending: false });
        if (error) { const fallback = await supabase.from('patients').select('*').order('created_at', { ascending: false }); data = fallback.data; error = fallback.error; }
        if (error) throw error;
        res.json({ success: true, data: data || [] });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.post('/api/patients', async (req, res) => {
    try {
        const { fullName, documentNumber, cityName, pathology, address, contactPhone, familyName, familyId, familyRel, cie10Code, epsName, epsAuthorization } = req.body;
        if (!fullName || !documentNumber) return res.status(400).json({ success: false, message: 'Nombre y cédula son requeridos' });
        let cityId = null;
        if (cityName) { const { data: cityData } = await supabase.from('altitude_profiles').select('id').eq('city_name', cityName).single(); if (cityData) cityId = cityData.id; }
        const { error } = await supabase.from('patients').insert([{ full_name: fullName, document_number: documentNumber, city_id: cityId, pathology_summary: pathology || null, address: address || null, contact_phone: contactPhone || null, family_name: familyName || null, family_id_number: familyId || null, family_relationship: familyRel || null, cie_10_code: cie10Code || null, eps_name: epsName || null, eps_authorization: epsAuthorization || null, is_active: true }]);
        if (error) throw error;
        res.json({ success: true, message: 'Paciente registrado exitosamente' });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.patch('/api/patients/:id', async (req, res) => {
    try {
        const { fullName, documentNumber, cityName, familyName, contactPhone, cie10Code, epsName, epsAuthorization } = req.body;
        const updateData = {};
        if (fullName) updateData.full_name = fullName;
        if (documentNumber) updateData.document_number = documentNumber;
        if (familyName) updateData.family_name = familyName;
        if (contactPhone) updateData.contact_phone = contactPhone;
        if (cie10Code !== undefined) updateData.cie_10_code = cie10Code;
        if (epsName !== undefined) updateData.eps_name = epsName;
        if (epsAuthorization !== undefined) updateData.eps_authorization = epsAuthorization;
        if (cityName) { const { data: city } = await supabase.from('altitude_profiles').select('id').eq('city_name', cityName).single(); if (city) updateData.city_id = city.id; }
        const { error } = await supabase.from('patients').update(updateData).eq('id', req.params.id);
        if (error) throw error;
        res.json({ success: true, message: 'Paciente actualizado' });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.patch('/api/patients/:id/discharge', async (req, res) => {
    try { const { reason, notes } = req.body; await supabase.from('patients').update({ is_active: false, discharge_date: new Date().toISOString(), discharge_reason: reason, discharge_notes: notes || null }).eq('id', req.params.id); res.json({ success: true, message: 'Paciente dado de baja' }); } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.patch('/api/patients/:id/reactivate', async (req, res) => {
    try { await supabase.from('patients').update({ is_active: true, discharge_date: null, discharge_reason: null, discharge_notes: null }).eq('id', req.params.id); res.json({ success: true, message: 'Paciente reactivado' }); } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// ==========================================
// 5. EDUCACIÓN
// ==========================================
app.get('/api/education/topics', async (req, res) => {
    try { const { data, error } = await supabase.from('education_topics').select(`*, professionals!education_topics_created_by_fkey(full_name, document_number, professional_card)`).order('created_at', { ascending: false }); if (error) throw error; res.json({ success: true, data: data || [] }); } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.post('/api/education/topics', async (req, res) => {
    try { const { title, description, responsibleId } = req.body; if (!title) return res.status(400).json({ success: false, message: 'El título es requerido' }); const { error } = await supabase.from('education_topics').insert([{ title, description: description || 'Sin descripción', created_by: responsibleId || null }]); if (error) throw error; res.json({ success: true, message: 'Tema educativo creado' }); } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// ==========================================
// 6. AUXILIAR - TURNOS, REGISTROS Y EVENTOS
// ==========================================
app.get('/api/auxiliar/patients', async (req, res) => {
    try {
        let { data, error } = await supabase.from('patients').select(`*, altitude_profiles(city_name, spo2_min_normal), clinical_records(created_at, spo2, glucose, eva_score, glasgow_eyes, glasgow_verbal, glasgow_motor)`).eq('is_active', true).order('created_at', { ascending: false });
        if (error) { const fallback = await supabase.from('patients').select('*').eq('is_active', true).order('created_at', { ascending: false }); data = fallback.data; error = fallback.error; }
        if (error) throw error;
        if (data) data.forEach(p => { if (p.clinical_records) p.clinical_records.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)); });
        res.json({ success: true, data: data || [] });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.post('/api/shifts/start', async (req, res) => {
    try { const { patientId, professionalId, shiftType, patientStatus, patientNotes, customStartTime, customEndTime } = req.body; if (!patientId || !professionalId || !shiftType) return res.status(400).json({ success: false, message: 'Datos incompletos' }); const { data, error } = await supabase.from('shifts').insert([{ patient_id: patientId, professional_id: professionalId, shift_type: shiftType, start_time: customStartTime ? new Date(customStartTime).toISOString() : new Date().toISOString(), end_time: customEndTime ? new Date(customEndTime).toISOString() : null, patient_received_status: patientStatus || null, patient_received_notes: patientNotes || null, is_closed: false }]).select().single(); if (error) throw error; res.json({ success: true, message: 'Turno iniciado', data: { id: data.id } }); } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.post('/api/clinical-records', async (req, res) => {
    try {
        const { shiftId, patientId, professionalId, bloodPressure, heartRate, respiratoryRate, temperature, spo2, glucose, evaScore, glasgowEyes, glasgowVerbal, glasgowMotor, bradenScore, morseScore, activitiesCompleted, sbarSituation, sbarBackground, sbarAssessment, sbarRecommendation, notes } = req.body;
        if (!shiftId || !patientId || !professionalId) return res.status(400).json({ success: false, message: 'Datos incompletos' });
        const { data, error } = await supabase.from('clinical_records').insert([{ shift_id: shiftId, patient_id: patientId, professional_id: professionalId, blood_pressure: bloodPressure || null, heart_rate: heartRate || null, respiratory_rate: respiratoryRate || null, temperature: temperature || null, spo2: spo2 || null, glucose: glucose || null, eva_score: evaScore || 0, glasgow_eyes: glasgowEyes || null, glasgow_verbal: glasgowVerbal || null, glasgow_motor: glasgowMotor || null, braden_score: bradenScore || null, morse_score: morseScore || null, activities_completed: activitiesCompleted || {}, sbar_situation: sbarSituation || null, sbar_background: sbarBackground || null, sbar_assessment: sbarAssessment || null, sbar_recommendation: sbarRecommendation || null, notes: notes || null }]).select().single();
        if (error) throw error;
        res.json({ success: true, message: 'Registro guardado', data: { id: data.id } });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.get('/api/patients/:id/daily-history', async (req, res) => {
    try { const today = new Date(); today.setHours(0, 0, 0, 0); const { data: records, error: err1 } = await supabase.from('clinical_records').select('*, professionals(full_name)').eq('patient_id', req.params.id).gte('created_at', today.toISOString()).order('created_at', { ascending: true }); if (err1) throw err1; const { data: signatures, error: err2 } = await supabase.from('shift_signatures').select('*').gte('created_at', today.toISOString()); if (err2) throw err2; res.json({ success: true, data: { records: records || [], signatures: signatures || [] } }); } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.post('/api/shifts/close', async (req, res) => {
    try { const { shiftId, patientDeliveredStatus, patientDeliveredNotes, pendingTasks, auxiliarySignature, auxiliaryName, auxiliaryIdNumber, familySignature, familyName, familyIdNumber, familyRelationship, familyPhone, patientLeavesHome, leaveData, familyReceivedEducation, educationTopicGiven, educationPhotoData } = req.body; if (!shiftId || !auxiliarySignature || !auxiliaryName || !auxiliaryIdNumber) return res.status(400).json({ success: false, message: 'Datos de cierre incompletos' }); await supabase.from('shifts').update({ end_time: new Date().toISOString(), patient_delivered_status: patientDeliveredStatus || null, patient_delivered_notes: patientDeliveredNotes || null, pending_tasks: pendingTasks || null, is_closed: true }).eq('id', shiftId); await supabase.from('shift_signatures').insert([{ auxiliary_signature: auxiliarySignature, auxiliary_name: auxiliaryName, auxiliary_id_number: auxiliaryIdNumber, family_signature: familySignature || null, family_name: familyName || null, family_id_number: familyIdNumber || null, family_relationship: familyRelationship || null, family_phone: familyPhone || null, patient_leaves_home: patientLeavesHome || false, leave_data: leaveData || null, family_received_education: familyReceivedEducation || false, education_topic_given: educationTopicGiven || null, education_photo_data: educationPhotoData || null }]); res.json({ success: true, message: 'Turno cerrado exitosamente', data: { shiftId } }); } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.get('/api/shifts/:shiftId/closure-data', async (req, res) => {
    try { const { data: shift, error: shiftError } = await supabase.from('shifts').select('*, patients(*, altitude_profiles(city_name))').eq('id', req.params.shiftId).single(); if (shiftError) throw shiftError; const { data: records, error: recordsError } = await supabase.from('clinical_records').select('*').eq('shift_id', req.params.shiftId).order('created_at', { ascending: true }); if (recordsError) throw recordsError; const { data: signatures, error: sigError } = await supabase.from('shift_signatures').select('*').order('created_at', { ascending: false }).limit(1); if (sigError) throw sigError; res.json({ success: true, data: { shift, records: records || [], signatures: signatures || [] } }); } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// EVENTOS ADVERSOS (NUEVO)
app.post('/api/adverse-events', async (req, res) => {
    try {
        const { patientId, professionalId, eventType, description } = req.body;
        if (!patientId || !professionalId || !description) return res.status(400).json({ success: false, message: 'Datos del evento incompletos' });
        const { error } = await supabase.from('adverse_events').insert([{ patient_id: patientId, professional_id: professionalId, event_type: eventType || 'Otro', description: description }]);
        if (error) throw error;
        res.json({ success: true, message: 'Evento adverso reportado exitosamente' });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// ==========================================
// 7. INFORMES CONSOLIDADOS
// ==========================================
app.get('/api/reports/pending', async (req, res) => {
    try { const { data, error } = await supabase.from('patients').select('id, full_name, family_name').eq('is_active', true).order('full_name'); if (error) throw error; res.json({ success: true, data: data || [] }); } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.get('/api/reports/:patientId/:month/:year', async (req, res) => {
    try {
        const { patientId, month, year } = req.params; const monthNum = parseInt(month); const yearNum = parseInt(year);
        if (monthNum < 1 || monthNum > 12 || yearNum < 2000) return res.status(400).json({ success: false, message: 'Mes o año inválido' });
        const { data: patient, error: patientError } = await supabase.from('patients').select('*, altitude_profiles(city_name)').eq('id', patientId).single();
        if (patientError || !patient) return res.status(404).json({ success: false, message: 'Paciente no encontrado' });
        const startDate = `${year}-${month.padStart(2, '0')}-01T00:00:00.000Z`; const endDate = new Date(yearNum, monthNum, 0, 23, 59, 59).toISOString();
        const { data: records, error: recordsError } = await supabase.from('clinical_records').select('*, professionals(full_name)').eq('patient_id', patientId).gte('created_at', startDate).lte('created_at', endDate).order('created_at', { ascending: true });
        if (recordsError) throw recordsError;
        const { data: profRecords, error: profRecordsError } = await supabase.from('professional_records').select('*, professionals(full_name, specialties(name))').eq('patient_id', patientId).gte('created_at', startDate).lte('created_at', endDate).order('created_at', { ascending: true });
        if (profRecordsError) throw profRecordsError;
        res.json({ success: true, data: { patient, records: records || [], profRecords: profRecords || [], stats: { totalRecords: records?.length || 0 } } });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.post('/api/professional-records', async (req, res) => {
    try { const { patientId, professionalId, recordType, weight, height, imc, vitalSigns, subjective, objective, analysis, plan, photoData, professionalSignature, familySignature, familyName, familyId } = req.body; if (!patientId || !professionalId) return res.status(400).json({ success: false, message: 'Datos incompletos' }); const { data, error } = await supabase.from('professional_records').insert([{ patient_id: patientId, professional_id: professionalId, record_type: recordType || 'Nota de Evolución', weight: weight || null, height: height || null, imc: imc || null, vital_signs: vitalSigns || {}, subjective: subjective || null, objective: objective || null, analysis: analysis || null, plan: plan || null, photo_data: photoData || null, professional_signature: professionalSignature || null, family_signature: familySignature || null, family_name: familyName || null, family_id: familyId || null }]).select().single(); if (error) throw error; res.json({ success: true, message: 'Nota de evolución guardada', data: { id: data.id } }); } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// ==========================================
// 8. MÓDULO FINANCIERO
// ==========================================
app.get('/api/finance/parameters', async (req, res) => { try { const { data, error } = await supabase.from('financial_parameters').select('*').eq('is_active', true).single(); if (error) throw error; res.json({ success: true, data: data || {} }); } catch (error) { res.status(500).json({ success: false, message: error.message }); } });
app.patch('/api/finance/parameters/:id', async (req, res) => { try { const { smmlv, subsidy_transport, night_surcharge_percentage, holiday_surcharge_percentage, night_start_hour, night_end_hour, year } = req.body; const { error } = await supabase.from('financial_parameters').update({ smmlv, subsidy_transport, night_surcharge_percentage, holiday_surcharge_percentage, night_start_hour, night_end_hour, year }).eq('id', req.params.id); if (error) throw error; res.json({ success: true, message: 'Parámetros de ley actualizados' }); } catch (error) { res.status(500).json({ success: false, message: error.message }); } });
app.get('/api/finance/tariffs', async (req, res) => { try { const { data, error } = await supabase.from('client_tariffs').select('*').eq('is_active', true).single(); if (error) throw error; res.json({ success: true, data: data || {} }); } catch (error) { res.status(500).json({ success: false, message: error.message }); } });
app.patch('/api/finance/tariffs/:id', async (req, res) => { try { const { t_6h_diurno, t_6h_nocturno, t_8h_diurno, t_8h_nocturno, t_12h_diurno, t_12h_nocturno, t_24h } = req.body; const { error } = await supabase.from('client_tariffs').update({ t_6h_diurno, t_6h_nocturno, t_8h_diurno, t_8h_nocturno, t_12h_diurno, t_12h_nocturno, t_24h }).eq('id', req.params.id); if (error) throw error; res.json({ success: true, message: 'Tarifas de clientes actualizadas' }); } catch (error) { res.status(500).json({ success: false, message: error.message }); } });

app.get('/api/finance/liquidation/:professionalId/:month/:year', async (req, res) => {
    try {
        const { professionalId, month, year } = req.params; const monthNum = parseInt(month); const yearNum = parseInt(year);
        const { data: params } = await supabase.from('financial_parameters').select('*').eq('is_active', true).single();
        if (!params) return res.status(404).json({ success: false, message: 'Parámetros financieros no configurados' });
        const startDate = `${year}-${month.padStart(2, '0')}-01T00:00:00.000Z`; const endDate = new Date(yearNum, monthNum, 0, 23, 59, 59).toISOString();
        const { data: shifts, error: shiftError } = await supabase.from('shifts').select('*, patients(full_name)').eq('professional_id', professionalId).eq('is_closed', true).gte('start_time', startDate).lte('start_time', endDate).order('start_time', { ascending: true });
        if (shiftError) throw shiftError;
        const smmlv = parseFloat(params.smmlv); const dailyRate = smmlv / 30; const hourlyRate = dailyRate / 8; const nightStart = params.night_start_hour; const nightEnd = params.night_end_hour; const nightPct = parseFloat(params.night_surcharge_percentage) / 100; const sundayPct = parseFloat(params.holiday_surcharge_percentage) / 100;
        let totalAmount = 0; let details = [];
        shifts.forEach(shift => { const start = new Date(shift.start_time); const end = shift.end_time ? new Date(shift.end_time) : new Date(start.getTime() + 12 * 3600000); let totalHours = (end - start) / (1000 * 60 * 60); if (isNaN(totalHours) || totalHours <= 0) totalHours = 0; let shiftBase = totalHours * hourlyRate; let nightBonus = 0; let sundayBonus = 0; if (start.getDay() === 0) { sundayBonus = shiftBase * sundayPct; } let nightHours = 0; for (let i = 0; i < totalHours; i++) { const hour = new Date(start.getTime() + i * 3600000).getHours(); if (hour >= nightStart || hour < nightEnd) { nightHours++; } } nightBonus = nightHours * hourlyRate * nightPct; const totalShiftPay = shiftBase + nightBonus + sundayBonus; totalAmount += totalShiftPay; details.push({ date: start.toLocaleDateString('es-CO'), patient: shift.patients?.full_name || 'N/A', shift_type: shift.shift_type, hours: totalHours.toFixed(1), base_pay: Math.round(shiftBase), night_bonus: Math.round(nightBonus), sunday_bonus: Math.round(sundayBonus), total: Math.round(totalShiftPay) }); });
        let subsidy = 0; if (totalAmount < (smmlv * 2)) { subsidy = parseFloat(params.subsidy_transport); totalAmount += subsidy; }
        res.json({ success: true, data: { params, shifts: details, totalAmount: Math.round(totalAmount), subsidyApplied: subsidy } });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.get('/api/finance/invoice/:patientId/:month/:year', async (req, res) => {
    try {
        const { patientId, month, year } = req.params; const monthNum = parseInt(month); const yearNum = parseInt(year);
        const { data: tariffs, error: tariffError } = await supabase.from('client_tariffs').select('*').limit(1).maybeSingle();
        if (tariffError) throw new Error('Error en BD tarifas: ' + tariffError.message);
        if (!tariffs) return res.status(400).json({ success: false, message: 'Debe configurar las tarifas de clientes primero en el sistema.' });
        const { data: patientData, error: patError } = await supabase.from('patients').select('full_name').eq('id', patientId).maybeSingle();
        if (patError) throw new Error('Error en BD paciente: ' + patError.message);
        const startDate = `${year}-${month.padStart(2, '0')}-01T00:00:00.000Z`; const endDate = new Date(yearNum, monthNum, 0, 23, 59, 59).toISOString();
        const { data: shifts, error: shiftError } = await supabase.from('shifts').select('*').eq('patient_id', patientId).eq('is_closed', true).gte('start_time', startDate).lte('start_time', endDate).order('start_time', { ascending: true });
        if (shiftError) throw new Error('Error en BD turnos: ' + shiftError.message);
        const groupedByDate = {};
        if (shifts && shifts.length > 0) { shifts.forEach(s => { if (!s.start_time) return; const dateStr = new Date(s.start_time).toISOString().split('T')[0]; if (!groupedByDate[dateStr]) groupedByDate[dateStr] = []; groupedByDate[dateStr].push(s); }); }
        let totalAmount = 0; let invoiceDetails = [];
        for (const date in groupedByDate) { const dayShifts = groupedByDate[date]; const types = dayShifts.map(s => s.shift_type); let has24h = types.includes('24h'); let has12D = types.includes('12h_diurno'); let has12N = types.includes('12h_nocturno'); if (has24h || (has12D && has12N)) { const amount = parseFloat(tariffs.t_24h) || 0; invoiceDetails.push({ date: date, service: 'Servicio 24 Horas', auxiliaries: 'Servicio Integral', amount: amount }); totalAmount += amount; } else { dayShifts.forEach(s => { let amount = parseFloat(tariffs[`t_${s.shift_type}`]) || 0; invoiceDetails.push({ date: date, service: `Turno ${s.shift_type.replace('_', ' ')}`, auxiliaries: 'Servicio Integral', amount: amount }); totalAmount += amount; }); } }
        res.json({ success: true, data: { patient: patientData || { full_name: 'Paciente' }, details: invoiceDetails, totalAmount: totalAmount } });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// ==========================================
// 9. AGENDA Y MENSAJERÍA
// ==========================================
app.get('/api/scheduled-shifts', async (req, res) => { try { const { data, error } = await supabase.from('scheduled_shifts').select('*, patients(full_name), professionals(full_name)').order('shift_date', { ascending: true }); if (error) throw error; res.json({ success: true, data: data || [] }); } catch (error) { res.status(500).json({ success: false, message: error.message }); } });
app.get('/api/scheduled-shifts/professional/:profId', async (req, res) => { try { const { data, error } = await supabase.from('scheduled_shifts').select('*, patients(*, altitude_profiles(city_name))').eq('professional_id', req.params.profId).eq('status', 'Programado').order('shift_date', { ascending: true }); if (error) throw error; res.json({ success: true, data: data || [] }); } catch (error) { res.status(500).json({ success: false, message: error.message }); } });
app.post('/api/scheduled-shifts', async (req, res) => { try { const { patientId, professionalId, shiftDate, shiftType } = req.body; if (!patientId || !professionalId || !shiftDate || !shiftType) return res.status(400).json({ success: false, message: 'Datos de agenda incompletos' }); const { error } = await supabase.from('scheduled_shifts').insert([{ patient_id: patientId, professional_id: professionalId, shift_date: shiftDate, shift_type: shiftType, status: 'Programado' }]); if (error) throw error; res.json({ success: true, message: 'Turno programado exitosamente' }); } catch (error) { res.status(500).json({ success: false, message: error.message }); } });

app.get('/api/messages', async (req, res) => { try { const { data, error } = await supabase.from('internal_messages').select('*, patients(full_name)').order('created_at', { ascending: true }).limit(100); if (error) throw error; res.json({ success: true, data: data || [] }); } catch (error) { res.status(500).json({ success: false, message: error.message }); } });
app.post('/api/messages', async (req, res) => { try { const { patientId, shiftId, senderId, senderName, message, isAlert } = req.body; if (!senderId || !message) return res.status(400).json({ success: false, message: 'Mensaje vacío o sin remitente' }); const { error } = await supabase.from('internal_messages').insert([{ patient_id: patientId || null, shift_id: shiftId || null, sender_id: senderId, sender_name: senderName || 'Usuario', message: message, is_alert: isAlert || false, is_read: false }]); if (error) throw error; res.json({ success: true, message: 'Mensaje enviado' }); } catch (error) { res.status(500).json({ success: false, message: error.message }); } });

// ==========================================
// SERVIDOR DE ARCHIVOS
// ==========================================
app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) { res.sendFile(path.join(__dirname, 'public', 'index.html')); } else { res.status(404).json({ success: false, message: 'Endpoint no encontrado' }); }
});

app.listen(PORT, '0.0.0.0', () => { console.log(`🚀 Servidor en puerto ${PORT}`); });

export default app;
