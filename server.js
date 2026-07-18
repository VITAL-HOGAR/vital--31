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
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Servir archivos estáticos (Tu Frontend)
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// API DE AUTENTICACIÓN (Lógica Blindada)
// ==========================================
app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        // 1. Validar credenciales en Supabase Auth
        const { data: authData, error: authError } = await supabase.auth.signInWithPassword({ email, password });
        
        if (authError || !authData.user) {
            return res.status(401).json({ success: false, message: 'Credenciales inválidas' });
        }

        console.log('✅ Auth exitoso para:', authData.user.email);

        // 2. Buscar perfil en la tabla 'users'
        let { data: userData } = await supabase
            .from('users')
            .select('*')
            .eq('id', authData.user.id)
            .single();

        // 3. Si no tiene perfil, lo creamos automáticamente (Auto-registro)
        if (!userData) {
            console.log('⚠️ Perfil no encontrado. Creando uno nuevo...');
            
            const { data: newUser, error: createError } = await supabase
                .from('users')
                .insert([{
                    id: authData.user.id,
                    email: authData.user.email,
                    name: 'Administrador', // Nombre por defecto
                    role: 'ADMIN',         // Rol por defecto
                    status: 'ACTIVE'
                }])
                .select()
                .single();

            if (createError) {
                console.error('❌ Error al crear perfil:', createError);
                return res.status(500).json({ success: false, message: 'Error creando perfil: ' + createError.message });
            }
            userData = newUser;
        }

        // 4. Generar Token JWT
        const token = jwt.sign(
            { id: userData.id, role: userData.role }, 
            process.env.JWT_SECRET, 
            { expiresIn: '24h' }
        );

        res.json({ success: true, data: { user: userData, token } });

    } catch (error) {
        console.error('❌ Error crítico en login:', error);
        res.status(500).json({ success: false, message: 'Error interno del servidor' });
    }
});

// ==========================================
// RUTA DE SALUD (Health Check)
// ==========================================
app.get('/health', (req, res) => {
    res.json({ status: 'Vivo', timestamp: new Date().toISOString() });
});

// ==========================================
// SERVIR FRONTEND (Catch-all)
// ==========================================
app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    }
});

// ==========================================
// INICIO DEL SERVIDOR
// ==========================================
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor Monolítico Vivo en puerto ${PORT}`);
});

export default app;
