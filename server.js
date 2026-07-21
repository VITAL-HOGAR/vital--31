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

// Configuración Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error('❌ ERROR: Faltan variables de entorno SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// Middleware
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// 1. AUTENTICACIÓN
// ==========================================
app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        // Validación básica
        if (!email || !password) {
            return res.status(400).json({ 
                success: false, 
                message: 'Email y contraseña son requeridos' 
            });
        }

        // Autenticación
        const { data: authData, error: authError } = await supabase.auth.signInWithPassword({ 
            email, 
            password 
        });

        if (authError || !authData?.user) {
            console.error('Error de autenticación:', authError);
            return res.status(401).json({ 
                success: false, 
                message: 'Credenciales inválidas' 
            });
        }

        // Obtener perfil del profesional
        const { data: profData, error: profError } = await supabase
            .from('professionals')
            .select('*, specialties(name)')
            .eq('user_id', authData.user.id)
            .single();

        if (profError || !profData) {
            console.error('Error al obtener perfil:', profError);
            return res.status(404).json({ 
                success: false, 
                message: 'Perfil no encontrado. Contacte al administrador.' 
            });
        }

        // Generar token JWT
        const token = jwt.sign(
            { 
                id: profData.id, 
                role: profData.specialty_id,
                email: authData.user.email 
            }, 
            process.env.JWT_SECRET || 'secreto_vital_temporal', 
            { expiresIn: '24h' }
        );

        res.json({ 
            success: true, 
            data: { 
                user: profData, 
                token 
            } 
        });
    } catch (error) {
        console.error('Error en login:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Error interno del servidor' 
        });
    }
});

// ==========================================
// 2. DASHBOARD
// ==========================================
app.get('/api/dashboard/stats', async (req, res) => {
    try {
        // Obtener conteo de pacientes activos
        const { count: patCount, error: patError } = await supabase
            .from('patients')
            .select('*', { count: 'exact', head: true })
            .eq('is_active', true);

        if (patError) throw patError;

        // Obtener conteo de profesionales activos
        const { count: profCount, error: profError } = await supabase
            .from('professionals')
            .select('*', { count: 'exact', head: true })
            .eq('is_active', true);

        if (profError) throw profError;

        // Obtener conteo de sesiones educativas del mes actual
        const firstDayOfMonth = new Date();
        firstDayOfMonth.setDate(1);
        firstDayOfMonth.setHours(0, 0, 0, 0);

        const { count: eduCount, error: eduError } = await supabase
            .from('education_topics')
            .select('*', { count: 'exact', head: true })
            .gte('created_at', firstDayOfMonth.toISOString());

        if (eduError) throw eduError;

        // Obtener conteo de reportes pendientes (pacientes activos)
        const { count: pendingReports, error: reportError } = await supabase
            .from('patients')
            .select('*', { count: 'exact', head: true })
            .eq('is_active', true);

        if (reportError) throw reportError;

        res.json({ 
            success: true, 
            data: {
                patients: patCount || 0,
                professionals: profCount || 0,
                educationSessions: eduCount || 0,
                pendingReports: pendingReports || 0
            }
        });
    } catch (error) {
        console.error('Error en dashboard stats:', error);
        res.status(500).json({ 
            success: false, 
            message: error.message || 'Error al obtener estadísticas' 
        });
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
        console.error('Error al obtener profesionales:', error);
        res.status(500).json({ 
            success: false, 
            message: error.message || 'Error al obtener profesionales' 
        });
    }
});

app.post('/api/professionals', async (req, res) => {
    try {
        const { email, password, fullName, documentNumber, specialtyName, signature, professionalCard } = req.body;

        // Validación de datos requeridos
        if (!email || !password || !fullName || !documentNumber || !specialtyName) {
            return res.status(400).json({
                success: false,
                message: 'Todos los campos son requeridos'
            });
        }

        // Obtener ID de la especialidad
        const { data: specData, error: specError } = await supabase
            .from('specialties')
            .select('id')
            .eq('name', specialtyName)
            .single();

        if (specError || !specData) {
            return res.status(400).json({ 
                success: false, 
                message: 'Especialidad no válida' 
            });
        }

        // Crear usuario en Auth
        const { data: authUser, error: authError } = await supabase.auth.admin.createUser({
            email,
            password,
            email_confirm: true
        });

        if (authError) {
            console.error('Error al crear usuario:', authError);
            return res.status(400).json({
                success: false,
                message: authError.message || 'Error al crear usuario'
            });
        }

        if (!authUser?.user) {
            return res.status(500).json({
                success: false,
                message: 'No se pudo crear el usuario'
            });
        }

        // Crear perfil del profesional
        const { error: insertError } = await supabase
            .from('professionals')
            .insert([{
                user_id: authUser.user.id,
                full_name: fullName,
                document_number: documentNumber,
                specialty_id: specData.id,
                signature_data: signature || null,
                professional_card: professionalCard || null,
                is_active: true
            }]);

        if (insertError) {
            console.error('Error al insertar profesional:', insertError);
            // Intentar eliminar el usuario creado
            await supabase.auth.admin.deleteUser(authUser.user.id);
            return res.status(500).json({
                success: false,
                message: insertError.message || 'Error al registrar profesional'
            });
        }

        res.json({ 
            success: true, 
            message: 'Profesional registrado exitosamente' 
        });
    } catch (error) {
        console.error('Error en registro profesional:', error);
        res.status(500).json({ 
            success: false, 
            message: error.message || 'Error interno del servidor' 
        });
    }
});

