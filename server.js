import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 10000;

// ============================================================
// CONFIGURACIÓN DE SUPABASE
// ============================================================
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error('❌ ERROR: Faltan variables de entorno SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// ============================================================
// MIDDLEWARE
// ============================================================
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// MIDDLEWARE DE AUTENTICACIÓN
// ============================================================
const authenticateToken = async (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) {
        return res.status(401).json({ success: false, message: 'Token no proporcionado' });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'vitalhogar_secret_key_2026');
        req.user = decoded;
        next();
    } catch (error) {
        return res.status(403).json({ success: false, message: 'Token inválido o expirado' });
    }
};

const requireAdmin = (req, res, next) => {
    if (!req.user || req.user.role !== 'ADMINISTRACION') {
        return res.status(403).json({ success: false, message: 'Acceso denegado. Se requiere rol de Administrador.' });
    }
    next();
};

// ============================================================
// RUTAS DE AUTENTICACIÓN
// ============================================================
app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ 
                success: false, 
                message: 'Email y contraseña son obligatorios' 
            });
        }

        // Buscar usuario en Supabase Auth
        const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
            email,
            password
        });

        if (authError || !authData.user) {
            return res.status(401).json({ 
                success: false, 
                message: 'Credenciales inválidas' 
            });
        }

        // Obtener perfil del profesional
        const { data: profData, error: profError } = await supabase
            .from('professionals')
            .select(`
                id,
                user_id,
                full_name,
                document_number,
                specialty_id,
                card_expiry_date,
                signature_data,
                is_active,
                specialties (
                    id,
                    name
                )
            `)
            .eq('user_id', authData.user.id)
            .single();

        if (profError || !profData) {
            return res.status(404).json({ 
                success: false, 
                message: 'Perfil profesional no encontrado' 
            });
        }

        if (!profData.is_active) {
            return res.status(403).json({ 
                success: false, 
                message: 'Usuario inactivo. Contacte al administrador.' 
            });
        }

        // Generar JWT
        const token = jwt.sign(
            { 
                id: profData.id, 
                user_id: profData.user_id,
                role: profData.specialties?.name || 'USER',
                full_name: profData.full_name
            },
            process.env.JWT_SECRET || 'vitalhogar_secret_key_2026',
            { expiresIn: '24h' }
        );

        res.json({
            success: true,
            data: {
                user: {
                    id: profData.id,
                    full_name: profData.full_name,
                    email: authData.user.email,
                    document_number: profData.document_number,
                    specialties: profData.specialties,
                    card_expiry_date: profData.card_expiry_date,
                    is_active: profData.is_active
                },
                token
            }
        });

    } catch (error) {
        console.error('❌ Error en login:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Error interno del servidor' 
        });
    }
});

app.post('/api/auth/register', async (req, res) => {
    try {
        const { email, password, fullName, documentNumber, specialtyName, cardExpiry, signature } = req.body;

        // Validaciones
        if (!email || !password || !fullName || !documentNumber || !specialtyName) {
            return res.status(400).json({
                success: false,
                message: 'Todos los campos son obligatorios'
            });
        }

        // Verificar si el email ya existe
        const { data: existingUser } = await supabase
            .from('professionals')
            .select('user_id')
            .eq('email', email)
            .single();

        if (existingUser) {
            return res.status(400).json({
                success: false,
                message: 'El email ya está registrado'
            });
        }

        // Crear usuario en Supabase Auth
        const { data: authUser, error: authError } = await supabase.auth.admin.createUser({
            email,
            password,
            email_confirm: true,
            user_metadata: {
                full_name: fullName,
                document_number: documentNumber
            }
        });

        if (authError) {
            console.error('❌ Error creando usuario Auth:', authError);
            return res.status(400).json({
                success: false,
                message: authError.message || 'Error creando usuario'
            });
        }

        // Obtener ID de especialidad
        const { data: specData, error: specError } = await supabase
            .from('specialties')
            .select('id')
            .eq('name', specialtyName)
            .single();

        if (specError || !specData) {
            // Si no existe la especialidad, crearla
            const { data: newSpec, error: createSpecError } = await supabase
                .from('specialties')
                .insert([{ name: specialtyName }])
                .select()
                .single();

            if (createSpecError) {
                console.error('❌ Error creando especialidad:', createSpecError);
                return res.status(500).json({
                    success: false,
                    message: 'Error creando especialidad'
                });
            }
            specData = newSpec;
        }

        // Crear perfil profesional
        const { error: profError } = await supabase
            .from('professionals')
            .insert([{
                user_id: authUser.user.id,
                full_name: fullName,
                document_number: documentNumber,
                specialty_id: specData.id,
                card_expiry_date: cardExpiry || null,
                signature_data: signature || null,
                is_active: true,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            }]);

        if (profError) {
            console.error('❌ Error creando profesional:', profError);
            // Si falla, eliminar el usuario creado
            await supabase.auth.admin.deleteUser(authUser.user.id);
            return res.status(500).json({
                success: false,
                message: 'Error creando perfil profesional'
            });
        }

        res.json({
            success: true,
            message: '✅ Profesional registrado exitosamente',
            data: {
                user_id: authUser.user.id,
                email
            }
        });

    } catch (error) {
        console.error('❌ Error en registro:', error);
        res.status(500).json({
            success: false,
            message: 'Error interno del servidor'
        });
    }
});

