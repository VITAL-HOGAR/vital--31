import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import jwt from 'jsonwebtoken';

// ==========================================
// CONFIGURACIÓN INICIAL
// ==========================================
dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 10000;

// ==========================================
// CONEXIÓN A SUPABASE
// ==========================================
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ==========================================
// MIDDLEWARE
// ==========================================
app.use(cors({
    origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : '*',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ==========================================
// SERVIR ARCHIVOS ESTÁTICOS
// ==========================================
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// LOGGING (SOLO EN DESARROLLO)
// ==========================================
if (process.env.NODE_ENV !== 'production') {
    app.use((req, res, next) => {
        console.log(`📝 ${req.method} ${req.url}`);
        next();
    });
}

// ==========================================
// RUTA DE SALUD
// ==========================================
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || 'development'
    });
});

// ==========================================
// API DE AUTENTICACIÓN - VERSIÓN CORREGIDA
// ==========================================
app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        // Validar que los campos no estén vacíos
        if (!email || !password) {
            return res.status(400).json({
                success: false,
                message: 'Email y contraseña son obligatorios'
            });
        }

        // 1. Intentar autenticar con Supabase Auth
        const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
            email: email.trim().toLowerCase(),
            password: password
        });

        if (authError) {
            console.error('❌ Error de autenticación:', authError.message);
            
            // Verificar si el error es por credenciales inválidas
            if (authError.message.includes('Invalid login credentials')) {
                return res.status(401).json({
                    success: false,
                    message: 'Credenciales inválidas. Verifique su email y contraseña.'
                });
            }
            
            return res.status(401).json({
                success: false,
                message: authError.message || 'Error de autenticación'
            });
        }

        if (!authData || !authData.user) {
            return res.status(401).json({
                success: false,
                message: 'No se pudo autenticar el usuario'
            });
        }

        console.log('✅ Usuario autenticado en Auth. UID:', authData.user.id);

        // 2. Buscar datos del usuario en la tabla 'users'
        const { data: userData, error: userError } = await supabase
            .from('users')
            .select('id, name, email, role, cedula, rethus, status, created_at')
            .eq('id', authData.user.id)
            .single();

        if (userError || !userData) {
            console.error('❌ Error buscando usuario en tabla users:', userError);
            console.error('   ID buscado:', authData.user.id);
            
            // Si el usuario existe en Auth pero no en nuestra tabla, lo creamos
            if (userError && userError.code === 'PGRST116') {
                // Intentar crear el usuario en la tabla
                const { data: newUser, error: createError } = await supabase
                    .from('users')
                    .insert([{
                        id: authData.user.id,
                        email: authData.user.email,
                        name: authData.user.email.split('@')[0],
                        role: 'AUXILIAR',
                        status: 'ACTIVE',
                        created_at: new Date().toISOString()
                    }])
                    .select('id, name, email, role, cedula, rethus, status, created_at')
                    .single();

                if (createError) {
                    console.error('❌ Error creando usuario:', createError);
                    return res.status(500).json({
                        success: false,
                        message: 'Error creando perfil de usuario'
                    });
                }

                // Generar token para el nuevo usuario
                const token = jwt.sign(
                    { id: newUser.id, role: newUser.role },
                    process.env.JWT_SECRET,
                    { expiresIn: '24h' }
                );

                return res.json({
                    success: true,
                    message: 'Usuario creado automáticamente',
                    data: { user: newUser, token }
                });
            }

            return res.status(404).json({
                success: false,
                message: 'Usuario no encontrado en la base de datos'
            });
        }

        // Verificar que el usuario esté activo
        if (userData.status !== 'ACTIVE') {
            return res.status(403).json({
                success: false,
                message: 'Usuario inactivo. Contacte al administrador.'
            });
        }

        // 3. Generar Token JWT
        const token = jwt.sign(
            { 
                id: userData.id, 
                role: userData.role,
                email: userData.email 
            },
            process.env.JWT_SECRET,
            { expiresIn: '24h' }
        );

        // 4. Registrar el login en auditoría (opcional)
        try {
            await supabase
                .from('audit_logs')
                .insert([{
                    user_id: userData.id,
                    action: 'LOGIN',
                    details: { email: userData.email, timestamp: new Date().toISOString() }
                }]);
        } catch (auditError) {
            console.warn('⚠️ No se pudo registrar auditoría:', auditError.message);
        }

        res.json({
            success: true,
            message: 'Login exitoso',
            data: {
                user: userData,
                token
            }
        });

    } catch (error) {
        console.error('❌ Error en login:', error);
        res.status(500).json({
            success: false,
            message: 'Error interno del servidor',
            ...(process.env.NODE_ENV === 'development' && { details: error.message })
        });
    }
});