app.patch('/api/professionals/:id/deactivate', async (req, res) => {
    try {
        const { isActive } = req.body;
        const professionalId = req.params.id;

        if (typeof isActive !== 'boolean') {
            return res.status(400).json({
                success: false,
                message: 'isActive debe ser un valor booleano'
            });
        }

        const { error } = await supabase
            .from('professionals')
            .update({ is_active: isActive })
            .eq('id', professionalId);

        if (error) throw error;

        res.json({ 
            success: true, 
            message: isActive ? 'Profesional reactivado' : 'Profesional desactivado' 
        });
    } catch (error) {
        console.error('Error al cambiar estado profesional:', error);
        res.status(500).json({ 
            success: false, 
            message: error.message || 'Error al cambiar estado' 
        });
    }
});

// ==========================================
// 4. PACIENTES
// ==========================================
app.get('/api/patients', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('patients')
            .select('*, altitude_profiles(city_name)')
            .order('created_at', { ascending: false });

        if (error) throw error;

        res.json({ success: true, data: data || [] });
    } catch (error) {
        console.error('Error al obtener pacientes:', error);
        res.status(500).json({ 
            success: false, 
            message: error.message || 'Error al obtener pacientes' 
        });
    }
});

app.post('/api/patients', async (req, res) => {
    try {
        const { fullName, documentNumber, cityName, pathology, address, contactPhone, familyName, familyId, familyRel } = req.body;

        // Validación de datos requeridos
        if (!fullName || !documentNumber) {
            return res.status(400).json({
                success: false,
                message: 'Nombre completo y número de documento son requeridos'
            });
        }

        // Obtener ID de la ciudad
        let cityId = null;
        if (cityName) {
            const { data: cityData, error: cityError } = await supabase
                .from('altitude_profiles')
                .select('id')
                .eq('city_name', cityName)
                .single();

            if (!cityError && cityData) {
                cityId = cityData.id;
            }
        }

        const { error } = await supabase
            .from('patients')
            .insert([{
                full_name: fullName,
                document_number: documentNumber,
                city_id: cityId,
                pathology_summary: pathology || null,
                address: address || null,
                contact_phone: contactPhone || null,
                family_name: familyName || null,
                family_id_number: familyId || null,
                family_relationship: familyRel || null,
                is_active: true
            }]);

        if (error) throw error;

        res.json({ 
            success: true, 
            message: 'Paciente registrado exitosamente' 
        });
    } catch (error) {
        console.error('Error al registrar paciente:', error);
        res.status(500).json({ 
            success: false, 
            message: error.message || 'Error al registrar paciente' 
        });
    }
});

app.patch('/api/patients/:id/discharge', async (req, res) => {
    try {
        const { reason, notes } = req.body;
        const patientId = req.params.id;

        if (!reason) {
            return res.status(400).json({
                success: false,
                message: 'La razón de baja es requerida'
            });
        }

        const { error } = await supabase
            .from('patients')
            .update({
                is_active: false,
                discharge_date: new Date().toISOString(),
                discharge_reason: reason,
                discharge_notes: notes || null
            })
            .eq('id', patientId);

        if (error) throw error;

        res.json({ 
            success: true, 
            message: 'Paciente dado de baja exitosamente' 
        });
    } catch (error) {
        console.error('Error al dar de baja paciente:', error);
        res.status(500).json({ 
            success: false, 
            message: error.message || 'Error al dar de baja' 
        });
    }
});

