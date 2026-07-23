import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { body, validationResult, param } from 'express-validator';

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 10000;

// ==========================================
// CONFIGURACIÓN DE SUPABASE
// ==========================================
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error('❌ ERROR: Faltan variables de entorno SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// ==========================================
// MIDDLEWARES DE SEGURIDAD
// ==========================================
app.use(helmet());
app.use(cors({ 
    origin: process.env.CORS_ORIGIN || '*',
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// Rate limiting
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutos
    max: 100,
    message: { success: false, message: 'Demasiadas peticiones, intente más tarde' }
});
app.use('/api/', apiLimiter);

// Rate limiting específico para auth
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { success: false, message: 'Demasiados intentos de login' }
});

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// MIDDLEWARE DE AUTENTICACIÓN JWT
// ==========================================
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    if (!token) {
        return res.status(401).json({ success: false, message: 'Token no proporcionado' });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secreto_vital_temporal');
        req.user = decoded;
        next();
    } catch (error) {
        return res.status(403).json({ success: false, message: 'Token inválido o expirado' });
    }
};

// Middleware de validación de errores
const handleValidationErrors = (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ 
            success: false, 
            message: 'Datos de entrada inválidos',
            errors: errors.array() 
        });
    }
    next();
};

// ==========================================
// 1. AUTENTICACIÓN
// ==========================================
app.post('/api/auth/login', authLimiter, [
    body('email').isEmail().normalizeEmail().withMessage('Email inválido'),
    body('password').notEmpty().trim().withMessage('Contraseña requerida'),
    handleValidationErrors
], async (req, res) => {
    try {
        const { email, password } = req.body;

        const { data: authData, error: authError } = await supabase.auth.signInWithPassword({ email, password });
        if (authError || !authData?.user) {
            return res.status(401).json({ success: false, message: 'Credenciales inválidas' });
        }

        const { data: profData, error: profError } = await supabase
            .from('professionals')
            .select('*, specialties(name)')
            .eq('user_id', authData.user.id)
            .single();

        if (profError || !profData) {
            return res.status(404).json({ success: false, message: 'Perfil profesional no encontrado' });
        }

        if (!profData.is_active) {
            return res.status(403).json({ success: false, message: 'Cuenta desactivada. Contacte al administrador.' });
        }

        const token = jwt.sign(
            { 
                id: profData.id, 
                userId: authData.user.id,
                role: profData.specialty_id,
                email: profData.full_name 
            },
            process.env.JWT_SECRET || 'secreto_vital_temporal',
            { expiresIn: '24h' }
        );

        res.json({ 
            success: true, 
            data: { 
                user: {
                    id: profData.id,
                    fullName: profData.full_name,
                    documentNumber: profData.document_number,
                    specialty: profData.specialties?.name,
                    specialtyId: profData.specialty_id,
                    isActive: profData.is_active
                }, 
                token 
            } 
        });
    } catch (error) {
        console.error('Error en login:', error);
        res.status(500).json({ success: false, message: 'Error interno del servidor' });
    }
});

// ==========================================
// 2. DASHBOARD
// ==========================================
app.get('/api/dashboard/stats', authenticateToken, async (req, res) => {
    try {
        const [
            { count: patCount },
            { count: profCount },
            { count: eduCount },
            { count: pendingReportsCount }
        ] = await Promise.all([
            supabase.from('patients').select('*', { count: 'exact', head: true }).eq('is_active', true),
            supabase.from('professionals').select('*', { count: 'exact', head: true }).eq('is_active', true),
            (() => {
                const firstDayOfMonth = new Date();
                firstDayOfMonth.setDate(1);
                firstDayOfMonth.setHours(0, 0, 0, 0);
                return supabase.from('education_topics').select('*', { count: 'exact', head: true }).gte('created_at', firstDayOfMonth.toISOString());
            })(),
            // CORREGIDO: Contar reportes pendientes reales (turnos abiertos sin registro)
            supabase.from('shifts').select('*', { count: 'exact', head: true }).eq('is_closed', false)
        ]);

        res.json({ 
            success: true, 
            data: { 
                patients: patCount || 0, 
                professionals: profCount || 0, 
                educationSessions: eduCount || 0, 
                pendingReports: pendingReportsCount || 0 
            } 
        });
    } catch (error) {
        console.error('Error en dashboard:', error);
        res.status(500).json({ success: false, message: 'Error al obtener estadísticas' });
    }
});