// ============================================================
// RUTAS DE DASHBOARD
// ============================================================
app.get('/api/dashboard/stats', authenticateToken, async (req, res) => {
    try {
        // Contar pacientes activos
        const { count: patients, error: patError } = await supabase
            .from('patients')
            .select('*', { count: 'exact', head: true })
            .eq('is_active', true);

        if (patError) throw patError;

        // Contar profesionales activos
        const { count: professionals, error: profError } = await supabase
            .from('professionals')
            .select('*', { count: 'exact', head: true })
            .eq('is_active', true);

        if (profError) throw profError;

        // Obtener alertas de vencimiento
        const today = new Date().toISOString().split('T')[0];
        const thirtyDaysFromNow = new Date();
        thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30);
        const futureDate = thirtyDaysFromNow.toISOString().split('T')[0];

        const { data: expiringCards, error: alertError } = await supabase
            .from('professionals')
            .select('full_name, card_expiry_date, specialties(name)')
            .not('card_expiry_date', 'is', null)
            .lt('card_expiry_date', futureDate)
            .order('card_expiry_date', { ascending: true });

        if (alertError) throw alertError;

        const alerts = expiringCards?.map(p => ({
            message: `${p.full_name} - ${p.specialties?.name || 'Profesional'} - Tarjeta vence: ${p.card_expiry_date}`,
            expiry_date: p.card_expiry_date
        })) || [];

        res.json({
            success: true,
            data: {
                patients: patients || 0,
                professionals: professionals || 0,
                alerts
            }
        });

    } catch (error) {
        console.error('❌ Error en dashboard:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Error obteniendo estadísticas'
        });
    }
});

// ============================================================
// RUTAS DE PROFESIONALES
// ============================================================
app.get('/api/professionals', authenticateToken, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('professionals')
            .select(`
                id,
                user_id,
                full_name,
                document_number,
                specialty_id,
                card_expiry_date,
                signature_data,
                is_active,
                created_at,
                updated_at,
                specialties (
                    id,
                    name
                )
            `)
            .order('created_at', { ascending: false });

        if (error) throw error;

        res.json({
            success: true,
            data: data || []
        });

    } catch (error) {
        console.error('❌ Error cargando profesionales:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Error cargando profesionales'
        });
    }
});