app.patch('/api/patients/:id/reactivate', async (req, res) => {
    try {
        const patientId = req.params.id;

        const { error } = await supabase
            .from('patients')
            .update({
                is_active: true,
                discharge_date: null,
                discharge_reason: null,
                discharge_notes: null
            })
            .eq('id', patientId);

        if (error) throw error;

        res.json({ 
            success: true, 
            message: 'Paciente reactivado exitosamente' 
        });
    } catch (error) {
        console.error('Error al reactivar paciente:', error);
        res.status(500).json({ 
            success: false, 
            message: error.message || 'Error al reactivar' 
        });
    }
});

// ==========================================
// 5. EDUCACIÓN
// ==========================================
app.get('/api/education/topics', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('education_topics')
            .select('*, professionals!education_topics_created_by_fkey(full_name)')
            .order('created_at', { ascending: false });

        if (error) throw error;

        res.json({ success: true, data: data || [] });
    } catch (error) {
        console.error('Error al obtener temas educativos:', error);
        res.status(500).json({ 
            success: false, 
            message: error.message || 'Error al obtener temas' 
        });
    }
});

app.post('/api/education/topics', async (req, res) => {
    try {
        const { title, description, responsibleId } = req.body;

        if (!title || !description) {
            return res.status(400).json({
                success: false,
                message: 'Título y descripción son requeridos'
            });
        }

        const { error } = await supabase
            .from('education_topics')
            .insert([{
                title,
                description,
                created_by: responsibleId || null
            }]);

        if (error) throw error;

        res.json({ 
            success: true, 
            message: 'Tema educativo creado exitosamente' 
        });
    } catch (error) {
        console.error('Error al crear tema educativo:', error);
        res.status(500).json({ 
            success: false, 
            message: error.message || 'Error al crear tema' 
        });
    }
});

// ==========================================
// 6. AUXILIAR - TURNOS Y REGISTROS
// ==========================================
app.get('/api/auxiliar/patients', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('patients')
            .select(`
                *,
                altitude_profiles(city_name, spo2_min_normal),
                clinical_records!inner(
                    created_at,
                    spo2,
                    glucose,
                    eva_score,
                    glasgow_eyes,
                    glasgow_verbal,
                    glasgow_motor
                )
            `)
            .eq('is_active', true)
            .order('created_at', { ascending: false });

        if (error) throw error;

        // Ordenar registros clínicos por fecha (más reciente primero)
        if (data) {
            data.forEach(patient => {
                if (patient.clinical_records) {
                    patient.clinical_records.sort((a, b) => 
                        new Date(b.created_at) - new Date(a.created_at)
                    );
                }
            });
        }

        res.json({ success: true, data: data || [] });
    } catch (error) {
        console.error('Error al obtener pacientes para auxiliar:', error);
        res.status(500).json({ 
            success: false, 
            message: error.message || 'Error al obtener pacientes' 
        });
    }
});

app.post('/api/shifts/start', async (req, res) => {
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

        if (!patientId || !professionalId || !shiftType) {
            return res.status(400).json({
                success: false,
                message: 'Paciente, profesional y tipo de turno son requeridos'
            });
        }

        const { data, error } = await supabase
            .from('shifts')
            .insert([{
                patient_id: patientId,
                professional_id: professionalId,
                shift_type: shiftType,
                start_time: customStartTime ? new Date(customStartTime).toISOString() : new Date().toISOString(),
                end_time: customEndTime ? new Date(customEndTime).toISOString() : null,
                patient_received_status: patientStatus || null,
                patient_received_notes: patientNotes || null,
                is_closed: false
            }])
            .select()
            .single();

        if (error) throw error;

        res.json({ 
            success: true, 
            message: 'Turno iniciado exitosamente',
            data: { id: data.id }
        });
    } catch (error) {
        console.error('Error al iniciar turno:', error);
        res.status(500).json({ 
            success: false, 
            message: error.message || 'Error al iniciar turno' 
        });
    }
});