// ==========================================
// 3. PROFESIONALES
// ==========================================
app.get('/api/professionals', authenticateToken, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('professionals')
            .select('*, specialties(name)')
            .order('created_at', { ascending: false });
            
        if (error) throw error;
        res.json({ success: true, data: data || [] });
    } catch (error) {
        console.error('Error al obtener profesionales:', error);
        res.status(500).json({ success: false, message: 'Error al obtener profesionales' });
    }
});

app.post('/api/professionals', authenticateToken, [
    body('email').isEmail().normalizeEmail(),
    body('password').isLength({ min: 6 }).withMessage('La contraseña debe tener al menos 6 caracteres'),
    body('fullName').trim().notEmpty(),
    body('documentNumber').trim().notEmpty(),
    body('specialtyName').trim().notEmpty(),
    handleValidationErrors
], async (req, res) => {
    try {
        const { email, password, fullName, documentNumber, specialtyName, signature, professionalCard } = req.body;

        // Verificar si ya existe el documento
        const { data: existingDoc } = await supabase
            .from('professionals')
            .select('id')
            .eq('document_number', documentNumber)
            .single();

        if (existingDoc) {
            return res.status(409).json({ success: false, message: 'Ya existe un profesional con ese número de documento' });
        }

        const { data: specData, error: specError } = await supabase
            .from('specialties')
            .select('id')
            .eq('name', specialtyName)
            .single();

        if (specError || !specData) {
            return res.status(400).json({ success: false, message: 'Especialidad no válida' });
        }

        const { data: authUser, error: authError } = await supabase.auth.admin.createUser({ 
            email, 
            password, 
            email_confirm: true 
        });
        
        if (authError) {
            return res.status(400).json({ success: false, message: authError.message });
        }

        const { error: insertError } = await supabase.from('professionals').insert([{
            user_id: authUser.user.id,
            full_name: fullName.trim(),
            document_number: documentNumber.trim(),
            specialty_id: specData.id,
            signature_data: signature || null,
            professional_card: professionalCard?.trim() || null,
            is_active: true
        }]);

        if (insertError) {
            // Rollback: eliminar usuario de auth si falla la inserción
            await supabase.auth.admin.deleteUser(authUser.user.id);
            return res.status(500).json({ success: false, message: insertError.message });
        }

        res.json({ success: true, message: 'Profesional registrado exitosamente' });
    } catch (error) {
        console.error('Error al crear profesional:', error);
        res.status(500).json({ success: false, message: 'Error al registrar profesional' });
    }
});

// CORREGIDO: Ruta PATCH única para actualizar profesional
app.patch('/api/professionals/:id', authenticateToken, [
    param('id').isUUID().withMessage('ID de profesional inválido'),
    handleValidationErrors
], async (req, res) => {
    try {
        const { fullName, documentNumber, professionalCard, specialtyName, isActive } = req.body;
        const updateData = {};
        
        if (fullName !== undefined) updateData.full_name = fullName.trim();
        if (documentNumber !== undefined) updateData.document_number = documentNumber.trim();
        if (professionalCard !== undefined) updateData.professional_card = professionalCard.trim();
        if (isActive !== undefined) updateData.is_active = Boolean(isActive);
        
        if (specialtyName) {
            const { data: spec } = await supabase
                .from('specialties')
                .select('id')
                .eq('name', specialtyName)
                .single();
            if (spec) updateData.specialty_id = spec.id;
        }

        if (Object.keys(updateData).length === 0) {
            return res.status(400).json({ success: false, message: 'No hay datos para actualizar' });
        }

        const { error } = await supabase
            .from('professionals')
            .update(updateData)
            .eq('id', req.params.id);

        if (error) throw error;
        res.json({ success: true, message: 'Profesional actualizado exitosamente' });
    } catch (error) {
        console.error('Error al actualizar profesional:', error);
        res.status(500).json({ success: false, message: 'Error al actualizar profesional' });
    }
});

