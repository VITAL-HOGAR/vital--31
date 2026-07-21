import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 10000;
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

app.use(cors());
app.use(express.json());

// ESTA LÍNEA SIRVE TU CARPETA PUBLIC (DONDE ESTÁ EL INDEX.HTML)
app.use(express.static(path.join(__dirname, 'public')));

// RUTA DE LOGIN
app.post('/api/auth/login', async (req, res) => {
    console.log('🔍 Login recibido');
    const { email, password } = req.body;
    
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return res.json({ success: false, message: 'Error Auth: ' + error.message });
    
    const { data: profile } = await supabase.from('professionals').select('*').eq('user_id', data.user.id).single();
    if (!profile) return res.json({ success: false, message: 'Perfil no encontrado en DB' });
    
    res.json({ success: true, user: profile });
});

// SI NO ES UNA API, MUESTRA EL INDEX.HTML
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});
