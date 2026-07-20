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

// LOGIN
app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const { data: authData, error: authError } = await supabase.auth.signInWithPassword({ email, password });
        if (authError || !authData.user) return res.status(401).json({ success: false, message: 'Credenciales inválidas' });
        
        const { data: profData } = await supabase.from('professionals').select('*, specialties(name)').eq('user_id', authData.user.id).single();
        if (!profData) return res.status(404).json({ success: false, message: 'Perfil no encontrado.' });
        
        const token = jwt.sign({ id: profData.id, role: profData.specialties?.name }, process.env.JWT_SECRET, { expiresIn: '24h' });
        res.json({ success: true, data: { user: profData, token } });
    } catch (error) { console.error(error); res.status(500).json({ success: false, message: 'Error interno' }); }
});

// DASHBOARD
app.get('/api/dashboard/stats', async (req, res) => {
    try {
        const { count: patCount } = await supabase.from('patients').select('*', { count: 'exact', head: true }).eq('is_active', true);
        const { count: profCount } = await supabase.from('professionals').select('*', { count: 'exact', head: true }).eq('is_active', true);
        res.json({ success: true, data: { patients: patCount, professionals: profCount, alerts: [] } });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// PROFESIONALES
app.get('/api/professionals', async (req, res) => {
    try {
        const { data, error } = await supabase.from('professionals').select('*, specialties(name)').order('created_at', { ascending: false });
        if (error) throw error;
        res.json({ success: true, data });
    } catch (error) { 
        console.error("Error cargando profesionales:", error);
        res.status(500).json({ success: false, message: error.message }); 
    }
});

app.post('/api/professionals', async (req, res) => {
    try {
        const { email, password, fullName, documentNumber, specialtyName, cardExpiry, signature } = req.body;
        const { data: specData } = await supabase.from('specialties').select('id').eq('name', specialtyName).single();
        if (!specData) throw new Error("Especialidad no encontrada");

        const { data: authUser, error: authErr } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
        if (authErr) throw authErr;

        const { error: dbErr } = await supabase.from('professionals').insert([{ 
            user_id: authUser.user.id, full_name: fullName, document_number: documentNumber, 
            specialty_id: specData.id, card_expiry_date: cardExpiry, signature_data: signature, is_active: true 
        }]);
        if (dbErr) throw dbErr;

        res.json({ success: true, message: 'Profesional registrado' });
    } catch (error) { 
        console.error("Error creando profesional:", error);
        res.status(500).json({ success: false, message: error.message }); 
    }
});

app.patch('/api/professionals/:id', async (req, res) => {
    await supabase.from('professionals').update({ is_active: req.body.isActive }).eq('id', req.params.id);
    res.json({ success: true });
});

// PACIENTES
app.get('/api/patients', async (req, res) => {
    const { data } = await supabase.from('patients').select('*').order('created_at', { ascending: false });
    res.json({ success: true, data });
});
app.post('/api/patients', async (req, res) => {
    try {
        const { fullName, cityName, familyName } = req.body;
        const { data: cityData } = await supabase.from('altitude_profiles').select('id').eq('city_name', cityName).single();
        await supabase.from('patients').insert([{
            full_name: fullName, city_id: cityData?.id, family_name: familyName, is_active: true
        }]);
        res.json({ success: true, message: 'Paciente registrado' });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// EDUCACIÓN
app.get('/api/education/topics', async (req, res) => {
    const { data } = await supabase.from('education_topics').select('*').order('created_at', { ascending: false });
    res.json({ success: true, data });
});

app.post('/api/education/topics', async (req, res) => {
    const { title, description, responsibleId } = req.body;
    await supabase.from('education_topics').insert([{ title, description, created_by: responsibleId }]);
    res.json({ success: true, message: 'Tema creado' });
});

app.get('*', (req, res) => { if (!req.path.startsWith('/api')) res.sendFile(path.join(__dirname, 'public', 'index.html')); });
app.listen(PORT, '0.0.0.0', () => { console.log(`🚀 Vital Hogar Pro Vivo en puerto ${PORT}`); });
export default app;