// ==========================================
// 4. PACIENTES
// ==========================================
app.get('/api/patients', authenticateToken, async (req, res) => {
    try {
        let { data, error } = await supabase
            .from('patients')
            .select('*, altitude_profiles(city_name, spo2_min_normal)')
            .order('created_at', { ascending: false });
            
        if (error) {
            console.warn('⚠️ Join falló, usando fallback:', error.message);
            const fallback = await supabase
                .from('patients')
                .select('*')
                .order('created_at', { ascending: false });
            data = fallback.data;
            error = fallback.error;
        }
        
        if (error) throw error;
        res.json({ success: true, data: data || [] });
    } catch (error) {
        console.error('❌ Error en /api/patients:', error);
        res.status(500).json({ success: false, message: 'Error al obtener pacientes' });
    }
});

app.post('/api/patients', authenticateToken, [
    body('fullName').trim().notEmpty().withMessage('El nombre es requerido'),
    body('documentNumber').trim().notEmpty().withMessage('La cédula es requerida'),
    handleValidationErrors
], async (req, res) => {
    try {
        const { 
            fullName, 
            documentNumber, 
            cityName, 
            pathology, 
            address, 
            contactPhone, 
            familyName, 
            familyId, 
            familyRel 
        } = req.body;

        // Verificar documento duplicado
        const { data: existing } = await supabase
            .from('patients')
            .select('id')
            .eq('document_number', documentNumber.trim())
            .single();

        if (existing) {
            return res.status(409).json({ success: false, message: 'Ya existe un paciente con ese número de documento' });
        }

        let cityId = null;
        if (cityName) {
            const { data: cityData } = await supabase
                .from('altitude_profiles')
                .select('id')
                .eq('city_name', cityName)
                .single();
            if (cityData) cityId = cityData.id;
        }

        const { error } = await supabase.from('patients').insert([{
            full_name: fullName.trim(),
            document_number: documentNumber.trim(),
            city_id: cityId,
            pathology_summary: pathology?.trim() || null,
            address: address?.trim() || null,
            contact_phone: contactPhone?.trim() || null,
            family_name: familyName?.trim() || null,
            family_id_number: familyId?.trim() || null,
            family_relationship: familyRel?.trim() || null,
            is_active: true
        }]);

        if (error) throw error;
        res.json({ success: true, message: 'Paciente registrado exitosamente' });
    } catch (error) {
        console.error('Error al crear paciente:', error);
        res.status(500).json({ success: false, message: 'Error al registrar paciente' });
    }
});

app.patch('/api/patients/:id', authenticateToken, [
    param('id').isUUID(),
    handleValidationErrors
], async (req, res) => {
    try {
        const { fullName, documentNumber, cityName, familyName, contactPhone, pathology } = req.body;
        const updateData = {};
        
        if (fullName !== undefined) updateData.full_name = fullName.trim();
        if (documentNumber !== undefined) updateData.document_number = documentNumber.trim();
        if (familyName !== undefined) updateData.family_name = familyName.trim();
        if (contactPhone !== undefined) updateData.contact_phone = contactPhone.trim();
        if (pathology !== undefined) updateData.pathology_summary = pathology.trim();
        
        if (cityName) {
            const { data: city } = await supabase
                .from('altitude_profiles')
                .select('id')
                .eq('city_name', cityName)
                .single();
            if (city) updateData.city_id = city.id;
        }

        if (Object.keys(updateData).length === 0) {
            return res.status(400).json({ success: false, message: 'No hay datos para actualizar' });
        }

        const { error } = await supabase
            .from('patients')
            .update(updateData)
            .eq('id', req.params.id);

        if (error) throw error;
        res.json({ success: true, message: 'Paciente actualizado exitosamente' });
    } catch (error) {
        console.error('Error al actualizar paciente:', error);
        res.status(500).json({ success: false, message: 'Error al actualizar paciente' });
    }
});