app.post('/api/clinical-records', async (req, res) => {
    try {
        const {
            shiftId,
            patientId,
            professionalId,
            bloodPressure,
            heartRate,
            respiratoryRate,
            temperature,
            spo2,
            glucose,
            evaScore,
            consciousnessLevel,
            glasgowEyes,
            glasgowVerbal,
            glasgowMotor,
            bradenScore,
            bristolType,
            ppeUsed,
            wasteManagement,
            externalAccompaniment,
            activitiesCompleted,
            sbarSituation,
            sbarBackground,
            sbarAssessment,
            sbarRecommendation,
            notes
        } = req.body;

        if (!shiftId || !patientId || !professionalId) {
            return res.status(400).json({
                success: false,
                message: 'ShiftId, patientId y professionalId son requeridos'
            });
        }

        const { data, error } = await supabase
            .from('clinical_records')
            .insert([{
                shift_id: shiftId,
                patient_id: patientId,
                professional_id: professionalId,
                blood_pressure: bloodPressure || null,
                heart_rate: heartRate || null,
                respiratory_rate: respiratoryRate || null,
                temperature: temperature || null,
                spo2: spo2 || null,
                glucose: glucose || null,
                eva_score: evaScore || null,
                consciousness_level: consciousnessLevel || null,
                glasgow_eyes: glasgowEyes || null,
                glasgow_verbal: glasgowVerbal || null,
                glasgow_motor: glasgowMotor || null,
                braden_score: bradenScore || null,
                bristol_type: bristolType || null,
                ppe_used: ppeUsed || null,
                waste_management: wasteManagement || null,
                external_accompaniment: externalAccompaniment || null,
                activities_completed: activitiesCompleted || null,
                sbar_situation: sbarSituation || null,
                sbar_background: sbarBackground || null,
                sbar_assessment: sbarAssessment || null,
                sbar_recommendation: sbarRecommendation || null,
                notes: notes || null
            }])
            .select()
            .single();

        if (error) throw error;

        res.json({ 
            success: true, 
            message: 'Registro clínico guardado exitosamente',
            data: { id: data.id }
        });
    } catch (error) {
        console.error('Error al guardar registro clínico:', error);
        res.status(500).json({ 
            success: false, 
            message: error.message || 'Error al guardar registro' 
        });
    }
});

app.get('/api/patients/:id/daily-history', async (req, res) => {
    try {
        const patientId = req.params.id;
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        // Obtener registros clínicos del día
        const { data: records, error: err1 } = await supabase
            .from('clinical_records')
            .select('*, professionals(full_name)')
            .eq('patient_id', patientId)
            .gte('created_at', today.toISOString())
            .order('created_at', { ascending: true });

        if (err1) throw err1;

        // Obtener firmas del día
        const { data: signatures, error: err2 } = await supabase
            .from('shift_signatures')
            .select('*')
            .gte('created_at', today.toISOString());

        if (err2) throw err2;

        res.json({ 
            success: true, 
            data: {
                records: records || [],
                signatures: signatures || []
            }
        });
    } catch (error) {
        console.error('Error al obtener historial diario:', error);
        res.status(500).json({ 
            success: false, 
            message: error.message || 'Error al obtener historial' 
        });
    }
});

app.post('/api/shifts/close', async (req, res) => {
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

        if (!shiftId || !auxiliarySignature || !auxiliaryName || !auxiliaryIdNumber) {
            return res.status(400).json({
                success: false,
                message: 'Datos de cierre incompletos'
            });
        }

        // Cerrar el turno
        const { error: shiftError } = await supabase
            .from('shifts')
            .update({
                end_time: new Date().toISOString(),
                patient_delivered_status: patientDeliveredStatus || null,
                patient_delivered_notes: patientDeliveredNotes || null,
                pending_tasks: pendingTasks || null,
                pending_justification: pendingJustification || null,
                is_closed: true
            })
            .eq('id', shiftId);

        if (shiftError) throw shiftError;

        // Registrar firmas
        const { error: signatureError } = await supabase
            .from('shift_signatures')
            .insert([{
                clinical_record_id: null,
                auxiliary_signature: auxiliarySignature,
                auxiliary_name: auxiliaryName,
                auxiliary_id_number: auxiliaryIdNumber,
                auxiliary_professional_card: auxiliaryProfessionalCard || null,
                auxiliary_signed_at: new Date().toISOString(),
                family_signature: familySignature || null,
                family_name: familyName || null,
                family_id_number: familyIdNumber || null,
                family_relationship: familyRelationship || null,
                family_phone: familyPhone || null,
                family_signed_at: familySignature ? new Date().toISOString() : null
            }]);

        if (signatureError) throw signatureError;

        res.json({ 
            success: true, 
            message: 'Turno cerrado exitosamente',
            data: { shiftId }
        });
    } catch (error) {
        console.error('Error al cerrar turno:', error);
        res.status(500).json({ 
            success: false, 
            message: error.message || 'Error al cerrar turno' 
        });
    }
});