app.post('/api/professionals', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const {
            fullName,
            documentNumber,
            email,
            password,
            specialtyName,
            cardExpiry,
            signature
        } = req.body;

        // Validaciones
        if (!fullName || !documentNumber || !email || !password || !specialtyName) {
            return res.status(400).json({
                success: false,
                message: 'Todos los campos son obligatorios'
            });
        }

        // Verificar si el email ya existe
        const { data: existingUser } = await supabase
            .from('professionals')
            .select('user_id')
            .eq('email', email)
            .single();

        if (existingUser) {
            return res.status(400).json({
                success: false,
                message: 'El email ya está registrado'
            });
        }

        // Crear usuario en Supabase Auth
        const { data: authUser, error: authError } = await supabase.auth.admin.createUser({
            email,
            password,
            email_confirm: true,
            user_metadata: {
                full_name: fullName,
                document_number: documentNumber
            }
        });

        if (authError) {
            console.error('❌ Error creando usuario Auth:', authError);
            return res.status(400).json({
                success: false,
                message: authError.message || 'Error creando usuario'
            });
        }

        // Obtener o crear especialidad
        let { data: specData, error: specError } = await supabase
            .from('specialties')
            .select('id')
            .eq('name', specialtyName)
            .single();

        if (specError) {
            const { data: newSpec, error: createSpecError } = await supabase
                .from('specialties')
                .insert([{ name: specialtyName }])
                .select()
                .single();

            if (createSpecError) {
                console.error('❌ Error creando especialidad:', createSpecError);
                return res.status(500).json({
                    success: false,
                    message: 'Error creando especialidad'
                });
            }
            specData = newSpec;
        }

        // Crear perfil profesional
        const { error: profError } = await supabase
            .from('professionals')
            .insert([{
                user_id: authUser.user.id,
                full_name: fullName,
                document_number: documentNumber,
                specialty_id: specData.id,
                card_expiry_date: cardExpiry || null,
                signature_data: signature || null,
                is_active: true,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            }]);

        if (profError) {
            console.error('❌ Error creando profesional:', profError);
            await supabase.auth.admin.deleteUser(authUser.user.id);
            return res.status(500).json({
                success: false,
                message: 'Error creando perfil profesional'
            });
        }

        res.json({
            success: true,
            message: '✅ Profesional registrado exitosamente',
            data: {
                user_id: authUser.user.id,
                email
            }
        });

    } catch (error) {
        console.error('❌ Error creando profesional:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Error interno del servidor'
        });
    }
});

app.patch('/api/professionals/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { isActive } = req.body;

        if (typeof isActive !== 'boolean') {
            return res.status(400).json({
                success: false,
                message: 'El campo isActive debe ser booleano'
            });
        }

        const { error } = await supabase
            .from('professionals')
            .update({
                is_active: isActive,
                updated_at: new Date().toISOString()
            })
            .eq('id', id);

        if (error) throw error;

        res.json({
            success: true,
            message: `Profesional ${isActive ? 'activado' : 'desactivado'} exitosamente`
        });

    } catch (error) {
        console.error('❌ Error actualizando profesional:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Error actualizando profesional'
        });
    }
});

app.delete('/api/professionals/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        // Obtener el user_id antes de eliminar
        const { data: prof, error: getError } = await supabase
            .from('professionals')
            .select('user_id')
            .eq('id', id)
            .single();

        if (getError) throw getError;

        // Eliminar perfil profesional
        const { error: profError } = await supabase
            .from('professionals')
            .delete()
            .eq('id', id);

        if (profError) throw profError;

        // Eliminar usuario de Auth
        if (prof.user_id) {
            await supabase.auth.admin.deleteUser(prof.user_id);
        }

        res.json({
            success: true,
            message: 'Profesional eliminado exitosamente'
        });

    } catch (error) {
        console.error('❌ Error eliminando profesional:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Error eliminando profesional'
        });
    }
});

// ============================================================
// RUTAS DE PACIENTES
// ============================================================
app.get('/api/patients', authenticateToken, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('patients')
            .select(`
                id,
                full_name,
                document_number,
                pathology,
                address,
                city_id,
                family_name,
                family_id,
                family_relationship,
                contact_phone,
                is_active,
                created_at,
                updated_at,
                altitude_profiles (
                    id,
                    city_name,
                    altitude
                )
            `)
            .order('created_at', { ascending: false });

        if (error) throw error;

        res.json({
            success: true,
            data: data || []
        });

    } catch (error) {
        console.error('❌ Error cargando pacientes:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Error cargando pacientes'
        });
    }
});