app.patch('/api/patients/:id/discharge', authenticateToken, [
    param('id').isUUID(),
    handleValidationErrors
], async (req, res) => {
    try {
        const { reason, notes } = req.body;
        
        if (!reason?.trim()) {
            return res.status(400).json({ success: false, message: 'El motivo de baja es requerido' });
        }

        const { error } = await supabase.from('patients').update({
            is_active: false,
            discharge_date: new Date().toISOString(),
            discharge_reason: reason.trim(),
            discharge_notes: notes?.trim() || null
        }).eq('id', req.params.id);

        if (error) throw error;
        res.json({ success: true, message: 'Paciente dado de baja exitosamente' });
    } catch (error) {
        console.error('Error al dar de baja:', error);
        res.status(500).json({ success: false, message: 'Error al dar de baja al paciente' });
    }
});

app.patch('/api/patients/:id/reactivate', authenticateToken, [
    param('id').isUUID(),
    handleValidationErrors
], async (req, res) => {
    try {
        const { error } = await supabase.from('patients').update({
            is_active: true,
            discharge_date: null,
            discharge_reason: null,
            discharge_notes: null
        }).eq('id', req.params.id);

        if (error) throw error;
        res.json({ success: true, message: 'Paciente reactivado exitosamente' });
    } catch (error) {
        console.error('Error al reactivar:', error);
        res.status(500).json({ success: false, message: 'Error al reactivar paciente' });
    }
});

// ==========================================
// 5. EDUCACIÓN
// ==========================================
app.get('/api/education/topics', authenticateToken, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('education_topics')
            .select(`*, professionals!education_topics_created_by_fkey(full_name, document_number, professional_card)`)
            .order('created_at', { ascending: false });
            
        if (error) throw error;
        res.json({ success: true, data: data || [] });
    } catch (error) {
        console.error('Error en educación:', error);
        res.status(500).json({ success: false, message: 'Error al obtener temas educativos' });
    }
});

app.post('/api/education/topics', authenticateToken, [
    body('title').trim().notEmpty().withMessage('El título es requerido'),
    handleValidationErrors
], async (req, res) => {
    try {
        const { title, description, responsibleId } = req.body;

        const { error } = await supabase.from('education_topics').insert([{
            title: title.trim(),
            description: description?.trim() || 'Sin descripción',
            created_by: responsibleId || req.user?.id || null
        }]);

        if (error) throw error;
        res.json({ success: true, message: 'Tema educativo creado exitosamente' });
    } catch (error) {
        console.error('Error al crear tema:', error);
        res.status(500).json({ success: false, message: 'Error al crear tema educativo' });
    }
});

// ==========================================
// 6. AUXILIAR - TURNOS Y REGISTROS
// ==========================================
app.get('/api/auxiliar/patients', authenticateToken, async (req, res) => {
    try {
        let { data, error } = await supabase
            .from('patients')
            .select(`*, altitude_profiles(city_name, spo2_min_normal), clinical_records(created_at, spo2, glucose, eva_score, glasgow_eyes, glasgow_verbal, glasgow_motor)`)
            .eq('is_active', true)
            .order('created_at', { ascending: false });

        if (error) {
            console.warn('⚠️ Join falló en auxiliar, usando fallback:', error.message);
            const fallback = await supabase
                .from('patients')
                .select('*')
                .eq('is_active', true)
                .order('created_at', { ascending: false });
            data = fallback.data;
            error = fallback.error;
        }

        if (error) throw error;

        if (data) {
            data.forEach(patient => {
                if (patient.clinical_records && Array.isArray(patient.clinical_records)) {
                    patient.clinical_records.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
                }
            });
        }

        res.json({ success: true, data: data || [] });
    } catch (error) {
        console.error('❌ Error en /api/auxiliar/patients:', error);
        res.status(500).json({ success: false, message: 'Error al obtener pacientes del auxiliar' });
    }
});

