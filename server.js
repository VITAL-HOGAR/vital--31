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
// API DE AUTENTICACIÓN - VERSIÓN CORREGIDA Y SIMPLIFICADA
// ==========================================
app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        // 1. Autenticar
        const { data: authData, error: authError } = await supabase.auth.signInWithPassword({ email, password });
        if (authError || !authData.user) return res.status(401).json({ success: false, message: 'Credenciales inválidas' });

        // 2. Buscar en la tabla users
        let { data: userData } = await supabase.from('users').select('*').eq('id', authData.user.id).single();

        // 3. Si no existe, crearlo (Auto-registro)
        if (!userData) {
            console.log('Creando perfil para:', authData.user.email);
            
            const { data: newUser, error: createError } = await supabase
                .from('users')
                .insert({ 
                    id: authData.user.id, 
                    email: authData.user.email, 
                    name: 'Administrador', 
                    role: 'ADMIN', 
                    status: 'ACTIVE' 
                })
                .select()
                .single();

            if (createError) {
                console.error('Fallo al crear:', createError);
                return res.status(500).json({ success: false, message: 'Error creando perfil: ' + createError.message });
            }
            userData = newUser;
        }

        // 4. Generar Token
        const token = jwt.sign({ id: userData.id, role: userData.role }, process.env.JWT_SECRET, { expiresIn: '24h' });
        
        res.json({ success: true, data: { user: userData, token } });

    } catch (error) {
        console.error('Error crítico:', error);
        res.status(500).json({ success: false, message: 'Error interno' });
    }
});

        // 5. Registrar login en auditoría (opcional - no crítico)
        try {
            await supabase
                .from('audit_logs')
                .insert([{
                    user_id: userData.id,
                    action: 'LOGIN',
                    details: { 
                        email: userData.email, 
                        timestamp: new Date().toISOString(),
                        ip: req.ip || req.connection.remoteAddress
                    }
                }]);
        } catch (auditError) {
            console.warn('⚠️ No se pudo registrar auditoría:', auditError.message);
            // No fallamos la respuesta por esto
        }

        // 6. Respuesta exitosa
        res.json({
            success: true,
            message: 'Login exitoso',
            data: {
                user: {
                    id: userData.id,
                    name: userData.name,
                    email: userData.email,
                    role: userData.role,
                    cedula: userData.cedula || null,
                    rethus: userData.rethus || null,
                    status: userData.status
                },
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

        // Verificar si el email ya existe en la tabla users
        const { data: existingUser, error: checkError } = await supabase
            .from('users')
            .select('email')
            .eq('email', email.trim().toLowerCase())
            .maybeSingle();

        if (existingUser) {
            return res.status(409).json({
                success: false,
                message: 'El email ya está registrado'
            });
        }

        // 1. Registrar en Supabase Auth
        const { data: authData, error: authError } = await supabase.auth.signUp({
            email: email.trim().toLowerCase(),
            password: password,
            options: {
                data: {
                    name: name.trim(),
                    role: role || 'AUXILIAR'
                }
            }
        });

        if (authError) {
            console.error('❌ Error registrando en Auth:', authError);
            
            let message = 'Error registrando usuario';
            if (authError.message.includes('User already registered')) {
                message = 'El email ya está registrado en el sistema';
            } else if (authError.message) {
                message = authError.message;
            }
            
            return res.status(400).json({
                success: false,
                message: message
            });
        }

        if (!authData || !authData.user) {
            return res.status(500).json({
                success: false,
                message: 'No se pudo crear el usuario en el sistema de autenticación'
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
            // Intentar eliminar el usuario de Auth si falla la creación del perfil
            try {
                await supabase.auth.admin.deleteUser(authData.user.id);
            } catch (deleteError) {
                console.warn('⚠️ No se pudo eliminar usuario de Auth:', deleteError);
            }
            return res.status(500).json({
                success: false,
                message: 'Error creando perfil de usuario: ' + userError.message
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
            data: { 
                user: {
                    id: userData.id,
                    name: userData.name,
                    email: userData.email,
                    role: userData.role,
                    cedula: userData.cedula,
                    rethus: userData.rethus,
                    status: userData.status
                }, 
                token 
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
                message: 'Token expirado, por favor inicie sesión nuevamente'
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
                            details: { 
                                timestamp: new Date().toISOString(),
                                ip: req.ip || req.connection.remoteAddress
                            }
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