app.post('/api/patients', authenticateToken, async (req, res) => {
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

        if (!fullName || !familyName) {
            return res.status(400).json({
                success: false,
                message: 'Nombre del paciente y familiar son obligatorios'
            });
        }

        // Obtener o crear ciudad
        let cityId = null;
        if (cityName) {
            const { data: cityData, error: cityError } = await supabase
                .from('altitude_profiles')
                .select('id')
                .eq('city_name', cityName)
                .single();

            if (cityError) {
                // Crear la ciudad si no existe
                const { data: newCity, error: createCityError } = await supabase
                    .from('altitude_profiles')
                    .insert([{ city_name: cityName }])
                    .select()
                    .single();

                if (!createCityError && newCity) {
                    cityId = newCity.id;
                }
            } else {
                cityId = cityData.id;
            }
        }

        const { error } = await supabase
            .from('patients')
            .insert([{
                full_name: fullName,
                document_number: documentNumber || null,
                city_id: cityId,
                pathology: pathology || null,
                address: address || null,
                contact_phone: contactPhone || null,
                family_name: familyName,
                family_id: familyId || null,
                family_relationship: familyRel || null,
                is_active: true,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            }]);

        if (error) throw error;

        res.json({
            success: true,
            message: '✅ Paciente registrado exitosamente'
        });

    } catch (error) {
        console.error('❌ Error creando paciente:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Error creando paciente'
        });
    }
});

app.patch('/api/patients/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const updates = req.body;

        const { error } = await supabase
            .from('patients')
            .update({
                ...updates,
                updated_at: new Date().toISOString()
            })
            .eq('id', id);

        if (error) throw error;

        res.json({
            success: true,
            message: 'Paciente actualizado exitosamente'
        });

    } catch (error) {
        console.error('❌ Error actualizando paciente:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Error actualizando paciente'
        });
    }
});

// ============================================================
// RUTAS DE EDUCACIÓN
// ============================================================
app.get('/api/education/topics', authenticateToken, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('education_topics')
            .select(`
                id,
                title,
                description,
                created_by,
                created_at,
                updated_at,
                professionals:created_by (
                    full_name,
                    specialties (
                        name
                    )
                )
            `)
            .order('created_at', { ascending: false });

        if (error) throw error;

        res.json({
            success: true,
            data: data || []
        });

    } catch (error) {
        console.error('❌ Error cargando temas:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Error cargando temas educativos'
        });
    }
});

app.post('/api/education/topics', authenticateToken, async (req, res) => {
    try {
        const { title, description, responsibleId } = req.body;

        if (!title || !responsibleId) {
            return res.status(400).json({
                success: false,
                message: 'Título y responsable son obligatorios'
            });
        }

        const { error } = await supabase
            .from('education_topics')
            .insert([{
                title,
                description: description || '',
                created_by: responsibleId,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            }]);

        if (error) throw error;

        res.json({
            success: true,
            message: '✅ Tema educativo creado exitosamente'
        });

    } catch (error) {
        console.error('❌ Error creando tema:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Error creando tema educativo'
        });
    }
});

app.patch('/api/education/topics/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const { title, description } = req.body;

        const { error } = await supabase
            .from('education_topics')
            .update({
                title,
                description,
                updated_at: new Date().toISOString()
            })
            .eq('id', id);

        if (error) throw error;

        res.json({
            success: true,
            message: 'Tema educativo actualizado exitosamente'
        });

    } catch (error) {
        console.error('❌ Error actualizando tema:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Error actualizando tema'
        });
    }
});

app.delete('/api/education/topics/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;

        const { error } = await supabase
            .from('education_topics')
            .delete()
            .eq('id', id);

        if (error) throw error;

        res.json({
            success: true,
            message: 'Tema educativo eliminado exitosamente'
        });

    } catch (error) {
        console.error('❌ Error eliminando tema:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Error eliminando tema'
        });
    }
});

// ============================================================
// RUTA DE PRUEBA
// ============================================================
app.get('/api/health', (req, res) => {
    res.json({
        success: true,
        status: 'healthy',
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || 'development'
    });
});

// ============================================================
// MANEJO DE RUTAS NO ENCONTRADAS
// ============================================================
app.use('/api/*', (req, res) => {
    res.status(404).json({
        success: false,
        message: `Ruta no encontrada: ${req.originalUrl}`
    });
});

// ============================================================
// SERVIDOR DE ARCHIVOS ESTÁTICOS (SINGLE PAGE APPLICATION)
// ============================================================
app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    }
});

// ============================================================
// INICIO DEL SERVIDOR
// ============================================================
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Vital Hogar Pro Servidor ejecutándose en puerto ${PORT}`);
    console.log(`🌐 URL: http://localhost:${PORT}`);
    console.log(`📡 API Health: http://localhost:${PORT}/api/health`);
});

// Manejo de errores no capturados
process.on('uncaughtException', (error) => {
    console.error('❌ Error no capturado:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Promesa rechazada no manejada:', reason);
});

export default app;