app.post('/api/shifts/start', authenticateToken, [
    body('patientId').isUUID().withMessage('ID de paciente inválido'),
    body('professionalId').isUUID().withMessage('ID de profesional inválido'),
    body('shiftType').trim().notEmpty().withMessage('Tipo de turno requerido'),
    handleValidationErrors
], async (req, res) => {
    try {
        const { 
            patientId, 
            professionalId, 
            shiftType, 
            patientStatus, 
            patientNotes, 
            customStartTime, 
            customEndTime 
        } = req.body;

        // Verificar que el paciente esté activo
        const { data: patient } = await supabase
            .from('patients')
            .select('is_active')
            .eq('id', patientId)
            .single();

        if (!patient) {
            return res.status(404).json({ success: false, message: 'Paciente no encontrado' });
        }
        if (!patient.is_active) {
            return res.status(400).json({ success: false, message: 'No se puede iniciar turno para un paciente inactivo' });
        }

        const { data, error } = await supabase.from('shifts').insert([{
            patient_id: patientId,
            professional_id: professionalId,
            shift_type: shiftType.trim(),
            start_time: customStartTime ? new Date(customStartTime).toISOString() : new Date().toISOString(),
            end_time: customEndTime ? new Date(customEndTime).toISOString() : null,
            patient_received_status: patientStatus?.trim() || null,
            patient_received_notes: patientNotes?.trim() || null,
            is_closed: false
        }]).select().single();

        if (error) throw error;
        res.json({ success: true, message: 'Turno iniciado exitosamente', data: { id: data.id } });
    } catch (error) {
        console.error('Error al iniciar turno:', error);
        res.status(500).json({ success: false, message: 'Error al iniciar turno' });
    }
});

app.post('/api/clinical-records', authenticateToken, [
    body('shiftId').isUUID(),
    body('patientId').isUUID(),
    body('professionalId').isUUID(),
    handleValidationErrors
], async (req, res) => {
    try {
        const {
            shiftId, patientId, professionalId,
            bloodPressure, heartRate, respiratoryRate,
            temperature, spo2, glucose,
            evaScore, consciousnessLevel,
            glasgowEyes, glasgowVerbal, glasgowMotor,
            bradenScore, bristolType,
            ppeUsed, wasteManagement,
            externalAccompaniment,
            activitiesCompleted,
            sbarSituation, sbarBackground,
            sbarAssessment, sbarRecommendation,
            notes
        } = req.body;

        // Validar Glasgow si se proporciona
        if ((glasgowEyes || glasgowVerbal || glasgowMotor) && 
            (glasgowEyes + glasgowVerbal + glasgowMotor > 15 || glasgowEyes + glasgowVerbal + glasgowMotor < 3)) {
            return res.status(400).json({ success: false, message: 'Puntuación de Glasgow inválida' });
        }

        const { data, error } = await supabase.from('clinical_records').insert([{
            shift_id: shiftId,
            patient_id: patientId,
            professional_id: professionalId,
            blood_pressure: bloodPressure?.trim() || null,
            heart_rate: heartRate !== null && heartRate !== undefined ? Number(heartRate) : null,
            respiratory_rate: respiratoryRate !== null && respiratoryRate !== undefined ? Number(respiratoryRate) : null,
            temperature: temperature !== null && temperature !== undefined ? Number(temperature) : null,
            spo2: spo2 !== null && spo2 !== undefined ? Number(spo2) : null,
            glucose: glucose !== null && glucose !== undefined ? Number(glucose) : null,
            eva_score: evaScore !== null && evaScore !== undefined ? Math.min(10, Math.max(0, Number(evaScore))) : 0,
            consciousness_level: consciousnessLevel?.trim() || null,
            glasgow_eyes: glasgowEyes !== null && glasgowEyes !== undefined ? Number(glasgowEyes) : null,
            glasgow_verbal: glasgowVerbal !== null && glasgowVerbal !== undefined ? Number(glasgowVerbal) : null,
            glasgow_motor: glasgowMotor !== null && glasgowMotor !== undefined ? Number(glasgowMotor) : null,
            braden_score: bradenScore !== null && bradenScore !== undefined ? Number(bradenScore) : null,
            bristol_type: bristolType !== null && bristolType !== undefined ? Number(bristolType) : null,
            ppe_used: ppeUsed || {},
            waste_management: wasteManagement || {},
            external_accompaniment: externalAccompaniment?.trim() || null,
            activities_completed: activitiesCompleted || {},
            sbar_situation: sbarSituation?.trim() || null,
            sbar_background: sbarBackground?.trim() || null,
            sbar_assessment: sbarAssessment?.trim() || null,
            sbar_recommendation: sbarRecommendation?.trim() || null,
            notes: notes?.trim() || null
        }]).select().single();

        if (error) throw error;
        res.json({ success: true, message: 'Registro clínico guardado exitosamente', data: { id: data.id } });
    } catch (error) {
        console.error('Error al guardar registro:', error);
        res.status(500).json({ success: false, message: 'Error al guardar registro clínico' });
    }
});

