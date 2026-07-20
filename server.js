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

// LOGIN CON DIAGNÓSTICO
app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        console.log('🔍 Intento de login para:', email);
        
        // 1. Auth
        const { data: authData, error: authError } = await supabase.auth.signInWithPassword({ email, password });
        
        if (authError || !authData.user) {
            console.log('❌ Error Auth:', authError?.message);
            return res.status(401).json({ success: false, message: 'Credenciales inválidas' });
        }

        console.log('✅ Auth Exitoso. UID:', authData.user.id);

        // 2. Buscar Perfil
        const { data: profData, error: profError } = await supabase
            .from('professionals')
            .select('*, specialties(name)')
            .eq('user_id', authData.user.id)
            .single();

        console.log('📂 Resultado búsqueda DB:', profData);
        console.log('⚠️ Error DB:', profError);

        if (!profData) {
            return res.status(404).json({ success: false, message: 'Perfil no encontrado. Contacte al Admin.' });
        }

        // 3. Token
        const token = jwt.sign({ 
            id: profData.id, 
            role: profData.specialties?.name || 'USER',
            specialtyId: profData.specialty_id 
        }, process.env.JWT_SECRET, { expiresIn: '24h' });

        res.json({ success: true, data: { user: profData, token } });

    } catch (error) {
        console.error('💥 Error Crítico:', error);
        res.status(500).json({ success: false, message: 'Error interno' });
    }
});

// CREAR PROFESIONAL
app.post('/api/professionals', async (req, res) => {
    try {
        const { email, password, fullName, documentNumber, specialtyName, cardExpiry, signature } = req.body;
        
        const { data: specData } = await supabase.from('specialties').select('id').eq('name', specialtyName).single();
        if (!specData) return res.status(400).json({ success: false, message: 'Especialidad no válida' });

        const { data: authUser, error: authErr } = await supabase.auth.admin.createUser({
            email, password, email_confirm: true
        });
        if (authErr) throw authErr;

        await supabase.from('professionals').insert([{
            user_id: authUser.user.id,
            full_name: fullName,
            document_number: documentNumber,
            specialty_id: specData.id,
            card_expiry_date: cardExpiry,
            signature_data: signature,
            is_active: true
        }]);

        res.json({ success: true, message: 'Profesional creado' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor Vivo en ${PORT}`);
});

export default app;
