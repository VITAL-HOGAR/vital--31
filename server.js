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

        // Buscar perfil con la relación de especialidad
        const { data: profData, error: profError } = await supabase
            .from('professionals')
            .select('*, specialties(name)')
            .eq('user_id', authData.user.id)
            .single();

        if (!profData) return res.status(404).json({ success: false, message: 'Perfil no encontrado.' });
        if (!profData.is_active) return res.status(403).json({ success: false, message: 'Usuario desactivado. Contacte al Admin.' });

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
// API: GESTIÓN DE PROFESIONALES (ADMIN)
// ==========================================

// 1. Listar Profesionales
app.get('/api/professionals', async (req, res) => {
    try {
        const { data, error } = await supabase.from('professionals').select('*, specialties(name)').order('created_at', { ascending: false });
        if (error) throw error;
        res.json({ success: true, data });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// 2. Crear Profesional
app.post('/api/professionals', async (req, res) => {
    try {
        const { email, password, fullName, documentNumber, specialtyName, cardExpiry, signature } = req.body;
        
        // Buscar ID de especialidad
        const { data: specData } = await supabase.from('specialties').select('id').eq('name', specialtyName).single();
        if (!specData) return res.status(400).json({ success: false, message: 'Especialidad no válida' });

        // Crear usuario en Auth
        const { data: authUser, error: authErr } = await supabase.auth.admin.createUser({
            email, password, email_confirm: true
        });
        if (authErr) throw authErr;

        // Guardar perfil
        const { error: dbErr } = await supabase.from('professionals').insert([{
            user_id: authUser.user.id,
            full_name: fullName,
            document_number: documentNumber,
            specialty_id: specData.id,
            card_expiry_date: cardExpiry,
            signature_data: signature,
            is_active: true
        }]);
        if (dbErr) throw dbErr;

        res.json({ success: true, message: 'Profesional creado exitosamente' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// 3. Cambiar Estado (Activar/Desactivar)
app.patch('/api/professionals/:id', async (req, res) => {
    try {
        const { isActive } = req.body;
        const { error } = await supabase.from('professionals').update({ is_active: isActive }).eq('id', req.params.id);
        if (error) throw error;
        res.json({ success: true, message: `Usuario ${isActive ? 'activado' : 'desactivado'}` });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Servir Frontend
app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Vital Hogar Pro Vivo en puerto ${PORT}`);
});

export default app;
