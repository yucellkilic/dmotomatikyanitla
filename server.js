const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");
const { parseTurkishDate } = require("./dateParser");

// .env dosyasını yükle
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Supabase Client ────────────────────────────────────────────────
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Public klasörünü static olarak serve et
app.use(express.static(path.join(__dirname, "public")));

// ─── In-Memory State ────────────────────────────────────────────────
const sessions = new Map();

function getSession(userId) {
    if (!sessions.has(userId)) {
        sessions.set(userId, {
            step: "idle",
            name: null,
            phone: null,
            service: null,
            date: null,
        });
    }
    return sessions.get(userId);
}

function resetSession(session) {
    session.step = "idle";
    session.name = null;
    session.phone = null;
    session.service = null;
    session.date = null;
}

// ─── Supabase: Business Lookup ──────────────────────────────────────
async function getBusinessBySlug(slug) {
    const { data, error } = await supabase
        .from("businesses")
        .select("id")
        .eq("slug", slug)
        .single();

    if (error || !data) return null;
    return data;
}

// ─── Supabase: Business Settings ────────────────────────────────
async function getBusinessSettings(businessId) {
    const { data, error } = await supabase
        .from("business_settings")
        .select("working_start, working_end, slot_duration")
        .eq("business_id", businessId)
        .single();
    if (error || !data) return { working_start: "09:00", working_end: "18:00", slot_duration: 30 };
    return data;
}

// ─── Supabase: Randevu Kaydet ───────────────────────────────────────
async function saveAppointment({ name, phone, service, appointment_date, business_id }) {
    try {
        const { data, error } = await supabase
            .from("appointments")
            .insert([{ name, phone, service, appointment_date, business_id }])
            .select();

        if (error) {
            console.error("❌ Supabase insert hatası:", error.message);
            return { success: false, error: error.message };
        }

        console.log("✅ Randevu kaydedildi:", data);
        return { success: true, data };
    } catch (err) {
        console.error("❌ Beklenmeyen hata:", err.message);
        return { success: false, error: err.message };
    }
}

// ─── Endpoints ──────────────────────────────────────────────────────

// Admin panel config (anon key only — service role NEVER exposed)
app.get("/api/config", (req, res) => {
    res.json({
        supabaseUrl: process.env.SUPABASE_URL,
        supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
    });
});

// Admin panel sayfası
app.get("/admin", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "admin.html"));
});

// Ana endpoint
app.get("/", (req, res) => {
    res.json({
        success: true,
        message: "DM Otomasyon API çalışıyor!",
        timestamp: new Date().toISOString(),
    });
});