app.get('/api/patients/:id/daily-history', authenticateToken, [
    param('id').isUUID(),
    handleValidationErrors
], async (req, res) => {
    try {
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const [
            { data: records, error: err1 },
            { data: signatures, error: err2 }
        ] = await Promise.all([
            supabase
                .from('clinical_records')
                .select('*, professionals(full_name)')
                .eq('patient_id', req.params.id)
                .gte('created_at', today.toISOString())
                .order('created_at', { ascending: true }),
            supabase
                .from('shift_signatures')
                .select('*')
                .gte('created_at', today.toISOString())
        ]);

        if (err1) throw err1;
        if (err2) throw err2;

        res.json({ success: true, data: { records: records || [], signatures: signatures || [] } });
    } catch (error) {
        console.error('Error en historial diario:', error);
        res.status(500).json({ success: false, message: 'Error al obtener historial diario' });
    }
});

app.post('/api/shifts/close', authenticateToken, [
    body('shiftId').isUUID(),
    body('auxiliarySignature').notEmpty().withMessage('Firma del auxiliar requerida'),
    body('auxiliaryName').trim().notEmpty().withMessage('Nombre del auxiliar requerido'),
    body('auxiliaryIdNumber').trim().notEmpty().withMessage('Documento del auxiliar requerido'),
    handleValidationErrors
], async (req, res) => {
    try {
        const {
            shiftId, 
            patientDeliveredStatus, 
            patientDeliveredNotes, 
            pendingTasks, 
            pendingJustification,
            auxiliarySignature, 
            auxiliaryName, 
            auxiliaryIdNumber, 
            auxiliaryProfessionalCard,
            familySignature, 
            familyName, 
            familyIdNumber, 
            familyRelationship, 
            familyPhone
        } = req.body;

        // Verificar que el turno exista y no esté cerrado
        const { data: existingShift } = await supabase
            .from('shifts')
            .select('is_closed')
            .eq('id', shiftId)
            .single();

        if (!existingShift) {
            return res.status(404).json({ success: false, message: 'Turno no encontrado' });
        }
        if (existingShift.is_closed) {
            return res.status(400).json({ success: false, message: 'El turno ya está cerrado' });
        }

        await supabase.from('shifts').update({
            end_time: new Date().toISOString(),
            patient_delivered_status: patientDeliveredStatus?.trim() || null,
            patient_delivered_notes: patientDeliveredNotes?.trim() || null,
            pending_tasks: pendingTasks?.trim() || null,
            pending_justification: pendingJustification?.trim() || null,
            is_closed: true
        }).eq('id', shiftId);

        await supabase.from('shift_signatures').insert([{
            shift_id: shiftId,
            auxiliary_signature: auxiliarySignature,
            auxiliary_name: auxiliaryName.trim(),
            auxiliary_id_number: auxiliaryIdNumber.trim(),
            auxiliary_professional_card: auxiliaryProfessionalCard?.trim() || null,
            auxiliary_signed_at: new Date().toISOString(),
            family_signature: familySignature || null,
            family_name: familyName?.trim() || null,
            family_id_number: familyIdNumber?.trim() || null,
            family_relationship: familyRelationship?.trim() || null,
            family_phone: familyPhone?.trim() || null,
            family_signed_at: familySignature ? new Date().toISOString() : null
        }]);

        res.json({ success: true, message: 'Turno cerrado exitosamente', data: { shiftId } });
    } catch (error) {
        console.error('Error al cerrar turno:', error);
        res.status(500).json({ success: false, message: 'Error al cerrar turno' });
    }
});

