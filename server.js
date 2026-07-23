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

        const { data: profData, error: profError } = await supabase
            .from('professionals')
            .select('*, specialties(name)')
            .eq('user_id', authData.user.id)
            .single();

        if (profError || !profData) return res.status(404).json({ success: false, message: 'Perfil no encontrado' });

        const token = jwt.sign(
            { id: profData.id, role: profData.specialty_id },
            process.env.JWT_SECRET || 'secreto_vital_temporal',
            { expiresIn: '24h' }
        );

        res.json({ success: true, data: { user: profData, token } });
    } catch (error) {
        console.error('Error en login:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/auth/reset-password', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ success: false, message: 'Email requerido' });
        
        const { error } = await supabase.auth.resetPasswordForEmail(email, {
            redirectTo: 'https://vital-hogar-31.onrender.com'
        });

        if (error) throw error;
        res.json({ success: true, message: 'Se ha enviado un enlace de recuperación a tu correo.' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
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
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==========================================
// 3. PROFESIONALES
// ==========================================
app.get('/api/professionals', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('professionals')
            .select('*, specialties(name)')
            .order('created_at', { ascending: false });
        if (error) throw error;
        res.json({ success: true, data: data || [] });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/professionals', async (req, res) => {
    try {
        const { email, password, fullName, documentNumber, specialtyName, signature, professionalCard } = req.body;
        if (!email || !password || !fullName || !documentNumber || !specialtyName) {
            return res.status(400).json({ success: false, message: 'Todos los campos son requeridos' });
        }

        const { data: specData } = await supabase.from('specialties').select('id').eq('name', specialtyName).single();
        if (!specData) return res.status(400).json({ success: false, message: 'Especialidad no válida' });

        const { data: authUser, error: authError } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
        if (authError) return res.status(400).json({ success: false, message: authError.message });

        const { error: insertError } = await supabase.from('professionals').insert([{
            user_id: authUser.user.id,
            full_name: fullName,
            document_number: documentNumber,
            specialty_id: specData.id,
            signature_data: signature || null,
            professional_card: professionalCard || null,
            is_active: true
        }]);

        if (insertError) {
            await supabase.auth.admin.deleteUser(authUser.user.id);
            return res.status(500).json({ success: false, message: insertError.message });
        }

        res.json({ success: true, message: 'Profesional registrado exitosamente' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.patch('/api/professionals/:id', async (req, res) => {
    try {
        const { fullName, documentNumber, professionalCard, specialtyName } = req.body;
        const updateData = {};
        if (fullName) updateData.full_name = fullName;
        if (documentNumber) updateData.document_number = documentNumber;
        if (professionalCard) updateData.professional_card = professionalCard;
        if (specialtyName) {
            const { data: spec } = await supabase.from('specialties').select('id').eq('name', specialtyName).single();
            if (spec) updateData.specialty_id = spec.id;
        }
        const { error } = await supabase.from('professionals').update(updateData).eq('id', req.params.id);
        if (error) throw error;
        res.json({ success: true, message: 'Profesional actualizado' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.patch('/api/professionals/:id/deactivate', async (req, res) => {
    try {
        const { isActive } = req.body;
        await supabase.from('professionals').update({ is_active: isActive }).eq('id', req.params.id);
        res.json({ success: true, message: isActive ? 'Profesional reactivado' : 'Profesional desactivado' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==========================================
// 4. PACIENTES
// ==========================================
app.get('/api/patients', async (req, res) => {
    try {
        let { data, error } = await supabase
            .from('patients')
            .select('*, altitude_profiles(city_name)')
            .order('created_at', { ascending: false });
            
        if (error) {
            const fallback = await supabase.from('patients').select('*').order('created_at', { ascending: false });
            data = fallback.data;
            error = fallback.error;
        }
        if (error) throw error;
        res.json({ success: true, data: data || [] });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/patients', async (req, res) => {
    try {
        const { fullName, documentNumber, cityName, pathology, address, contactPhone, familyName, familyId, familyRel } = req.body;
        if (!fullName || !documentNumber) return res.status(400).json({ success: false, message: 'Nombre y cédula son requeridos' });

        let cityId = null;
        if (cityName) {
            const { data: cityData } = await supabase.from('altitude_profiles').select('id').eq('city_name', cityName).single();
            if (cityData) cityId = cityData.id;
        }

        const { error } = await supabase.from('patients').insert([{
            full_name: fullName, document_number: documentNumber, city_id: cityId,
            pathology_summary: pathology || null, address: address || null,
            contact_phone: contactPhone || null, family_name: familyName || null,
            family_id_number: familyId || null, family_relationship: familyRel || null, is_active: true
        }]);

        if (error) throw error;
        res.json({ success: true, message: 'Paciente registrado exitosamente' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.patch('/api/patients/:id', async (req, res) => {
    try {
        const { fullName, documentNumber, cityName, familyName, contactPhone } = req.body;
        const updateData = {};
        if (fullName) updateData.full_name = fullName;
        if (documentNumber) updateData.document_number = documentNumber;
        if (familyName) updateData.family_name = familyName;
        if (contactPhone) updateData.contact_phone = contactPhone;
        if (cityName) {
            const { data: city } = await supabase.from('altitude_profiles').select('id').eq('city_name', cityName).single();
            if (city) updateData.city_id = city.id;
        }
        const { error } = await supabase.from('patients').update(updateData).eq('id', req.params.id);
        if (error) throw error;
        res.json({ success: true, message: 'Paciente actualizado' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.patch('/api/patients/:id/discharge', async (req, res) => {
    try {
        const { reason, notes } = req.body;
        await supabase.from('patients').update({
            is_active: false, discharge_date: new Date().toISOString(),
            discharge_reason: reason, discharge_notes: notes || null
        }).eq('id', req.params.id);
        res.json({ success: true, message: 'Paciente dado de baja' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.patch('/api/patients/:id/reactivate', async (req, res) => {
    try {
        await supabase.from('patients').update({
            is_active: true, discharge_date: null, discharge_reason: null, discharge_notes: null
        }).eq('id', req.params.id);
        res.json({ success: true, message: 'Paciente reactivado' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==========================================
// 5. EDUCACIÓN
// ==========================================
app.get('/api/education/topics', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('education_topics')
            .select(`*, professionals!education_topics_created_by_fkey(full_name, document_number, professional_card)`)
            .order('created_at', { ascending: false });
        if (error) throw error;
        res.json({ success: true, data: data || [] });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/education/topics', async (req, res) => {
    try {
        const { title, description, responsibleId } = req.body;
        if (!title) return res.status(400).json({ success: false, message: 'El título es requerido' });

        const { error } = await supabase.from('education_topics').insert([{
            title, description: description || 'Sin descripción', created_by: responsibleId || null
        }]);
        if (error) throw error;
        res.json({ success: true, message: 'Tema educativo creado' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==========================================
// 6. AUXILIAR - TURNOS Y REGISTROS
// ==========================================
app.get('/api/auxiliar/patients', async (req, res) => {
    try {
        let { data, error } = await supabase
            .from('patients')
            .select(`*, altitude_profiles(city_name, spo2_min_normal), clinical_records(created_at, spo2, glucose, eva_score, glasgow_eyes, glasgow_verbal, glasgow_motor)`)
            .eq('is_active', true)
            .order('created_at', { ascending: false });

        if (error) {
            const fallback = await supabase.from('patients').select('*').eq('is_active', true).order('created_at', { ascending: false });
            data = fallback.data; error = fallback.error;
        }
        if (error) throw error;

        if (data) {
            data.forEach(patient => {
                if (patient.clinical_records) {
                    patient.clinical_records.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
                }
            });
        }
        res.json({ success: true, data: data || [] });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/shifts/start', async (req, res) => {
    try {
        const { patientId, professionalId, shiftType, patientStatus, patientNotes, customStartTime, customEndTime } = req.body;
        if (!patientId || !professionalId || !shiftType) return res.status(400).json({ success: false, message: 'Datos incompletos' });

        const { data, error } = await supabase.from('shifts').insert([{
            patient_id: patientId, professional_id: professionalId, shift_type: shiftType,
            start_time: customStartTime ? new Date(customStartTime).toISOString() : new Date().toISOString(),
            end_time: customEndTime ? new Date(customEndTime).toISOString() : null,
            patient_received_status: patientStatus || null, patient_received_notes: patientNotes || null, is_closed: false
        }]).select().single();

        if (error) throw error;
        res.json({ success: true, message: 'Turno iniciado', data: { id: data.id } });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/clinical-records', async (req, res) => {
    try {
        const { shiftId, patientId, professionalId, bloodPressure, heartRate, respiratoryRate, temperature, spo2, glucose, evaScore, consciousnessLevel, glasgowEyes, glasgowVerbal, glasgowMotor, bradenScore, bristolType, ppeUsed, wasteManagement, externalAccompaniment, activitiesCompleted, sbarSituation, sbarBackground, sbarAssessment, sbarRecommendation, notes } = req.body;

        if (!shiftId || !patientId || !professionalId) return res.status(400).json({ success: false, message: 'Datos incompletos' });

        const { data, error } = await supabase.from('clinical_records').insert([{
            shift_id: shiftId, patient_id: patientId, professional_id: professionalId,
            blood_pressure: bloodPressure || null, heart_rate: heartRate || null, respiratory_rate: respiratoryRate || null,
            temperature: temperature || null, spo2: spo2 || null, glucose: glucose || null, eva_score: evaScore || 0,
            consciousness_level: consciousnessLevel || null, glasgow_eyes: glasgowEyes || null, glasgow_verbal: glasgowVerbal || null, glasgow_motor: glasgowMotor || null,
            braden_score: bradenScore || null, bristol_type: bristolType || null, ppe_used: ppeUsed || {}, waste_management: wasteManagement || {},
            external_accompaniment: externalAccompaniment || null, activities_completed: activitiesCompleted || {},
            sbar_situation: sbarSituation || null, sbar_background: sbarBackground || null, sbar_assessment: sbarAssessment || null, sbar_recommendation: sbarRecommendation || null,
            notes: notes || null
        }]).select().single();

        if (error) throw error;
        res.json({ success: true, message: 'Registro guardado', data: { id: data.id } });
    } catch (error) {
        console.error('Error al guardar registro:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/patients/:id/daily-history', async (req, res) => {
    try {
        const today = new Date(); today.setHours(0, 0, 0, 0);
        const { data: records, error: err1 } = await supabase
            .from('clinical_records')
            .select('*, professionals(full_name)')
            .eq('patient_id', req.params.id)
            .gte('created_at', today.toISOString())
            .order('created_at', { ascending: true });

        if (err1) throw err1;

        const { data: signatures, error: err2 } = await supabase
            .from('shift_signatures')
            .select('*')
            .gte('created_at', today.toISOString());

        if (err2) throw err2;
        res.json({ success: true, data: { records: records || [], signatures: signatures || [] } });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/shifts/close', async (req, res) => {
    try {
        const { shiftId, patientDeliveredStatus, patientDeliveredNotes, pendingTasks, pendingJustification, auxiliarySignature, auxiliaryName, auxiliaryIdNumber, auxiliaryProfessionalCard, familySignature, familyName, familyIdNumber, familyRelationship, familyPhone, patientLeavesHome, leaveData, familyReceivedEducation, educationTopicGiven, educationPhotoData } = req.body;

        if (!shiftId || !auxiliarySignature || !auxiliaryName || !auxiliaryIdNumber) {
            return res.status(400).json({ success: false, message: 'Datos de cierre incompletos' });
        }

        await supabase.from('shifts').update({
            end_time: new Date().toISOString(),
            patient_delivered_status: patientDeliveredStatus || null,
            patient_delivered_notes: patientDeliveredNotes || null,
            pending_tasks: pendingTasks || null,
            pending_justification: pendingJustification || null,
            is_closed: true
        }).eq('id', shiftId);

        await supabase.from('shift_signatures').insert([{
            clinical_record_id: null,
            auxiliary_signature: auxiliarySignature, auxiliary_name: auxiliaryName,
            auxiliary_id_number: auxiliaryIdNumber, auxiliary_professional_card: auxiliaryProfessionalCard || null,
            auxiliary_signed_at: new Date().toISOString(),
            family_signature: familySignature || null, family_name: familyName || null,
            family_id_number: familyIdNumber || null, family_relationship: familyRelationship || null,
            family_phone: familyPhone || null, family_signed_at: familySignature ? new Date().toISOString() : null,
            patient_leaves_home: patientLeavesHome || false,
            leave_data: leaveData || null,
            family_received_education: familyReceivedEducation || false,
            education_topic_given: educationTopicGiven || null,
            education_photo_data: educationPhotoData || null
        }]);

        res.json({ success: true, message: 'Turno cerrado exitosamente', data: { shiftId } });
    } catch (error) {
        console.error('Error al cerrar turno:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/shifts/:shiftId/closure-data', async (req, res) => {
    try {
        const { data: shift, error: shiftError } = await supabase
            .from('shifts')
            .select('*, patients(*, altitude_profiles(city_name))')
            .eq('id', req.params.shiftId)
            .single();

        if (shiftError) throw shiftError;

        const { data: records, error: recordsError } = await supabase
            .from('clinical_records')
            .select('*')
            .eq('shift_id', req.params.shiftId)
            .order('created_at', { ascending: true });

        if (recordsError) throw recordsError;

        const { data: signatures, error: sigError } = await supabase
            .from('shift_signatures')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(1);

        if (sigError) throw sigError;

        res.json({ success: true, data: { shift, records: records || [], signatures: signatures || [] } });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==========================================
// 7. INFORMES CONSOLIDADOS (MEJORADO)
// ==========================================
app.get('/api/reports/pending', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('patients')
            .select('id, full_name, family_name')
            .eq('is_active', true)
            .order('full_name');

        if (error) throw error;
        res.json({ success: true, data: data || [] });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/reports/:patientId/:month/:year', async (req, res) => {
    try {
        const { patientId, month, year } = req.params;
        const monthNum = parseInt(month);
        const yearNum = parseInt(year);

        if (monthNum < 1 || monthNum > 12 || yearNum < 2000) return res.status(400).json({ success: false, message: 'Mes o año inválido' });

        const { data: patient, error: patientError } = await supabase
            .from('patients')
            .select('*, altitude_profiles(city_name)')
            .eq('id', patientId)
            .single();

        if (patientError || !patient) return res.status(404).json({ success: false, message: 'Paciente no encontrado' });

        const startDate = `${year}-${month.padStart(2, '0')}-01T00:00:00.000Z`;
        const endDate = new Date(yearNum, monthNum, 0, 23, 59, 59).toISOString();

        // 1. Registros del Auxiliar
        const { data: records, error: recordsError } = await supabase
            .from('clinical_records')
            .select('*, professionals(full_name)')
            .eq('patient_id', patientId)
            .gte('created_at', startDate)
            .lte('created_at', endDate)
            .order('created_at', { ascending: true });

        if (recordsError) throw recordsError;

        // 2. Registros de Profesionales (Médico, Fisio, etc.)
        const { data: profRecords, error: profRecordsError } = await supabase
            .from('professional_records')
            .select('*, professionals(full_name, specialties(name))')
            .eq('patient_id', patientId)
            .gte('created_at', startDate)
            .lte('created_at', endDate)
            .order('created_at', { ascending: true });

        if (profRecordsError) throw profRecordsError;

        let stats = { totalRecords: 0, avgSpo2: 0, avgHR: 0, avgTemp: 0, criticalAlerts: 0 };
        if (records && records.length > 0) {
            stats.totalRecords = records.length;
            let spo2Sum = 0, hrSum = 0, tempSum = 0;
            let spo2Count = 0, hrCount = 0, tempCount = 0;

            records.forEach(record => {
                if (record.spo2 !== null && record.spo2 !== undefined) { spo2Sum += record.spo2; spo2Count++; }
                if (record.heart_rate !== null && record.heart_rate !== undefined) { hrSum += record.heart_rate; hrCount++; }
                if (record.temperature !== null && record.temperature !== undefined) { tempSum += record.temperature; tempCount++; }

                const spo2Min = patient?.altitude_profiles?.spo2_min_normal || 95;
                if (record.spo2 < (spo2Min - 3) || record.glucose > 200 || (record.glucose < 60 && record.glucose > 0)) {
                    stats.criticalAlerts++;
                }
            });

            if (spo2Count > 0) stats.avgSpo2 = Math.round(spo2Sum / spo2Count);
            if (hrCount > 0) stats.avgHR = Math.round(hrSum / hrCount);
            if (tempCount > 0) stats.avgTemp = parseFloat((tempSum / tempCount).toFixed(1));
        }

        res.json({ success: true, data: { patient, records: records || [], profRecords: profRecords || [], stats } });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==========================================
// 8. NOTAS DE EVOLUCIÓN PROFESIONALES (FASE 2)
// ==========================================
app.post('/api/professional-records', async (req, res) => {
    try {
        const { patientId, professionalId, shiftId, recordType, weight, height, imc, vitalSigns, subjective, objective, analysis, plan, photoData, professionalSignature, familySignature, familyName, familyId } = req.body;
        
        if (!patientId || !professionalId) return res.status(400).json({ success: false, message: 'Datos incompletos' });

        const { data, error } = await supabase.from('professional_records').insert([{
            patient_id: patientId,
            professional_id: professionalId,
            shift_id: shiftId || null,
            record_type: recordType || 'Nota de Evolución',
            weight: weight || null,
            height: height || null,
            imc: imc || null,
            vital_signs: vitalSigns || {},
            subjective: subjective || null,
            objective: objective || null,
            analysis: analysis || null,
            plan: plan || null,
            photo_data: photoData || null,
            professional_signature: professionalSignature || null,
            family_signature: familySignature || null,
            family_name: familyName || null,
            family_id: familyId || null
        }]).select().single();

        if (error) throw error;
        res.json({ success: true, message: 'Nota de evolución guardada', data: { id: data.id } });
    } catch (error) {
        console.error('Error al guardar nota profesional:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==========================================
// SERVIDOR DE ARCHIVOS
// ==========================================
app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    } else {
        res.status(404).json({ success: false, message: 'Endpoint no encontrado' });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor en puerto ${PORT}`);
});

export default app;
