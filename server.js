import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import jwt from 'jsonwebtoken';

// Configuración inicial
dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 10000;

// Conexión a Supabase (Usando la clave maestra service_role)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Middleware
app.use(cors({ origin: '*' })); // Permitimos conexiones desde cualquier lugar
app.use(express.json({ limit: '50mb' })); // Para recibir datos grandes como fotos o PDFs base64

// ==========================================
// 1. SERVIR EL FRONTEND (Tu index.html maestro)
// ==========================================
app.use(express.static(path.join(__dirname, 'public')));

// Cualquier ruta que no sea API, enviará el index.html
app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    }
});

// ==========================================
// 2. API DE AUTENTICACIÓN
// ==========================================
app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        // Validar con Supabase Auth
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error || !data.user) return res.status(401).json({ success: false, message: 'Credenciales inválidas' });

        // Buscar datos extra del usuario
        const { data: userData } = await supabase.from('users').select('*').eq('id', data.user.id).single();
        if (!userData) return res.status(404).json({ success: false, message: 'Usuario no encontrado en DB' });

        // Generar Token JWT
        const token = jwt.sign({ id: userData.id, role: userData.role }, process.env.JWT_SECRET, { expiresIn: '24h' });
        
        res.json({ success: true, data: { user: userData, token } });
    } catch (e) {
        console.error('Error Login:', e);
        res.status(500).json({ success: false, message: 'Error interno del servidor' });
    }
});

// ==========================================
// 3. INICIO DEL SERVIDOR
// ==========================================
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor Monolítico Vivo en puerto ${PORT}`);
    console.log(`🌐 URL: https://vital-hogar-31.onrender.com`);
});