app.get('/api/shifts/:shiftId/closure-data', authenticateToken, [
    param('shiftId').isUUID(),
    handleValidationErrors
], async (req, res) => {
    try {
        const { data: shift, error: shiftError } = await supabase
            .from('shifts')
            .select('*, patients(*, altitude_profiles(city_name, spo2_min_normal))')
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
            .eq('shift_id', req.params.shiftId)
            .order('created_at', { ascending: false })
            .limit(1);

        if (sigError) throw sigError;

        res.json({ success: true, data: { shift, records: records || [], signatures: signatures || [] } });
    } catch (error) {
        console.error('Error en datos de cierre:', error);
        res.status(500).json({ success: false, message: 'Error al obtener datos de cierre' });
    }
});

// ==========================================
// 7. INFORMES
// ==========================================
app.get('/api/reports/pending', authenticateToken, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('patients')
            .select('id, full_name, family_name, document_number')
            .eq('is_active', true)
            .order('full_name');

        if (error) throw error;
        res.json({ success: true, data: data || [] });
    } catch (error) {
        console.error('Error en reportes pendientes:', error);
        res.status(500).json({ success: false, message: 'Error al obtener pacientes para reportes' });
    }
});

app.get('/api/reports/:patientId/:month/:year', authenticateToken, [
    param('patientId').isUUID(),
    param('month').isInt({ min: 1, max: 12 }),
    param('year').isInt({ min: 2000, max: 2100 }),
    handleValidationErrors
], async (req, res) => {
    try {
        const { patientId, month, year } = req.params;
        const monthNum = parseInt(month);
        const yearNum = parseInt(year);

        const { data: patient, error: patientError } = await supabase
            .from('patients')
            .select('*, altitude_profiles(city_name, spo2_min_normal)')
            .eq('id', patientId)
            .single();

        if (patientError || !patient) {
            return res.status(404).json({ success: false, message: 'Paciente no encontrado' });
        }

        const startDate = `${year}-${String(monthNum).padStart(2, '0')}-01T00:00:00.000Z`;
        const endDate = new Date(yearNum, monthNum, 0, 23, 59, 59).toISOString();

        const { data: records, error: recordsError } = await supabase
            .from('clinical_records')
            .select('*, professionals(full_name, document_number)')
            .eq('patient_id', patientId)
            .gte('created_at', startDate)
            .lte('created_at', endDate)
            .order('created_at', { ascending: true });

        if (recordsError) throw recordsError;

        const stats = { 
            totalRecords: 0, 
            avgSpo2: 0, 
            avgHR: 0, 
            avgTemp: 0, 
            avgGlucose: 0,
            criticalAlerts: 0,
            evaScores: []
        };

        if (records && records.length > 0) {
            stats.totalRecords = records.length;
            let spo2Sum = 0, hrSum = 0, tempSum = 0, glucoseSum = 0;
            let spo2Count = 0, hrCount = 0, tempCount = 0, glucoseCount = 0;

            records.forEach(record => {
                if (record.spo2 !== null && record.spo2 !== undefined) { 
                    spo2Sum += Number(record.spo2); 
                    spo2Count++; 
                }
                if (record.heart_rate !== null && record.heart_rate !== undefined) { 
                    hrSum += Number(record.heart_rate); 
                    hrCount++; 
                }
                if (record.temperature !== null && record.temperature !== undefined) { 
                    tempSum += Number(record.temperature); 
                    tempCount++; 
                }
                if (record.glucose !== null && record.glucose !== undefined && record.glucose > 0) { 
                    glucoseSum += Number(record.glucose); 
                    glucoseCount++; 
                }
                if (record.eva_score !== null && record.eva_score !== undefined) {
                    stats.evaScores.push(Number(record.eva_score));
                }

                // Alertas críticas mejoradas
                const spo2Min = patient?.altitude_profiles?.spo2_min_normal || 95;
                const isCriticalSpo2 = record.spo2 !== null && record.spo2 < (spo2Min - 3);
                const isCriticalGlucoseHigh = record.glucose !== null && record.glucose > 200;
                const isCriticalGlucoseLow = record.glucose !== null && record.glucose > 0 && record.glucose < 60;
                const isCriticalHR = record.heart_rate !== null && (record.heart_rate < 40 || record.heart_rate > 150);
                const isCriticalTemp = record.temperature !== null && (record.temperature < 35 || record.temperature > 39.5);

                if (isCriticalSpo2 || isCriticalGlucoseHigh || isCriticalGlucoseLow || isCriticalHR || isCriticalTemp) {
                    stats.criticalAlerts++;
                }
            });

            if (spo2Count > 0) stats.avgSpo2 = Math.round(spo2Sum / spo2Count);
            if (hrCount > 0) stats.avgHR = Math.round(hrSum / hrCount);
            if (tempCount > 0) stats.avgTemp = parseFloat((tempSum / tempCount).toFixed(1));
            if (glucoseCount > 0) stats.avgGlucose = Math.round(glucoseSum / glucoseCount);
        }

        res.json({ success: true, data: { patient, records: records || [], stats } });
    } catch (error) {
        console.error('Error en reporte mensual:', error);
        res.status(500).json({ success: false, message: 'Error al generar reporte' });
    }
});

