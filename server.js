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
// Asegúrate de que esta variable esté en Render
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        // 1. Login Auth
        const { data: authData, error: authError } = await supabase.auth.signInWithPassword({ email, password });
        if (authError) return res.json({ success: false, message: 'Auth Error: ' + authError.message });

        console.log('UID del usuario:', authData.user.id);

        // 2. Consulta directa a la tabla
        const { data: profile, error: dbError } = await supabase
            .from('professionals')
            .select('*')
            .eq('user_id', authData.user.id)
            .single();

        if (dbError) {
            console.error('❌ ERROR SUPABASE DETALLADO:', dbError);
            return res.json({ success: false, message: 'DB Error: ' + dbError.message + ' | Code: ' + dbError.code });
        }

        if (!profile) {
            return res.json({ success: false, message: 'Usuario existe en Auth pero no en tabla Professionals.' });
        }

        res.json({ success: true, user: profile });

    } catch (err) {
        res.json({ success: false, message: 'Catch Error: ' + err.message });
    }
});

app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => { console.log(`🚀 Vivo en ${PORT}`); });
export default app;
