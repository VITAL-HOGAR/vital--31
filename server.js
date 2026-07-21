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
// RUTA DE LOGIN (LA QUE ESTABA FALLANDO)
// ==========================================
app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        console.log('🔍 Intento de login:', email);
        
        // 1. Verificar credenciales en Auth
        const { data: authData, error: authError } = await supabase.auth.signInWithPassword({ email, password });
        if (authError || !authData.user) {
            return res.status(401).json({ success: false, message: 'Credenciales inválidas' });
        }

        // 2. Buscar la ficha del profesional vinculada a ese usuario
        const { data: profData, error: profError } = await supabase
            .from('professionals')
            .select('*, specialties(name)')
            .eq('user_id', authData.user.id)
            .single();

        if (profError || !profData) {
            console.error('❌ Error buscando perfil:', profError);
            return res.status(404).json({ success: false, message: 'Perfil no encontrado en base de datos.' });
        }

        // 3. Generar token de acceso
        const token = jwt.sign({ 
            id: profData.id, 
            role: profData.specialties?.name 
        }, process.env.JWT_SECRET || 'secreto_vital_2026', { expiresIn: '24h' });

        res.json({ success: true, data: { user: profData, token } });
    } catch (error) { 
        console.error('💥 Error crítico:', error);
        res.status(500).json({ success: false, message: 'Error interno del servidor' }); 
    }
});

// Servir el Frontend
app.get('*', (req, res) => { 
    if (!req.path.startsWith('/api')) {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    }
});

app.listen(PORT, '0.0.0.0', () => { 
    console.log(`🚀 Servidor Vivo en puerto ${PORT}`); 
});

export default app;