// ==========================================
// 8. NOTAS DE EVOLUCIÓN PROFESIONALES
// ==========================================
app.post('/api/professional-records', authenticateToken, [
    body('patientId').isUUID(),
    body('professionalId').isUUID(),
    handleValidationErrors
], async (req, res) => {
    try {
        const { 
            patientId, 
            professionalId, 
            shiftId, 
            recordType, 
            weight, 
            height, 
            imc, 
            vitalSigns, 
            subjective, 
            objective, 
            analysis, 
            plan, 
            photoData, 
            professionalSignature, 
            familySignature, 
            familyName, 
            familyId 
        } = req.body;

        // Validar IMC calculado
        if (weight && height) {
            const calculatedImc = weight / ((height / 100) ** 2);
            if (imc && Math.abs(imc - calculatedImc) > 0.5) {
                console.warn('⚠️ IMC proporcionado no coincide con el calculado');
            }
        }

        const { data, error } = await supabase.from('professional_records').insert([{
            patient_id: patientId,
            professional_id: professionalId,
            shift_id: shiftId || null,
            record_type: recordType?.trim() || 'Nota de Evolución',
            weight: weight !== null && weight !== undefined ? Number(weight) : null,
            height: height !== null && height !== undefined ? Number(height) : null,
            imc: imc !== null && imc !== undefined ? Number(imc) : null,
            vital_signs: vitalSigns || {},
            subjective: subjective?.trim() || null,
            objective: objective?.trim() || null,
            analysis: analysis?.trim() || null,
            plan: plan?.trim() || null,
            photo_data: photoData || null,
            professional_signature: professionalSignature || null,
            family_signature: familySignature || null,
            family_name: familyName?.trim() || null,
            family_id: familyId?.trim() || null
        }]).select().single();

        if (error) throw error;
        res.json({ success: true, message: 'Nota de evolución guardada exitosamente', data: { id: data.id } });
    } catch (error) {
        console.error('Error al guardar nota profesional:', error);
        res.status(500).json({ success: false, message: 'Error al guardar nota de evolución' });
    }
});

// ==========================================
// 9. HEALTH CHECK
// ==========================================
app.get('/api/health', (req, res) => {
    res.json({ 
        success: true, 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        version: '2.0.0'
    });
});

// ==========================================
// SERVIDOR DE ARCHIVOS ESTÁTICOS
// ==========================================
app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    } else {
        res.status(404).json({ success: false, message: 'Endpoint no encontrado' });
    }
});

// Manejador de errores global
app.use((err, req, res, next) => {
    console.error('Error no manejado:', err);
    res.status(500).json({ 
        success: false, 
        message: process.env.NODE_ENV === 'production' 
            ? 'Error interno del servidor' 
            : err.message 
    });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor VitalCare API corriendo en puerto ${PORT}`);
    console.log(`📅 ${new Date().toLocaleString('es-CO')}`);
});

export default app;
