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
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        // 1. Auth
        const { data: authData, error: authError } = await supabase.auth.signInWithPassword({ email, password });
        if (authError) return res.json({ success: false, message: 'Auth falló' });

        // 2. Buscar perfil (Consulta directa sin select específico)
        const { data: profile, error: profileError } = await supabase
            .from('professionals')
            .select('*')
            .eq('user_id', authData.user.id)
            .maybeSingle(); // maybeSingle evita errores si hay 0 o 1 resultado

        if (profileError) {
            console.error('ERROR DB:', profileError);
            return res.json({ success: false, message: 'Error DB: ' + profileError.message });
        }

        if (!profile) {
            return res.json({ success: false, message: 'No hay perfil para este usuario' });
        }

        res.json({ success: true, user: profile });

    } catch (err) {
        res.json({ success: false, message: 'Error interno: ' + err.message });
    }
});

app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => { console.log(`🚀 Vivo en ${PORT}`); });
export default app;
