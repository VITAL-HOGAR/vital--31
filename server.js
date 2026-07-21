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
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// 1. AUTENTICACIÓN
// ==========================================
app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const { data: authData, error: authError } = await supabase.auth.signInWithPassword({ email, password });
        if (authError || !authData.user) return res.status(401).json({ success: false, message: 'Credenciales inválidas' });
        const { data: profData } = await supabase.from('professionals').select('*').eq('user_id', authData.user.id).single();
        if (!profData) return res.status(404).json({ success: false, message: 'Perfil no encontrado.' });
        const token = jwt.sign({ id: profData.id, role: profData.specialty_id }, process.env.JWT_SECRET || 'secreto_vital', { expiresIn: '24h' });
        res.json({ success: true, data: { user: profData, token } });
    } catch (error) { console.error(error); res.status(500).json({ success: false, message: 'Error interno' }); }
});

// ==========================================
// 2. DASHBOARD
// ==========================================
app.get('/api/dashboard/stats', async (req, res) => {
    try {
        const { count: patCount } = await supabase.from('patients').select('*', { count: 'exact', head: true }).eq('is_active', true);
        const { count: profCount } = await supabase.from('professionals').select('*', { count: 'exact', head: true }).eq('is_active', true);
        const firstDayOfMonth = new Date(); firstDayOfMonth.setDate(1);
        const { count: eduCount } = await supabase.from('education_topics').select('*', { count: 'exact', head: true }).gte('created_at', firstDayOfMonth.toISOString());
        const { data: patientsWithReports } = await supabase.from('patients').select('id').eq('is_active', true);
        res.json({ success: true, data: { patients: patCount, professionals: profCount, educationSessions: eduCount || 0, pendingReports: patientsWithReports?.length || 0 } });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// ==========================================
// 3. PROFESIONALES
// ==========================================
app.get('/api/professionals', async (req, res) => {
    const { data } = await supabase.from('professionals').select('*, specialties(name)').order('created_at', { ascending: false });
    res.json({ success: true, data });
});

app.post('/api/professionals', async (req, res) => {
    try {
        const { email, password, fullName, documentNumber, specialtyName, signature, professionalCard } = req.body;
        const { data: specData } = await supabase.from('specialties').select('id').eq('name', specialtyName).single();
        if (!specData) return res.status(400).json({ success: false, message: 'Especialidad no válida' });
        const { data: authUser } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
        await supabase.from('professionals').insert([{ user_id: authUser.user.id, full_name: fullName, document_number: documentNumber, specialty_id: specData.id, signature_data: signature, professional_card: professionalCard || null, is_active: true }]);
        res.json({ success: true, message: 'Profesional registrado' });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.patch('/api/professionals/:id/deactivate', async (req, res) => {
    try {
        const { isActive } = req.body;
        await supabase.from('professionals').update({ is_active: isActive === false ? false : true }).eq('id', req.params.id);
        res.json({ success: true, message: isActive === false ? 'Profesional desactivado' : 'Profesional reactivado' });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// ==========================================
// 4. PACIENTES
// ==========================================
app.get('/api/patients', async (req, res) => {
    const { data } = await supabase.from('patients').select('*').order('created_at', { ascending: false });
    res.json({ success: true, data });
});

app.post('/api/patients', async (req, res) => {
    try {
        const { fullName, documentNumber, cityName, pathology, address, contactPhone, familyName, familyId, familyRel } = req.body;
        const { data: cityData } = await supabase.from('altitude_profiles').select('id').eq('city_name', cityName).single();
        await supabase.from('patients').insert([{ full_name: fullName, document_number: documentNumber, city_id: cityData?.id, pathology_summary: pathology, address: address, contact_phone: contactPhone, family_name: familyName, family_id_number: familyId, family_relationship: familyRel, is_active: true }]);
        res.json({ success: true, message: 'Paciente registrado' });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.patch('/api/patients/:id/discharge', async (req, res) => {
    try {
        const { reason, notes } = req.body;
        await supabase.from('patients').update({ is_active: false, discharge_date: new Date().toISOString(), discharge_reason: reason, discharge_notes: notes || null }).eq('id', req.params.id);
        res.json({ success: true, message: 'Paciente dado de baja' });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.patch('/api/patients/:id/reactivate', async (req, res) => {
    try {
        await supabase.from('patients').update({ is_active: true, discharge_date: null, discharge_reason: null, discharge_notes: null }).eq('id', req.params.id);
        res.json({ success: true, message: 'Paciente reactivado' });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// ==========================================
// 5. EDUCACIÓN
// ==========================================
app.get('/api/education/topics', async (req, res) => {
    // Se usa left join implícito para evitar que falle si no hay relación perfecta
    const { data } = await supabase.from('education_topics').select('*, professionals(full_name)').order('created_at', { ascending: false });
    res.json({ success: true, data: data || [] });
});

app.post('/api/education/topics', async (req, res) => {
    const { title, description, responsibleId } = req.body;
    await supabase.from('education_topics').insert([{ title, description, created_by: responsibleId }]);
    res.json({ success: true, message: 'Tema creado' });
});

// ==========================================
// 6. AUXILIAR - TURNOS Y REGISTROS
// ==========================================
app.get('/api/auxiliar/patients', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('patients')
            .select(`*, altitude_profiles(city_name, spo2_min_normal), clinical_records!inner(created_at, spo2, glucose, eva_score, glasgow_eyes, glasgow_verbal, glasgow_motor)`)
            .eq('is_active', true)
            .order('created_at', { ascending: false });
        if (error) throw error;
        data.forEach(p => { if (p.clinical_records) p.clinical_records.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)); });
        res.json({ success: true, data: data || [] });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.post('/api/shifts/start', async (req, res) => {
    try {
        const { patientId, professionalId, shiftType, patientStatus, patientNotes, customStartTime, customEndTime } = req.body;
        const { data, error } = await supabase.from('shifts').insert([{
            patient_id: patientId, professional_id: professionalId, shift_type: shiftType,
            start_time: customStartTime ? new Date(customStartTime).toISOString() : new Date().toISOString(),
            end_time: customEndTime ? new Date(customEndTime).toISOString() : null,
            patient_received_status: patientStatus, patient_received_notes: patientNotes, is_closed: false
        }]).select().single();
        if (error) throw error;
        res.json({ success: true, message: 'Turno iniciado', data: { id: data.id } });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.post('/api/clinical-records', async (req, res) => {
    try {
        const { shiftId, patientId, professionalId, bloodPressure, heartRate, respiratoryRate, temperature, spo2, glucose, evaScore, consciousnessLevel, glasgowEyes, glasgowVerbal, glasgowMotor, bradenScore, bristolType, ppeUsed, wasteManagement, externalAccompaniment, activitiesCompleted, sbarSituation, sbarBackground, sbarAssessment, sbarRecommendation, notes } = req.body;
        const { data, error } = await supabase.from('clinical_records').insert([{
            shift_id: shiftId, patient_id: patientId, professional_id: professionalId, blood_pressure: bloodPressure, heart_rate: heartRate, respiratory_rate: respiratoryRate, temperature: temperature, spo2: spo2, glucose: glucose, eva_score: evaScore, consciousness_level: consciousnessLevel, glasgow_eyes: glasgowEyes, glasgow_verbal: glasgowVerbal, glasgow_motor: glasgowMotor, braden_score: bradenScore, bristol_type: bristolType, ppe_used: ppeUsed, waste_management: wasteManagement, external_accompaniment: externalAccompaniment, activities_completed: activitiesCompleted, sbar_situation: sbarSituation, sbar_background: sbarBackground, sbar_assessment: sbarAssessment, sbar_recommendation: sbarRecommendation, notes: notes
        }]).select().single();
        if (error) throw error;
        res.json({ success: true, message: 'Registro guardado', data: { id: data.id } });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.get('/api/patients/:id/daily-history', async (req, res) => {
    try {
        const today = new Date(); today.setHours(0, 0, 0, 0);
        const { data: records, error: err1 } = await supabase.from('clinical_records').select('*, professionals(full_name)').eq('patient_id', req.params.id).gte('created_at', today.toISOString()).order('created_at', { ascending: true });
        if (err1) throw err1;
        const { data: signatures, error: err2 } = await supabase.from('shift_signatures').select('*').gte('created_at', today.toISOString());
        if (err2) throw err2;
        res.json({ success: true, data: { records: records || [], signatures: signatures || [] } });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.post('/api/shifts/close', async (req, res) => {
    try {
        const { shiftId, patientDeliveredStatus, patientDeliveredNotes, pendingTasks, pendingJustification, auxiliarySignature, auxiliaryName, auxiliaryIdNumber, auxiliaryProfessionalCard, familySignature, familyName, familyIdNumber, familyRelationship, familyPhone } = req.body;
        await supabase.from('shifts').update({ end_time: new Date().toISOString(), patient_delivered_status: patientDeliveredStatus, patient_delivered_notes: patientDeliveredNotes, pending_tasks: pendingTasks, pending_justification: pendingJustification, is_closed: true }).eq('id', shiftId);
        await supabase.from('shift_signatures').insert([{ clinical_record_id: null, auxiliary_signature: auxiliarySignature, auxiliary_name: auxiliaryName, auxiliary_id_number: auxiliaryIdNumber, auxiliary_professional_card: auxiliaryProfessionalCard || null, auxiliary_signed_at: new Date().toISOString(), family_signature: familySignature, family_name: familyName, family_id_number: familyIdNumber, family_relationship: familyRelationship, family_phone: familyPhone, family_signed_at: new Date().toISOString() }]);
        res.json({ success: true, message: 'Turno cerrado exitosamente', data: { shiftId } });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.get('/api/shifts/:shiftId/closure-data', async (req, res) => {
    try {
        const { data: shift } = await supabase.from('shifts').select('*, patients(*, altitude_profiles(city_name))').eq('id', req.params.shiftId).single();
        const { data: records } = await supabase.from('clinical_records').select('*').eq('shift_id', req.params.shiftId).order('created_at', { ascending: true });
        const { data: signatures } = await supabase.from('shift_signatures').select('*').order('created_at', { ascending: false }).limit(1);
        res.json({ success: true, data: { shift, records: records || [], signatures: signatures || [] } });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// ==========================================
// 7. INFORMES Y PDFs
// ==========================================
app.get('/api/reports/pending', async (req, res) => {
    try {
        const { data: patients } = await supabase.from('patients').select('id, full_name, family_name').eq('is_active', true);
        res.json({ success: true, data: patients || [] });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.get('/api/reports/:patientId/:month/:year', async (req, res) => {
    try {
        const { patientId, month, year } = req.params;
        const { data: patient } = await supabase.from('patients').select('*, altitude_profiles(city_name)').eq('id', patientId).single();
        const startDate = `${year}-${month}-01T00:00:00.000Z`;
        const endDate = new Date(parseInt(year), parseInt(month), 0, 23, 59, 59).toISOString();
        const { data: records } = await supabase.from('clinical_records').select('*, professionals(full_name)').eq('patient_id', patientId).gte('created_at', startDate).lte('created_at', endDate).order('created_at', { ascending: true });

        let stats = { totalRecords: 0, avgSpo2: 0, avgHR: 0, avgTemp: 0, criticalAlerts: 0 };
        let spo2Sum = 0, hrSum = 0, tempSum = 0, count = 0;
        if (records) {
            stats.totalRecords = records.length;
            records.forEach(r => {
                if (r.spo2) { spo2Sum += r.spo2; count++; }
                if (r.heart_rate) hrSum += r.heart_rate;
                if (r.temperature) tempSum += r.temperature;
                const spo2Min = patient?.altitude_profiles?.spo2_min_normal || 95;
                if (r.spo2 < spo2Min - 3 || r.glucose > 200 || r.glucose < 60) stats.criticalAlerts++;
            });
            if (count > 0) stats.avgSpo2 = Math.round(spo2Sum / count);
            if (records.length > 0) { stats.avgHR = Math.round(hrSum / records.length); stats.avgTemp = (tempSum / records.length).toFixed(1); }
        }
        res.json({ success: true, data: { patient, records: records || [], stats } });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// ==========================================
// SERVIDOR DE ARCHIVOS (AL FINAL ABSOLUTO)
// ==========================================
app.get('*', (req, res) => { if (!req.path.startsWith('/api')) res.sendFile(path.join(__dirname, 'public', 'index.html')); });

app.listen(PORT, '0.0.0.0', () => { console.log(`🚀 Vital Hogar Pro Vivo en puerto ${PORT}`); });
export default app;
