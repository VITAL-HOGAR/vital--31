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
// 2. DASHBOARD MEJORADO
// ==========================================
app.get('/api/dashboard/stats', async (req, res) => {
    try {
        const { count: patCount } = await supabase.from('patients').select('*', { count: 'exact', head: true }).eq('is_active', true);
        const { count: profCount } = await supabase.from('professionals').select('*', { count: 'exact', head: true }).eq('is_active', true);
        
        const firstDayOfMonth = new Date();
        firstDayOfMonth.setDate(1);
        const { count: eduCount } = await supabase.from('education_topics')
            .select('*', { count: 'exact', head: true })
            .gte('created_at', firstDayOfMonth.toISOString());

        const thirtyDaysFromNow = new Date();
        thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30);
        const { data: expiryAlerts } = await supabase.from('professionals')
            .select('full_name, card_expiry_date')
            .lte('card_expiry_date', thirtyDaysFromNow.toISOString().split('T')[0])
            .gt('card_expiry_date', new Date().toISOString().split('T')[0]);

        const { data: patientsWithReports } = await supabase
            .from('patients')
            .select('id')
            .eq('is_active', true);

        const pendingReports = patientsWithReports?.length || 0;

        res.json({ 
            success: true, 
            data: { 
                patients: patCount, 
                professionals: profCount,
                educationSessions: eduCount || 0,
                pendingReports: pendingReports,
                expiryAlerts: expiryAlerts || []
            } 
        });
    } catch (error) { 
        console.error('Error dashboard:', error);
        res.status(500).json({ success: false, message: error.message }); 
    }
});

// ==========================================
// 3. GESTIÓN PROFESIONALES
// ==========================================
app.get('/api/professionals', async (req, res) => {
    const { data } = await supabase.from('professionals').select('*, specialties(name)').order('created_at', { ascending: false });
    res.json({ success: true, data });
});

