const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

// Mapa de clientes ativos: clientId => { client, qr, status }
const clients = {};

const LOCK_FILES = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];

function removeLockFiles(clientId) {
    // whatsapp-web.js salva em .wwebjs_auth/session-<clientId>/Default/
    const sessionDir = path.join('./session', '.wwebjs_auth', `session-${clientId}`, 'Default');
    LOCK_FILES.forEach(file => {
        const filePath = path.join(sessionDir, file);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            console.log(`🧹 [${clientId}] Removido lock: ${file}`);
        }
    });
}

function removeAllLockFiles() {
    const authDir = path.join('./session', '.wwebjs_auth');
    if (!fs.existsSync(authDir)) {
        return;
    }
    const entries = fs.readdirSync(authDir);
    entries.forEach(entry => {
        if (!entry.startsWith('session-')) {
            return;
        }
        const defaultDir = path.join(authDir, entry, 'Default');
        LOCK_FILES.forEach(file => {
            const filePath = path.join(defaultDir, file);
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                console.log(`🧹 [startup] Removido lock: ${entry}/${file}`);
            }
        });
    });
}

// Limpa locks de crashes anteriores ao iniciar
removeAllLockFiles();

function getOrCreateClient(clientId) {
    if (clients[clientId]) {
        return clients[clientId];
    }

    removeLockFiles(clientId);

    const client = new Client({
        authStrategy: new LocalAuth({
            clientId,
            dataPath: './session'
        }),
        puppeteer: {
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        }
    });

    const state = { client, qr: null, status: 'initializing' };
    clients[clientId] = state;

    client.on('qr', qr => {
        console.log(`📲 [${clientId}] Novo QR gerado`);
        state.qr = qr;
        state.status = 'pending';
    });

    client.on('ready', () => {
        console.log(`✅ [${clientId}] WhatsApp conectado!`);
        state.qr = null;
        state.status = 'connected';
    });

    client.on('disconnected', reason => {
        console.log(`❌ [${clientId}] Desconectado:`, reason);
        state.qr = null;
        state.status = 'disconnected';
    });

    client.on('auth_failure', msg => {
        console.error(`❌ [${clientId}] Falha na autenticação:`, msg);
        state.status = 'auth_failure';
    });

    client.initialize();

    return state;
}

// =============================
// 📡 ENDPOINTS
// =============================

// 📤 Enviar mensagem
app.post('/send', async (req, res) => {
    try {
        const { clientId, phone, message } = req.body;

        if (!clientId || !phone || !message) {
            return res.status(400).json({ status: 'error', message: 'clientId, phone e message são obrigatórios' });
        }

        const state = clients[clientId];

        if (!state || state.status !== 'connected') {
            return res.status(503).json({ status: 'error', message: 'WhatsApp não conectado para este cliente' });
        }

        const chatId = phone.replace(/\D/g, '') + '@c.us';
        const result = await state.client.sendMessage(chatId, message);

        return res.json({ status: 'ok', messageId: result.id._serialized });

    } catch (error) {
        console.error('❌ Erro ao enviar mensagem:', error);
        return res.status(500).json({ status: 'error', message: error.message });
    }
});

// 📲 Obter QR code (cria sessão se não existir)
app.get('/qr', (req, res) => {
    const clientId = req.query.clientId;

    if (!clientId) {
        return res.status(400).json({ status: 'error', message: 'clientId é obrigatório' });
    }

    const state = getOrCreateClient(clientId);

    return res.json({ status: state.status, qr: state.qr });
});

// 📊 Status da conexão
app.get('/status', (req, res) => {
    const clientId = req.query.clientId;

    if (!clientId) {
        return res.status(400).json({ status: 'error', message: 'clientId é obrigatório' });
    }

    const state = clients[clientId];

    return res.json({ status: state ? state.status : 'disconnected' });
});

// 🔌 Desconectar
app.post('/disconnect', async (req, res) => {
    const clientId = req.body.clientId;

    if (!clientId) {
        return res.status(400).json({ status: 'error', message: 'clientId é obrigatório' });
    }

    const state = clients[clientId];

    if (!state) {
        return res.json({ status: 'disconnected' });
    }

    try {
        await state.client.logout();
    } catch (_) {
        // ignora erros ao deslogar
    }

    delete clients[clientId];

    return res.json({ status: 'disconnected' });
});

// ❤️ Health check
app.get('/', (_req, res) => {
    res.send('🚀 WhatsApp API rodando');
});

// 🚀 Start server
const PORT = 3300;

app.listen(PORT, () => {
    console.log(`🚀 WhatsApp API rodando na porta ${PORT}`);
});