// ==========================================
// API DE REGISTRO DE USUARIOS
// ==========================================
app.post('/api/auth/register', async (req, res) => {
    try {
        const { email, password, name, role, cedula, rethus } = req.body;

        // Validaciones básicas
        if (!email || !password || !name) {
            return res.status(400).json({
                success: false,
                message: 'Email, contraseña y nombre son obligatorios'
            });
        }

        if (password.length < 6) {
            return res.status(400).json({
                success: false,
                message: 'La contraseña debe tener al menos 6 caracteres'
            });
        }

        // 1. Registrar en Supabase Auth
        const { data: authData, error: authError } = await supabase.auth.signUp({
            email: email.trim().toLowerCase(),
            password: password,
            options: {
                data: {
                    name: name,
                    role: role || 'AUXILIAR'
                }
            }
        });

        if (authError) {
            console.error('❌ Error registrando en Auth:', authError);
            return res.status(400).json({
                success: false,
                message: authError.message || 'Error registrando usuario'
            });
        }

        if (!authData || !authData.user) {
            return res.status(500).json({
                success: false,
                message: 'No se pudo crear el usuario'
            });
        }

        // 2. Crear perfil en la tabla 'users'
        const { data: userData, error: userError } = await supabase
            .from('users')
            .insert([{
                id: authData.user.id,
                email: email.trim().toLowerCase(),
                name: name.trim(),
                role: role || 'AUXILIAR',
                cedula: cedula || null,
                rethus: rethus || null,
                status: 'ACTIVE',
                created_at: new Date().toISOString()
            }])
            .select('id, name, email, role, cedula, rethus, status, created_at')
            .single();

        if (userError) {
            console.error('❌ Error creando perfil:', userError);
            // Si falla la creación del perfil, intentar eliminar el usuario de Auth
            await supabase.auth.admin.deleteUser(authData.user.id);
            return res.status(500).json({
                success: false,
                message: 'Error creando perfil de usuario'
            });
        }

        // 3. Generar token
        const token = jwt.sign(
            { id: userData.id, role: userData.role },
            process.env.JWT_SECRET,
            { expiresIn: '24h' }
        );

        res.status(201).json({
            success: true,
            message: 'Usuario registrado exitosamente',
            data: { user: userData, token }
        });

    } catch (error) {
        console.error('❌ Error en registro:', error);
        res.status(500).json({
            success: false,
            message: 'Error interno del servidor'
        });
    }
});

// ==========================================
// API DE VERIFICACIÓN DE TOKEN
// ==========================================
app.post('/api/auth/verify', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        
        if (!token) {
            return res.status(401).json({
                success: false,
                message: 'Token no proporcionado'
            });
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        
        // Verificar que el usuario aún existe y está activo
        const { data: userData, error: userError } = await supabase
            .from('users')
            .select('id, name, email, role, status')
            .eq('id', decoded.id)
            .single();

        if (userError || !userData) {
            return res.status(401).json({
                success: false,
                message: 'Usuario no encontrado'
            });
        }

        if (userData.status !== 'ACTIVE') {
            return res.status(403).json({
                success: false,
                message: 'Usuario inactivo'
            });
        }

        res.json({
            success: true,
            message: 'Token válido',
            data: { user: userData }
        });

    } catch (error) {
        if (error.name === 'JsonWebTokenError') {
            return res.status(401).json({
                success: false,
                message: 'Token inválido'
            });
        }
        if (error.name === 'TokenExpiredError') {
            return res.status(401).json({
                success: false,
                message: 'Token expirado'
            });
        }
        console.error('❌ Error verificando token:', error);
        res.status(500).json({
            success: false,
            message: 'Error interno del servidor'
        });
    }
});

// ==========================================
// API DE CIERRE DE SESIÓN
// ==========================================
app.post('/api/auth/logout', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        
        if (token) {
            // Registrar logout en auditoría
            try {
                const decoded = jwt.decode(token);
                if (decoded && decoded.id) {
                    await supabase
                        .from('audit_logs')
                        .insert([{
                            user_id: decoded.id,
                            action: 'LOGOUT',
                            details: { timestamp: new Date().toISOString() }
                        }]);
                }
            } catch (auditError) {
                console.warn('⚠️ No se pudo registrar logout:', auditError.message);
            }
        }

        res.json({
            success: true,
            message: 'Sesión cerrada exitosamente'
        });

    } catch (error) {
        console.error('❌ Error en logout:', error);
        res.status(500).json({
            success: false,
            message: 'Error interno del servidor'
        });
    }
});

// ==========================================
// MANEJAR RUTAS QUE NO SON API - FRONTEND
// ==========================================
app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    }
});

// ==========================================
// MANEJADOR GLOBAL DE ERRORES
// ==========================================
app.use((err, req, res, next) => {
    console.error('❌ Error no controlado:', err);
    res.status(err.status || 500).json({
        success: false,
        message: err.message || 'Error interno del servidor',
        ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
    });
});

// ==========================================
// INICIO DEL SERVIDOR
// ==========================================
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log('==================================================');
    console.log('🚀 Servidor Monolítico Vivo');
    console.log(`📡 Puerto: ${PORT}`);
    console.log(`🌐 URL: http://localhost:${PORT}`);
    console.log(`🔒 Modo: ${process.env.NODE_ENV || 'development'}`);
    console.log('==================================================');
    console.log('📋 Endpoints disponibles:');
    console.log(`  POST /api/auth/login    - Iniciar sesión`);
    console.log(`  POST /api/auth/register - Registrar usuario`);
    console.log(`  POST /api/auth/verify   - Verificar token`);
    console.log(`  POST /api/auth/logout   - Cerrar sesión`);
    console.log(`  GET  /health            - Health check`);
    console.log(`  GET  /*                 - Frontend (index.html)`);
    console.log('==================================================');
});

// ==========================================
// MANEJO DE SEÑALES
// ==========================================
process.on('SIGTERM', () => {
    console.log('🛑 Señal SIGTERM recibida, cerrando servidor...');
    server.close(() => {
        console.log('✅ Servidor cerrado correctamente');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('🛑 Señal SIGINT recibida, cerrando servidor...');
    server.close(() => {
        console.log('✅ Servidor cerrado correctamente');
        process.exit(0);
    });
});

// ==========================================
// MANEJO DE ERRORES NO CAPTURADOS
// ==========================================
process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);
    // En producción, no matar el proceso
    if (process.env.NODE_ENV !== 'production') {
        process.exit(1);
    }
});

export default app;
