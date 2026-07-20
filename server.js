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
// API DE AUTENTICACIÓN
// ==========================================
app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const { data: authData, error: authError } = await supabase.auth.signInWithPassword({ email, password });
        
        if (authError || !authData.user) return res.status(401).json({ success: false, message: 'Credenciales inválidas' });

        const { data: profData } = await supabase
            .from('professionals')
            .select('*, specialties(name)')
            .eq('user_id', authData.user.id)
            .single();

        if (!profData) return res.status(404).json({ success: false, message: 'Perfil no encontrado.' });
        if (!profData.is_active) return res.status(403).json({ success: false, message: 'Usuario desactivado.' });

        const today = new Date();
        if (profData.card_expiry_date && new Date(profData.card_expiry_date) < today) {
            return res.status(403).json({ success: false, message: 'RETHUS/TP vencido.' });
        }

        const token = jwt.sign({ 
            id: profData.id, 
            role: profData.specialties?.name || 'USER',
            specialtyId: profData.specialty_id 
        }, process.env.JWT_SECRET, { expiresIn: '24h' });

        res.json({ success: true, data: { user: profData, token } });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Error interno' });
    }
});

// ==========================================
// API: GESTIÓN DE PROFESIONALES
// ==========================================
app.get('/api/professionals', async (req, res) => {
    try {
        const { data } = await supabase.from('professionals').select('*, specialties(name)').order('created_at', { ascending: false });
        res.json({ success: true, data });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.post('/api/professionals', async (req, res) => {
    try {
        const { email, password, fullName, documentNumber, specialtyName, cardExpiry, signature } = req.body;
        const { data: specData } = await supabase.from('specialties').select('id').eq('name', specialtyName).single();
        if (!specData) return res.status(400).json({ success: false, message: 'Especialidad no válida' });

        const { data: authUser, error: authErr } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
        if (authErr) throw authErr;

        await supabase.from('professionals').insert([{
            user_id: authUser.user.id, full_name: fullName, document_number: documentNumber,
            specialty_id: specData.id, card_expiry_date: cardExpiry, signature_data: signature, is_active: true
        }]);
        res.json({ success: true, message: 'Profesional creado' });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.patch('/api/professionals/:id', async (req, res) => {
    try {
        await supabase.from('professionals').update({ is_active: req.body.isActive }).eq('id', req.params.id);
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.put('/api/professionals/:id', async (req, res) => {
    try {
        const { fullName, documentNumber, specialtyName, cardExpiry } = req.body;
        let specId = null;
        if (specialtyName) {
            const { data: s } = await supabase.from('specialties').select('id').eq('name', specialtyName).single();
            if (s) specId = s.id;
        }
        const updateData = { full_name: fullName, document_number: documentNumber, card_expiry_date: cardExpiry };
        if (specId) updateData.specialty_id = specId;
        
        await supabase.from('professionals').update(updateData).eq('id', req.params.id);
        res.json({ success: true, message: 'Datos actualizados' });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.delete('/api/professionals/:id', async (req, res) => {
    try {
        const { data: prof } = await supabase.from('professionals').select('user_id').eq('id', req.params.id).single();
        await supabase.from('professionals').delete().eq('id', req.params.id);
        if (prof && prof.user_id) await supabase.auth.admin.deleteUser(prof.user_id);
        res.json({ success: true, message: 'Eliminado' });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// ==========================================
// API: GESTIÓN DE PACIENTES
// ==========================================
app.get('/api/patients', async (req, res) => {
    try {
        const { data } = await supabase.from('patients').select('*, altitude_profiles(city_name)').order('created_at', { ascending: false });
        res.json({ success: true, data });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.post('/api/patients', async (req, res) => {
    try {
        const { fullName, documentNumber, birthDate, cityName, pathology, address, contactPhone } = req.body;
        const { data: cityData } = await supabase.from('altitude_profiles').select('id').eq('city_name', cityName).single();
        if (!cityData) return res.status(400).json({ success: false, message: 'Ciudad no encontrada' });

        await supabase.from('patients').insert([{
            full_name: fullName, document_number: documentNumber, birth_date: birthDate,
            city_id: cityData.id, pathology_summary: pathology, address: address,
            contact_phone: contactPhone, is_active: true
        }]);
        res.json({ success: true, message: 'Paciente registrado' });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// Servir Frontend
app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Vital Hogar Pro Vivo en puerto ${PORT}`);
});

export default app;
