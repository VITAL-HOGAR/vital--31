import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import jwt from 'jsonwebtoken';
import multer from 'multer';

// Configuración Inicial
dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 10000;
const upload = multer({ dest: 'uploads/' }); // Para futuras fotos

// Conexión a Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Middleware
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// API DE AUTENTICACIÓN Y ROLES
// ==========================================
app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        // 1. Auth con Supabase
        const { data: authData, error: authError } = await supabase.auth.signInWithPassword({ email, password });
        if (authError || !authData.user) return res.status(401).json({ success: false, message: 'Credenciales inválidas' });

        // 2. Buscar Perfil Profesional
        const { data: profData, error: profError } = await supabase
            .from('professionals')
            .select('*, specialties(name)')
            .eq('user_id', authData.user.id)
            .single();

        if (profError || !profData) return res.status(404).json({ success: false, message: 'Perfil no encontrado. Contacte al Admin.' });

        // 3. Validaciones de Seguridad (RETHUS y Estado)
        if (!profData.is_active) return res.status(403).json({ success: false, message: 'Usuario inactivo.' });
        
        const today = new Date();
        if (profData.card_expiry_date && new Date(profData.card_expiry_date) < today) {
            return res.status(403).json({ success: false, message: 'Su registro profesional (RETHUS/TP) ha vencido.' });
        }

        // 4. Generar Token
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
// API: CREAR PROFESIONAL (Solo Admin)
// ==========================================
app.post('/api/professionals', async (req, res) => {
    try {
        const { email, password, fullName, documentNumber, specialtyId, cardExpiry, signature } = req.body;

        // 1. Crear usuario en Auth
        const { data: authUser, error: authErr } = await supabase.auth.admin.createUser({
            email, password, email_confirm: true
        });
        if (authErr) throw authErr;

        // 2. Guardar perfil en tabla professionals
        const { error: dbErr } = await supabase.from('professionals').insert([{
            user_id: authUser.user.id,
            full_name: fullName,
            document_number: documentNumber,
            specialty_id: specialtyId,
            card_expiry_date: cardExpiry,
            signature_data: signature,
            is_active: true
        }]);

        if (dbErr) throw dbErr;
        res.json({ success: true, message: 'Profesional creado exitosamente' });

    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Error creando profesional' });
    }
});

// Servir Frontend (Catch-all)
app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Vital Hogar Pro Vivo en puerto ${PORT}`);
});

export default app;
