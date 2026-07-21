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
        console.log(`🔍 Login intentado por: ${email}`);

        // 1. Autenticar
        const { data: authData, error: authError } = await supabase.auth.signInWithPassword({ email, password });
        if (authError) {
            console.error('❌ Error Auth:', authError.message);
            return res.status(401).json({ success: false, message: 'Credenciales inválidas' });
        }

        console.log('✅ Auth exitoso. UID:', authData.user.id);

        // 2. Buscar perfil (Sin relaciones complejas primero)
        const { data: profile, error: profileError } = await supabase
            .from('professionals')
            .select('*')
            .eq('user_id', authData.user.id)
            .single();

        if (profileError) {
            console.error('❌ Error buscando perfil:', profileError.message);
            return res.status(404).json({ success: false, message: 'Error de base de datos al buscar perfil.' });
        }

        if (!profile) {
            console.error('❌ No se encontró fila en professionals para este UID.');
            return res.status(404).json({ success: false, message: 'Perfil no encontrado en DB' });
        }

        console.log('✅ Perfil encontrado:', profile.full_name);
        res.json({ success: true, user: profile });

    } catch (err) {
        console.error('💥 Error crítico:', err);
        res.status(500).json({ success: false, message: 'Error interno' });
    }
});

app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Servidor Vivo en puerto ${PORT}`);
});