app.get('/api/shifts/:shiftId/closure-data', async (req, res) => {
    try {
        const shiftId = req.params.shiftId;

        // Obtener datos del turno
        const { data: shift, error: shiftError } = await supabase
            .from('shifts')
            .select('*, patients(*, altitude_profiles(city_name))')
            .eq('id', shiftId)
            .single();

        if (shiftError) throw shiftError;

        // Obtener registros clínicos del turno
        const { data: records, error: recordsError } = await supabase
            .from('clinical_records')
            .select('*')
            .eq('shift_id', shiftId)
            .order('created_at', { ascending: true });

        if (recordsError) throw recordsError;

        // Obtener firmas del turno
        const { data: signatures, error: sigError } = await supabase
            .from('shift_signatures')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(1);

        if (sigError) throw sigError;

        res.json({ 
            success: true, 
            data: {
                shift,
                records: records || [],
                signatures: signatures || []
            }
        });
    } catch (error) {
        console.error('Error al obtener datos de cierre:', error);
        res.status(500).json({ 
            success: false, 
            message: error.message || 'Error al obtener datos' 
        });
    }
});

// ==========================================
// 7. INFORMES Y PDFs
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
        console.error('Error al obtener pacientes pendientes:', error);
        res.status(500).json({ 
            success: false, 
            message: error.message || 'Error al obtener datos' 
        });
    }
});

app.get('/api/reports/:patientId/:month/:year', async (req, res) => {
    try {
        const { patientId, month, year } = req.params;

        // Validar parámetros
        const monthNum = parseInt(month);
        const yearNum = parseInt(year);
        if (monthNum < 1 || monthNum > 12 || yearNum < 2000) {
            return res.status(400).json({
                success: false,
                message: 'Mes o año inválido'
            });
        }

        // Obtener datos del paciente
        const { data: patient, error: patientError } = await supabase
            .from('patients')
            .select('*, altitude_profiles(city_name)')
            .eq('id', patientId)
            .single();

        if (patientError || !patient) {
            return res.status(404).json({
                success: false,
                message: 'Paciente no encontrado'
            });
        }

        // Definir rango de fechas
        const startDate = `${year}-${month.padStart(2, '0')}-01T00:00:00.000Z`;
        const endDate = new Date(yearNum, monthNum, 0, 23, 59, 59).toISOString();

        // Obtener registros clínicos del período
        const { data: records, error: recordsError } = await supabase
            .from('clinical_records')
            .select('*, professionals(full_name)')
            .eq('patient_id', patientId)
            .gte('created_at', startDate)
            .lte('created_at', endDate)
            .order('created_at', { ascending: true });

        if (recordsError) throw recordsError;

        // Calcular estadísticas
        let stats = {
            totalRecords: 0,
            avgSpo2: 0,
            avgHR: 0,
            avgTemp: 0,
            criticalAlerts: 0
        };

        if (records && records.length > 0) {
            stats.totalRecords = records.length;
            let spo2Sum = 0, hrSum = 0, tempSum = 0;
            let spo2Count = 0, hrCount = 0, tempCount = 0;

            records.forEach(record => {
                if (record.spo2 !== null && record.spo2 !== undefined) {
                    spo2Sum += record.spo2;
                    spo2Count++;
                }
                if (record.heart_rate !== null && record.heart_rate !== undefined) {
                    hrSum += record.heart_rate;
                    hrCount++;
                }
                if (record.temperature !== null && record.temperature !== undefined) {
                    tempSum += record.temperature;
                    tempCount++;
                }

                // Alertas críticas
                const spo2Min = patient?.altitude_profiles?.spo2_min_normal || 95;
                if (record.spo2 < (spo2Min - 3) || 
                    record.glucose > 200 || 
                    (record.glucose < 60 && record.glucose > 0)) {
                    stats.criticalAlerts++;
                }
            });

            if (spo2Count > 0) stats.avgSpo2 = Math.round(spo2Sum / spo2Count);
            if (hrCount > 0) stats.avgHR = Math.round(hrSum / hrCount);
            if (tempCount > 0) stats.avgTemp = parseFloat((tempSum / tempCount).toFixed(1));
        }

        res.json({ 
            success: true, 
            data: {
                patient,
                records: records || [],
                stats
            }
        });
    } catch (error) {
        console.error('Error al generar informe:', error);
        res.status(500).json({ 
            success: false, 
            message: error.message || 'Error al generar informe' 
        });
    }
});

// ==========================================
// MANEJO DE ERRORES GLOBAL
// ==========================================
app.use((err, req, res, next) => {
    console.error('Error no manejado:', err);
    res.status(500).json({
        success: false,
        message: 'Error interno del servidor'
    });
});

// ==========================================
// SERVIDOR DE ARCHIVOS (AL FINAL ABSOLUTO)
// ==========================================
app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    } else {
        res.status(404).json({
            success: false,
            message: 'Endpoint no encontrado'
        });
    }
});

// Iniciar servidor
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Vital Hogar Pro Vivo en puerto ${PORT}`);
});

export default app;