app.post('/api/professionals', async (req, res) => {
    try {
        console.log("📥 Backend: Recibiendo datos de profesional:", req.body);
        const { email, password, fullName, documentNumber, specialtyName, signature } = req.body;
        
        const { data: specData } = await supabase.from('specialties').select('id').eq('name', specialtyName).single();
        if (!specData) return res.status(400).json({ success: false, message: 'Especialidad no válida' });

        const { data: authUser, error: authErr } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
        if (authErr) throw authErr;

        const { error: dbErr } = await supabase.from('professionals').insert([{
            user_id: authUser.user.id, 
            full_name: fullName, 
            document_number: documentNumber,
            specialty_id: specData.id, 
            signature_data: signature, 
            is_active: true
        }]);
        
        if (dbErr) {
            console.error("❌ Backend: Error al guardar en Supabase:", dbErr);
            throw dbErr;
        }
        
        console.log("✅ Backend: Profesional guardado exitosamente");
        res.json({ success: true, message: 'Profesional registrado' });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.patch('/api/professionals/:id', async (req, res) => {
    await supabase.from('professionals').update({ is_active: req.body.isActive }).eq('id', req.params.id);
    res.json({ success: true });
});

// ==========================================
// 4. GESTIÓN PACIENTES
// ==========================================
app.get('/api/patients', async (req, res) => {
    const { data } = await supabase.from('patients').select('*').order('created_at', { ascending: false });
    res.json({ success: true, data });
});

app.post('/api/patients', async (req, res) => {
    try {
        console.log("📥 Backend: Recibiendo datos de paciente:", req.body);
        const { fullName, documentNumber, cityName, pathology, address, contactPhone, familyName, familyId, familyRel } = req.body;
        
        const { data: cityData } = await supabase.from('altitude_profiles').select('id').eq('city_name', cityName).single();
        
        const { error: dbErr } = await supabase.from('patients').insert([{
            full_name: fullName, 
            document_number: documentNumber, 
            city_id: cityData?.id, 
            pathology_summary: pathology, 
            address: address,
            contact_phone: contactPhone, 
            family_name: familyName, 
            family_id_number: familyId,
            family_relationship: familyRel, 
            is_active: true
        }]);

        if (dbErr) {
            console.error("❌ Backend: Error al guardar paciente en Supabase:", dbErr);
            throw dbErr;
        }

        console.log("✅ Backend: Paciente guardado exitosamente");
        res.json({ success: true, message: 'Paciente registrado' });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// ==========================================
// 5. GESTIÓN EDUCACIÓN
// ==========================================
app.get('/api/education/topics', async (req, res) => {
    const { data } = await supabase.from('education_topics').select('*, professionals(full_name)').order('created_at', { ascending: false });
    res.json({ success: true, data });
});

app.post('/api/education/topics', async (req, res) => {
    const { title, description, responsibleId } = req.body;
    await supabase.from('education_topics').insert([{ title, description, created_by: responsibleId }]);
    res.json({ success: true, message: 'Tema creado' });
});

// ==========================================
// 6. INFORMES MENSUALES
// ==========================================
app.get('/api/reports/pending', async (req, res) => {
    try {
        const { data: patients } = await supabase.from('patients').select('id, full_name, family_name').eq('is_active', true);
        res.json({ success: true, data: patients || [] });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/reports/generate', async (req, res) => {
    try {
        const { patientId, month, year } = req.body;
        console.log(`📄 Generando informe para paciente ${patientId} - ${month}/${year}`);
        res.json({ 
            success: true, 
            message: 'Informe generado (simulación - pendiente Fase 5)',
            data: { patientId, month, year, status: 'pending_implementation' }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==========================================
// 7. VISTA DEL AUXILIAR (FASE 4)
// ==========================================

// Obtener pacientes activos con datos de altitud (para SpO2)
app.get('/api/auxiliar/patients', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('patients')
            .select('*, altitude_profiles(city_name, spo2_min_normal)')
            .eq('is_active', true)
            .order('created_at', { ascending: false });
        
        if (error) throw error;
        res.json({ success: true, data: data || [] });
    } catch (error) {
        console.error("❌ Error cargando pacientes para auxiliar:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Guardar registro clínico (signos vitales + actividades + novedades)
app.post('/api/clinical-records', async (req, res) => {
    try {
        console.log("📥 Backend: Recibiendo registro clínico:", req.body);
        const { 
            patientId, professionalId, bloodPressure, heartRate, 
            respiratoryRate, temperature, spo2, glucose, 
            activitiesCompleted, notes 
        } = req.body;

        const { data, error: dbErr } = await supabase.from('clinical_records').insert([{
            patient_id: patientId,
            professional_id: professionalId,
            blood_pressure: bloodPressure,
            heart_rate: heartRate,
            respiratory_rate: respiratoryRate,
            temperature: temperature,
            spo2: spo2,
            glucose: glucose,
            activities_completed: activitiesCompleted,
            notes: notes
        }]).select().single();

        if (dbErr) {
            console.error("❌ Backend: Error al guardar registro clínico:", dbErr);
            throw dbErr;
        }

        console.log("✅ Backend: Registro clínico guardado exitosamente, ID:", data.id);
        res.json({ success: true, message: 'Registro clínico guardado', data: { id: data.id } });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Cerrar turno con doble firma (Auxiliar + Familiar)
app.post('/api/shifts/close', async (req, res) => {
    try {
        console.log("📥 Backend: Cerrando turno con doble firma:", req.body);
        const { 
            clinicalRecordId, 
            auxiliarySignature, auxiliaryName, auxiliaryIdNumber,
            familySignature, familyName, familyIdNumber 
        } = req.body;

        const { error: dbErr } = await supabase.from('shift_signatures').insert([{
            clinical_record_id: clinicalRecordId,
            auxiliary_signature: auxiliarySignature,
            auxiliary_name: auxiliaryName,
            auxiliary_id_number: auxiliaryIdNumber,
            auxiliary_signed_at: new Date().toISOString(),
            family_signature: familySignature,
            family_name: familyName,
            family_id_number: familyIdNumber,
            family_signed_at: new Date().toISOString()
        }]);

        if (dbErr) {
            console.error("❌ Backend: Error al guardar firmas:", dbErr);
            throw dbErr;
        }

        console.log("✅ Backend: Turno cerrado con doble firma exitosamente");
        res.json({ success: true, message: 'Turno cerrado exitosamente' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Obtener historial de registros de un paciente (para informes)
app.get('/api/patients/:id/records', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('clinical_records')
            .select('*, shift_signatures(*)')
            .eq('patient_id', req.params.id)
            .order('created_at', { ascending: false });
        
        if (error) throw error;
        res.json({ success: true, data: data || [] });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==========================================
// SERVIDOR DE ARCHIVOS ESTÁTICOS
// ==========================================
app.get('*', (req, res) => { 
    if (!req.path.startsWith('/api')) {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    }
});

app.listen(PORT, '0.0.0.0', () => { 
    console.log(`🚀 Vital Hogar Pro Vivo en puerto ${PORT}`); 
});

export default app;
