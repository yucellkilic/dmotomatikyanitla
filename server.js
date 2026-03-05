const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");
const { parseTurkishDate } = require("./dateParser");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");
dayjs.extend(utc);
dayjs.extend(timezone);

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
const SETTINGS_DEFAULTS = {
    working_start: "09:00", working_end: "18:00", slot_duration: 30,
    break_start: null, break_end: null, closed_days: [],
    min_notice_hours: 0, logo_url: null, theme_color: null, contact_whatsapp: null
};

async function getBusinessSettings(businessId) {
    const { data, error } = await supabase
        .from("business_settings")
        .select("*")
        .eq("business_id", businessId)
        .single();
    if (error || !data) return { ...SETTINGS_DEFAULTS };
    return { ...SETTINGS_DEFAULTS, ...data };
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

// ─── Public Booking: GET /book/:slug ────────────────────────────────
app.get("/book/:slug", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "book.html"));
});

// ─── Protected API: Update Business Settings ───────────────────
app.put("/api/business/:id/settings", async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            return res.status(401).json({ error: "Yetkilendirme gerekli." });
        }
        const token = authHeader.split(" ")[1];

        // Verify user via Supabase Auth
        const { createClient: createAnonClient } = require("@supabase/supabase-js");
        const anonSb = createAnonClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
            global: { headers: { Authorization: `Bearer ${token}` } }
        });
        const { data: { user }, error: authErr } = await anonSb.auth.getUser();
        if (authErr || !user) {
            return res.status(401).json({ error: "Geçersiz token." });
        }

        const businessId = req.params.id;

        // Check membership
        const { data: member } = await supabase
            .from("business_members")
            .select("role")
            .eq("business_id", businessId)
            .eq("user_id", user.id)
            .single();
        if (!member) {
            return res.status(403).json({ error: "Bu işletmede yetkiniz yok." });
        }

        const allowed = ["working_start", "working_end", "slot_duration", "break_start", "break_end",
            "closed_days", "min_notice_hours", "logo_url", "theme_color", "contact_whatsapp"];
        const updates = {};
        for (const key of allowed) {
            if (req.body[key] !== undefined) updates[key] = req.body[key];
        }

        if (Object.keys(updates).length === 0) {
            return res.status(400).json({ error: "Güncellenecek alan yok." });
        }

        // Upsert (insert if not exists, update if exists)
        const { data, error } = await supabase
            .from("business_settings")
            .upsert({ business_id: businessId, ...updates }, { onConflict: "business_id" })
            .select();

        if (error) {
            console.error("Settings update error:", error.message);
            return res.status(500).json({ error: error.message });
        }

        return res.json(data[0]);
    } catch (err) {
        console.error("Settings PUT error:", err.message);
        return res.status(500).json({ error: "Sunucu hatası." });
    }
});


// ─── Public API: Business Info ──────────────────────────────────────
app.get("/api/public/business/:slug", async (req, res) => {
    try {
        const { data: biz, error } = await supabase
            .from("businesses")
            .select("id, name, slug")
            .eq("slug", req.params.slug)
            .single();

        if (error || !biz) {
            return res.status(404).json({ error: "İşletme bulunamadı." });
        }

        const settings = await getBusinessSettings(biz.id);
        return res.json({ business: biz, settings });
    } catch (err) {
        console.error("Public business error:", err.message);
        return res.status(500).json({ error: "Sunucu hatası." });
    }
});