// ─── Chat handler (state machine) ───────────────────────────────────
async function handleChat({ userId, message, businessId, res }) {
    if (!message) {
        return res.status(400).json({ error: "message alanı gerekli." });
    }

    const session = getSession(userId);
    const msg = message.toLowerCase();
    let reply = "";

    switch (session.step) {
        case "ask_region":
            session.service = message;
            reply = `${session.service} bölgesi için fiyat bilgisi not edildi. Randevu oluşturmak ister misiniz? (evet / hayır)`;
            session.step = "confirm_appointment";
            break;

        case "confirm_appointment":
            if (msg.includes("evet")) {
                reply = "Harika! Lütfen ad soyadınızı yazın.";
                session.step = "ask_name";
            } else {
                reply = "Anlıyorum, başka bir sorunuz olursa yazabilirsiniz!";
                resetSession(session);
            }
            break;

        case "ask_name":
            session.name = message;
            reply = `Teşekkürler ${session.name}! Telefon numaranızı alabilir miyim?`;
            session.step = "ask_phone";
            break;

        case "ask_phone":
            session.phone = message;
            reply = "Hangi tarih ve saat uygun olur? (Örn: 28.02.2026 14:00)";
            session.step = "ask_date";
            break;

        case "ask_date":
            if (!session.service) {
                reply = "Hizmet bilgisi eksik. Lütfen hangi hizmeti istediğinizi belirtin.";
                session.step = "ask_region";
                return res.json({ reply });
            }

            // Türkçe doğal dili ISO timestamp'e çevir
            const parsed = parseTurkishDate(message);
            if (parsed.error) {
                reply = parsed.error;
                // Adımı değiştirme, tekrar tarih sor
                return res.json({ reply, session: { ...session } });
            }

            session.date = parsed.readable;

            // Mesai saatleri ve slot kontrolü
            const settings = await getBusinessSettings(businessId);
            const apptDate = new Date(parsed.iso);
            const apptMinutes = apptDate.getHours() * 60 + apptDate.getMinutes();
            const [sH, sM] = settings.working_start.split(":").map(Number);
            const [eH, eM] = settings.working_end.split(":").map(Number);
            const startMin = sH * 60 + sM;
            const endMin = eH * 60 + eM;

            if (apptMinutes < startMin || apptMinutes >= endMin) {
                reply = `Mesai saatleri dışında randevu veremiyoruz. Çalışma saatlerimiz ${settings.working_start} - ${settings.working_end} arasıdır.`;
                return res.json({ reply, session: { ...session } });
            }

            if (apptDate.getMinutes() % settings.slot_duration !== 0) {
                reply = `Lütfen ${settings.slot_duration} dakikalık slotlara uygun saat seçin. (Örn: ${settings.working_start}, ${sH}:${String(sM + settings.slot_duration).padStart(2, "0")})`;
                return res.json({ reply, session: { ...session } });
            }

            const result = await saveAppointment({
                name: session.name,
                phone: session.phone,
                service: session.service,
                appointment_date: parsed.iso,
                business_id: businessId,
            });

            if (result.success) {
                reply =
                    `Randevunuz oluşturuldu ve kaydedildi! 🎉\n\n` +
                    `👤 İsim: ${session.name}\n` +
                    `📞 Telefon: ${session.phone}\n` +
                    `💇 Hizmet: ${session.service || "Belirtilmedi"}\n` +
                    `📅 Tarih: ${parsed.readable}\n\n` +
                    `Teşekkür ederiz, görüşmek üzere!`;
            } else {
                reply =
                    `Randevu bilgileriniz alındı ancak kayıt sırasında bir hata oluştu.\n` +
                    `Lütfen tekrar deneyin veya bizi arayın.`;
            }

            resetSession(session);
            break;

        default:
            if (msg.includes("fiyat")) {
                reply =
                    "Lazer epilasyon fiyatlarımız bölgeye göre değişmektedir. Hangi bölgeye yaptırmak istiyorsunuz?";
                session.step = "ask_region";
            } else if (msg.includes("randevu")) {
                reply = "Hangi hizmet için randevu oluşturmak istiyorsunuz?";
                session.step = "ask_region";
            } else {
                reply = "Size nasıl yardımcı olabilirim?";
            }
            break;
    }

    return res.json({ reply, session: { ...session } });
}

// POST /api/:slug/message — slug ile business lookup
app.post("/api/:slug/message", async (req, res) => {
    const { slug } = req.params;
    const { userId = "default", message } = req.body;

    const business = await getBusinessBySlug(slug);
    if (!business) {
        return res.status(404).json({ error: `Business bulunamadı: ${slug}` });
    }

    return handleChat({ userId, message, businessId: business.id, res });
});

// POST /chat — geriye uyumluluk (default business)
app.post("/chat", async (req, res) => {
    const { userId = "default", message } = req.body;

    const business = await getBusinessBySlug("default");
    if (!business) {
        return res.status(500).json({ error: "Default business bulunamadı. Lütfen businesses tablosunu kontrol edin." });
    }

    return handleChat({ userId, message, businessId: business.id, res });
});

// Sunucuyu başlat (Render/Heroku uyumlu)
app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on ${PORT}`);
});
