import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config();
const app = express();
const PORT = process.env.PORT || 10000;

// Configurar Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

app.use(cors());
app.use(express.json());

// RUTA DE PRUEBA (Si esta no responde, nada lo hará)
app.get('/api/health', (req, res) => {
    res.json({ status: 'VIVO', message: 'El servidor está funcionando' });
});

// RUTA DE LOGIN
app.post('/api/auth/login', async (req, res) => {
    console.log('🔍 Login recibido');
    const { email, password } = req.body;
    
    // Intento de login
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    
    if (error) return res.json({ success: false, message: 'Error Auth: ' + error.message });
    
    // Buscar perfil
    const { data: profile } = await supabase.from('professionals').select('*').eq('user_id', data.user.id).single();
    
    if (!profile) return res.json({ success: false, message: 'Perfil no encontrado en DB' });
    
    res.json({ success: true, user: profile });
});

app.listen(PORT, () => {
    console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});