// ─── Public API: Availability ───────────────────────────────────────
app.get("/api/public/availability", async (req, res) => {
    try {
        const { slug, date } = req.query;
        if (!slug || !date) {
            return res.status(400).json({ error: "slug ve date parametreleri gerekli." });
        }

        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            return res.status(400).json({ error: "date formatı YYYY-MM-DD olmalı." });
        }

        const biz = await getBusinessBySlug(slug);
        if (!biz) return res.status(404).json({ error: "İşletme bulunamadı." });

        const settings = await getBusinessSettings(biz.id);
        const tz = "Europe/Istanbul";

        // Closed days check (0=Pazar, 6=Cumartesi)
        const requestedDay = dayjs.tz(date, "YYYY-MM-DD", tz).day();
        if (settings.closed_days && settings.closed_days.includes(requestedDay)) {
            return res.json({ date, timezone: tz, closed: true, slots: [] });
        }

        const startOfDay = dayjs.tz(`${date} ${settings.working_start}`, "YYYY-MM-DD HH:mm", tz);
        const endOfDay = dayjs.tz(`${date} ${settings.working_end}`, "YYYY-MM-DD HH:mm", tz);

        // Break time boundaries
        let breakStart = null, breakEnd = null;
        if (settings.break_start && settings.break_end) {
            breakStart = dayjs.tz(`${date} ${settings.break_start}`, "YYYY-MM-DD HH:mm", tz);
            breakEnd = dayjs.tz(`${date} ${settings.break_end}`, "YYYY-MM-DD HH:mm", tz);
        }

        // Min notice cutoff
        const now = dayjs().tz(tz);
        const noticeCutoff = (settings.min_notice_hours && settings.min_notice_hours > 0)
            ? now.add(settings.min_notice_hours, "hour")
            : null;

        // Generate slots
        const allSlots = [];
        let cursor = startOfDay;
        while (cursor.isBefore(endOfDay)) {
            const iso = cursor.format();
            let skip = false;
            // Skip break slots
            if (breakStart && breakEnd && !cursor.isBefore(breakStart) && cursor.isBefore(breakEnd)) {
                skip = true;
            }
            // Skip past notice cutoff
            if (noticeCutoff && cursor.isBefore(noticeCutoff)) {
                skip = true;
            }
            if (!skip) allSlots.push(iso);
            cursor = cursor.add(settings.slot_duration, "minute");
        }

        // Fetch taken appointments
        const { data: taken } = await supabase
            .from("appointments")
            .select("appointment_date")
            .eq("business_id", biz.id)
            .gte("appointment_date", startOfDay.toISOString())
            .lt("appointment_date", endOfDay.toISOString());

        const takenSet = new Set((taken || []).map(a => a.appointment_date));

        const slots = allSlots.map(iso => ({
            startISO: iso,
            label: dayjs(iso).tz(tz).format("HH:mm"),
            available: !takenSet.has(iso),
        }));

        return res.json({ date, timezone: tz, closed: false, slots });
    } catch (err) {
        console.error("Availability error:", err.message);
        return res.status(500).json({ error: "Sunucu hatası." });
    }
});

// ─── Public API: Create Appointment ─────────────────────────────────
app.post("/api/public/appointments", async (req, res) => {
    try {
        const { slug, name, phone, service, appointment_date } = req.body;

        if (!slug || !name || !phone || !appointment_date) {
            return res.status(400).json({ error: "MISSING_FIELDS", message: "slug, name, phone, appointment_date zorunlu." });
        }

        const biz = await getBusinessBySlug(slug);
        if (!biz) return res.status(404).json({ error: "BUSINESS_NOT_FOUND" });

        const settings = await getBusinessSettings(biz.id);

        // Validate working hours
        const tz = "Europe/Istanbul";
        const appt = dayjs(appointment_date).tz(tz);
        const apptMins = appt.hour() * 60 + appt.minute();
        const [sH, sM] = settings.working_start.split(":").map(Number);
        const [eH, eM] = settings.working_end.split(":").map(Number);

        if (apptMins < sH * 60 + sM || apptMins >= eH * 60 + eM) {
            return res.status(400).json({ error: "OUT_OF_HOURS", message: `Mesai saatleri: ${settings.working_start} - ${settings.working_end}` });
        }

        // Validate slot alignment
        if (appt.minute() % settings.slot_duration !== 0) {
            return res.status(400).json({ error: "INVALID_SLOT", message: `${settings.slot_duration} dakikalık slotlara uygun değil.` });
        }

        // Conflict check
        const { data: conflict } = await supabase
            .from("appointments")
            .select("id")
            .eq("business_id", biz.id)
            .eq("appointment_date", appointment_date)
            .limit(1);

        if (conflict && conflict.length > 0) {
            return res.status(409).json({ error: "SLOT_TAKEN", message: "Bu saat dolu." });
        }

        // Insert
        const { data, error } = await supabase
            .from("appointments")
            .insert([{ name, phone, service: service || null, appointment_date, business_id: biz.id }])
            .select("id, appointment_date");

        if (error) {
            if (error.message.includes("unique") || error.message.includes("duplicate")) {
                return res.status(409).json({ error: "SLOT_TAKEN", message: "Bu saat dolu." });
            }
            console.error("Insert error:", error.message);
            return res.status(500).json({ error: "INSERT_ERROR", message: error.message });
        }

        return res.status(201).json(data[0]);
    } catch (err) {
        console.error("Public appointment error:", err.message);
        return res.status(500).json({ error: "SERVER_ERROR" });
    }
});


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
